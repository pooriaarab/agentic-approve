// D1 backend: the same queue in Cloudflare D1 over the REST API.
//
// Docs: https://developers.cloudflare.com/d1/ — D1 serves SQLite
// semantics over HTTP, so this adapter posts SQL with bound params.
// Every failure throws VendorError. Nothing returns success on a
// failed call.

import { VendorError } from "agentic-core";
import {
  ApproveError,
  type AuditEntry,
  type Decision,
  type ItemStatus,
  type QueueItem,
  type QueueStore,
  type StoredItem,
} from "./store.js";

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS approve_items (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body_key TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS approve_audit (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    at TEXT NOT NULL,
    note TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_approve_audit_item ON approve_audit (item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approve_items_status ON approve_items (status)`,
];

export interface D1Config {
  accountId: string;
  databaseId: string;
  apiToken: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface D1QueryResult {
  results?: Record<string, unknown>[];
  success?: boolean;
}

interface D1Response {
  success: boolean;
  result?: D1QueryResult[];
  errors?: { message?: string }[];
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new VendorError("D1 returned a row with a bad shape");
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return asString(value);
}

function rowToItem(row: Record<string, unknown>): QueueItem {
  const status = asString(row.status);
  if (status !== "pending" && status !== "approved" && status !== "rejected") {
    throw new VendorError(`D1 returned a bad status "${status}"`);
  }
  return {
    id: asString(row.id),
    source: asString(row.source),
    kind: asString(row.kind),
    title: asString(row.title),
    bodyKey: asString(row.body_key),
    status,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    decidedBy: asOptionalString(row.decided_by),
    decidedAt: asOptionalString(row.decided_at),
    reason: asOptionalString(row.reason),
  };
}

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  const action = asString(row.action);
  if (action !== "submit" && action !== "edit" && action !== "approve" && action !== "reject") {
    throw new VendorError(`D1 returned a bad audit action "${action}"`);
  }
  return {
    id: asString(row.id),
    itemId: asString(row.item_id),
    action,
    actor: asString(row.actor),
    at: asString(row.at),
    note: asOptionalString(row.note),
  };
}

export class D1QueueStore implements QueueStore {
  readonly name = "d1";
  private readonly endpoint: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private schemaReady: Promise<void> | null = null;

  constructor(config: D1Config) {
    if (config.accountId.trim().length === 0) throw new Error("D1 needs an account id");
    if (config.databaseId.trim().length === 0) throw new Error("D1 needs a database id");
    if (config.apiToken.trim().length === 0) throw new Error("D1 needs an API token");
    this.endpoint =
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}` +
      `/d1/database/${config.databaseId}/query`;
    this.apiToken = config.apiToken;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new VendorError(`D1 request failed: ${String(error)}`, { cause: error });
    }
    if (!response.ok) {
      throw new VendorError(`D1 got status ${response.status}`, { status: response.status });
    }
    const payload = (await response.json()) as D1Response;
    if (payload.success !== true) {
      const detail = payload.errors?.map((entry) => entry.message).join("; ") ?? "unknown error";
      throw new VendorError(`D1 query failed: ${detail}`);
    }
    return payload.result?.[0]?.results ?? [];
  }

  private ensureSchema(): Promise<void> {
    if (this.schemaReady === null) {
      this.schemaReady = (async () => {
        for (const sql of SCHEMA) {
          await this.query(sql);
        }
      })();
    }
    return this.schemaReady;
  }

  async submit(item: StoredItem): Promise<QueueItem> {
    await this.ensureSchema();
    try {
      await this.query(
        `INSERT INTO approve_items
          (id, source, kind, title, body_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [item.id, item.source, item.kind, item.title, item.bodyKey, item.createdAt, item.updatedAt],
      );
    } catch (error) {
      if (error instanceof VendorError && /UNIQUE|PRIMARY/i.test(error.message)) {
        throw new ApproveError(`item "${item.id}" already exists`);
      }
      throw error;
    }
    return this.get(item.id);
  }

  async list(status?: ItemStatus): Promise<QueueItem[]> {
    await this.ensureSchema();
    const rows =
      status === undefined
        ? await this.query(`SELECT * FROM approve_items ORDER BY created_at ASC`)
        : await this.query(`SELECT * FROM approve_items WHERE status = ? ORDER BY created_at ASC`, [
            status,
          ]);
    return rows.map(rowToItem);
  }

  async get(id: string): Promise<QueueItem> {
    await this.ensureSchema();
    const rows = await this.query(`SELECT * FROM approve_items WHERE id = ?`, [id]);
    const row = rows[0];
    if (row === undefined) {
      throw new ApproveError(`no item with id "${id}"`);
    }
    return rowToItem(row);
  }

  async edit(id: string, patch: { title?: string; bodyKey?: string }): Promise<QueueItem> {
    const current = await this.get(id);
    if (current.status !== "pending") {
      throw new ApproveError(`cannot edit item "${id}": it is already ${current.status}`);
    }
    const updatedAt = new Date().toISOString();
    await this.query(
      `UPDATE approve_items SET title = ?, body_key = ?, updated_at = ? WHERE id = ?`,
      [patch.title ?? current.title, patch.bodyKey ?? current.bodyKey, updatedAt, id],
    );
    return this.get(id);
  }

  async decide(id: string, decision: Decision, actor: string, reason?: string): Promise<QueueItem> {
    const current = await this.get(id);
    if (current.status !== "pending") {
      const verb = decision === "approved" ? "approve" : "reject";
      throw new ApproveError(`cannot ${verb} item "${id}": it is already ${current.status}`);
    }
    const decidedAt = new Date().toISOString();
    await this.query(
      `UPDATE approve_items
         SET status = ?, decided_by = ?, decided_at = ?, reason = ?, updated_at = ?
       WHERE id = ?`,
      [decision, actor, decidedAt, reason ?? current.reason ?? null, decidedAt, id],
    );
    return this.get(id);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.ensureSchema();
    await this.query(
      `INSERT INTO approve_audit (id, item_id, action, actor, at, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.itemId, entry.action, entry.actor, entry.at, entry.note ?? null],
    );
  }

  async audit(itemId?: string): Promise<AuditEntry[]> {
    await this.ensureSchema();
    const rows =
      itemId === undefined
        ? await this.query(`SELECT * FROM approve_audit ORDER BY at ASC`)
        : await this.query(`SELECT * FROM approve_audit WHERE item_id = ? ORDER BY at ASC`, [itemId]);
    return rows.map(rowToEntry);
  }
}
