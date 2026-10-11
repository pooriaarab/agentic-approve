// Queue service: the rules that sit above any store, blob, or gate.
//
// Submit files an item. Edit changes a pending item. Approve and
// reject decide one. Every mutation writes an audit entry. Dry run
// walks the same path but writes nothing.

import { randomUUID } from "node:crypto";
import {
  createLogger,
  recordCost,
  type Guards,
  type Logger,
} from "agentic-core";
import {
  ApproveError,
  type AuditAction,
  type AuditEntry,
  type BlobStore,
  type Decision,
  type ItemStatus,
  type QueueItem,
  type QueueStore,
  type ReviewerGate,
} from "./store.js";

export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 1_000_000;

export interface ServiceDeps {
  store: QueueStore;
  blobs: BlobStore;
  gate: ReviewerGate;
  guards?: Guards;
  logger?: Logger;
  now?: () => Date;
  newId?: () => string;
}

export interface SubmitInput {
  source: string;
  kind: string;
  title: string;
  body: string;
}

export interface MutateOptions {
  dryRun?: boolean;
}

export interface DecisionOptions extends MutateOptions {
  reason?: string;
}

export interface EditPatch {
  title?: string;
  body?: string;
}

export interface ItemResult {
  dryRun: boolean;
  item: QueueItem;
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function checkSubmit(input: SubmitInput): void {
  if (blank(input.source)) throw new ApproveError("submit needs a source");
  if (blank(input.kind)) throw new ApproveError("submit needs a kind");
  if (blank(input.title)) throw new ApproveError("submit needs a title");
  if (blank(input.body)) throw new ApproveError("submit needs a body");
  if (input.title.length > MAX_TITLE_CHARS) {
    throw new ApproveError(`title holds ${input.title.length} chars, max is ${MAX_TITLE_CHARS}`);
  }
  if (input.body.length > MAX_BODY_CHARS) {
    throw new ApproveError(`body holds ${input.body.length} chars, max is ${MAX_BODY_CHARS}`);
  }
}

export class QueueService {
  private readonly store: QueueStore;
  private readonly blobs: BlobStore;
  private readonly gate: ReviewerGate;
  private readonly guards?: Guards;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.blobs = deps.blobs;
    this.gate = deps.gate;
    this.guards = deps.guards;
    this.logger = deps.logger ?? createLogger({ quiet: true });
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  backendNames(): { store: string; blobs: string; gate: string } {
    return { store: this.store.name, blobs: this.blobs.name, gate: this.gate.name };
  }

  async submit(input: SubmitInput, options: MutateOptions = {}): Promise<ItemResult> {
    checkSubmit(input);
    this.guards?.checkDispatch(`${input.title}\n${input.body}`);
    const at = this.now().toISOString();
    const id = this.newId();
    const item: QueueItem = {
      id,
      source: input.source,
      kind: input.kind,
      title: input.title,
      bodyKey: `bodies/${id}.txt`,
      status: "pending",
      createdAt: at,
      updatedAt: at,
    };
    if (options.dryRun === true) {
      this.logger.info(`dry run: would file "${input.title}" from ${input.source}`);
      return { dryRun: true, item };
    }
    await this.blobs.put(item.bodyKey, input.body);
    const stored = await this.store.submit(item);
    await this.store.appendAudit({
      id: this.newId(),
      itemId: stored.id,
      action: "submit",
      actor: input.source,
      at,
    });
    this.guards?.recordDispatch();
    recordCost({ kind: "review", adapter: this.store.name, units: input.body.length });
    this.logger.info(`filed item ${stored.id} from ${input.source}`);
    return { dryRun: false, item: stored };
  }

  async list(status?: ItemStatus): Promise<QueueItem[]> {
    return this.store.list(status);
  }

  async show(id: string): Promise<{ item: QueueItem; body: string }> {
    const item = await this.store.get(id);
    const body = await this.blobs.get(item.bodyKey);
    return { item, body };
  }

  async edit(
    id: string,
    patch: EditPatch,
    actor: string,
    options: MutateOptions & { token?: string; note?: string } = {},
  ): Promise<ItemResult> {
    if (patch.title === undefined && patch.body === undefined) {
      throw new ApproveError("edit needs a new title or a new body");
    }
    if (patch.title !== undefined && blank(patch.title)) {
      throw new ApproveError("edit needs a non-blank title");
    }
    if (patch.title !== undefined && patch.title.length > MAX_TITLE_CHARS) {
      throw new ApproveError(`title holds ${patch.title.length} chars, max is ${MAX_TITLE_CHARS}`);
    }
    if (patch.body !== undefined && blank(patch.body)) {
      throw new ApproveError("edit needs a non-blank body");
    }
    if (patch.body !== undefined && patch.body.length > MAX_BODY_CHARS) {
      throw new ApproveError(`body holds ${patch.body.length} chars, max is ${MAX_BODY_CHARS}`);
    }
    await this.gate.check(actor, options.token);
    const current = await this.store.get(id);
    const at = this.now().toISOString();
    const next: QueueItem = {
      ...current,
      title: patch.title ?? current.title,
      updatedAt: at,
    };
    if (options.dryRun === true) {
      this.logger.info(`dry run: would edit item ${id}`);
      return { dryRun: true, item: next };
    }
    if (patch.body !== undefined) {
      await this.blobs.put(current.bodyKey, patch.body);
    }
    const stored = await this.store.edit(id, { title: patch.title });
    await this.writeAudit(stored.id, "edit", actor, at, options.note);
    recordCost({ kind: "review", adapter: this.store.name, units: patch.body?.length ?? 0 });
    this.logger.info(`edited item ${id}`);
    return { dryRun: false, item: stored };
  }

  async decide(
    id: string,
    decision: Decision,
    actor: string,
    options: DecisionOptions & { token?: string } = {},
  ): Promise<ItemResult> {
    await this.gate.check(actor, options.token);
    const current = await this.store.get(id);
    const at = this.now().toISOString();
    const next: QueueItem = {
      ...current,
      status: decision,
      decidedBy: actor,
      decidedAt: at,
      updatedAt: at,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    };
    if (options.dryRun === true) {
      this.logger.info(`dry run: would ${decision === "approved" ? "approve" : "reject"} item ${id}`);
      return { dryRun: true, item: next };
    }
    const stored = await this.store.decide(id, decision, actor, options.reason);
    await this.writeAudit(stored.id, decision === "approved" ? "approve" : "reject", actor, at, options.reason);
    recordCost({ kind: "decision", adapter: this.store.name, units: 1 });
    this.logger.info(`${decision} item ${id}`);
    return { dryRun: false, item: stored };
  }

  async audit(itemId?: string): Promise<AuditEntry[]> {
    return this.store.audit(itemId);
  }

  private async writeAudit(
    itemId: string,
    action: AuditAction,
    actor: string,
    at: string,
    note?: string,
  ): Promise<void> {
    await this.store.appendAudit({
      id: this.newId(),
      itemId,
      action,
      actor,
      at,
      ...(note === undefined ? {} : { note }),
    });
  }
}
