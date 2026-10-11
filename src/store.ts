// Queue domain: items, audit entries, and the ports every backend fills.
//
// Filing stays open: any tool can file an item for review. Decisions
// need a reviewer: edit, approve, and reject pass the gate first.

export type ItemStatus = "pending" | "approved" | "rejected";

export type Decision = "approved" | "rejected";

export type AuditAction = "submit" | "edit" | "approve" | "reject";

export interface QueueItem {
  id: string;
  source: string;
  kind: string;
  title: string;
  bodyKey: string;
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
}

export interface AuditEntry {
  id: string;
  itemId: string;
  action: AuditAction;
  actor: string;
  at: string;
  note?: string;
}

export class ApproveError extends Error {
  readonly code = "APPROVE_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "ApproveError";
  }
}

export interface StoredItem {
  id: string;
  source: string;
  kind: string;
  title: string;
  bodyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface QueueStore {
  readonly name: string;
  submit(item: StoredItem): Promise<QueueItem>;
  list(status?: ItemStatus): Promise<QueueItem[]>;
  get(id: string): Promise<QueueItem>;
  edit(id: string, patch: { title?: string; bodyKey?: string }): Promise<QueueItem>;
  decide(id: string, decision: Decision, actor: string, reason?: string): Promise<QueueItem>;
  appendAudit(entry: AuditEntry): Promise<void>;
  audit(itemId?: string): Promise<AuditEntry[]>;
}

export interface BlobStore {
  readonly name: string;
  put(key: string, text: string): Promise<void>;
  get(key: string): Promise<string>;
}

export interface ReviewerGate {
  readonly name: string;
  check(actor: string, token?: string): Promise<void>;
}

function cloneItem(item: QueueItem): QueueItem {
  return { ...item };
}

function cloneEntry(entry: AuditEntry): AuditEntry {
  return { ...entry };
}

export function pendingOnly(item: QueueItem, verb: string): void {
  if (item.status !== "pending") {
    throw new ApproveError(`cannot ${verb} item "${item.id}": it is already ${item.status}`);
  }
}

export class MemoryQueueStore implements QueueStore {
  readonly name = "memory";
  private readonly items = new Map<string, QueueItem>();
  private readonly entries: AuditEntry[] = [];

  async submit(item: StoredItem): Promise<QueueItem> {
    if (this.items.has(item.id)) {
      throw new ApproveError(`item "${item.id}" already exists`);
    }
    const stored: QueueItem = { ...item, status: "pending" };
    this.items.set(item.id, stored);
    return cloneItem(stored);
  }

  async list(status?: ItemStatus): Promise<QueueItem[]> {
    const all = [...this.items.values()].map(cloneItem);
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (status === undefined) return all;
    return all.filter((item) => item.status === status);
  }

  async get(id: string): Promise<QueueItem> {
    const item = this.items.get(id);
    if (item === undefined) {
      throw new ApproveError(`no item with id "${id}"`);
    }
    return cloneItem(item);
  }

  async edit(id: string, patch: { title?: string; bodyKey?: string }): Promise<QueueItem> {
    const item = this.items.get(id);
    if (item === undefined) {
      throw new ApproveError(`no item with id "${id}"`);
    }
    pendingOnly(item, "edit");
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.bodyKey !== undefined) item.bodyKey = patch.bodyKey;
    item.updatedAt = new Date().toISOString();
    return cloneItem(item);
  }

  async decide(id: string, decision: Decision, actor: string, reason?: string): Promise<QueueItem> {
    const item = this.items.get(id);
    if (item === undefined) {
      throw new ApproveError(`no item with id "${id}"`);
    }
    pendingOnly(item, decision === "approved" ? "approve" : "reject");
    item.status = decision;
    item.decidedBy = actor;
    item.decidedAt = new Date().toISOString();
    if (reason !== undefined) item.reason = reason;
    item.updatedAt = item.decidedAt;
    return cloneItem(item);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.entries.push(cloneEntry(entry));
  }

  async audit(itemId?: string): Promise<AuditEntry[]> {
    const all = this.entries.map(cloneEntry);
    all.sort((a, b) => a.at.localeCompare(b.at));
    if (itemId === undefined) return all;
    return all.filter((entry) => entry.itemId === itemId);
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly name = "memory";
  private readonly blobs = new Map<string, string>();

  async put(key: string, text: string): Promise<void> {
    this.blobs.set(key, text);
  }

  async get(key: string): Promise<string> {
    const text = this.blobs.get(key);
    if (text === undefined) {
      throw new ApproveError(`no blob at key "${key}"`);
    }
    return text;
  }
}

export class OpenGate implements ReviewerGate {
  readonly name = "open";

  async check(actor: string): Promise<void> {
    if (actor.trim().length === 0) {
      throw new ApproveError("a decision needs an actor name");
    }
  }
}
