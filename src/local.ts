// File backends: the queue lives in one JSON file, bodies in one dir.
//
// This is the default backend. It needs no keys and no network, so a
// fresh install works offline. Set the vendor env vars to move the
// same queue to D1 and R2 without changing any call.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ApproveError,
  pendingOnly,
  type AuditEntry,
  type BlobStore,
  type Decision,
  type ItemStatus,
  type QueueItem,
  type QueueStore,
  type StoredItem,
} from "./store.js";

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.APPROVE_DATA_DIR;
  if (dir !== undefined && dir.trim().length > 0) return dir;
  return join(process.cwd(), ".approve-data");
}

interface QueueFile {
  items: QueueItem[];
  audit: AuditEntry[];
}

function emptyFile(): QueueFile {
  return { items: [], audit: [] };
}

export class FileQueueStore implements QueueStore {
  readonly name = "file";
  private readonly filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "queue.json");
  }

  private read(): QueueFile {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return emptyFile();
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<QueueFile>;
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    };
  }

  private write(file: QueueFile): void {
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(file), "utf8");
    renameSync(tmpPath, this.filePath);
  }

  private find(file: QueueFile, id: string): QueueItem {
    const item = file.items.find((candidate) => candidate.id === id);
    if (item === undefined) {
      throw new ApproveError(`no item with id "${id}"`);
    }
    return item;
  }

  async submit(item: StoredItem): Promise<QueueItem> {
    const file = this.read();
    if (file.items.some((candidate) => candidate.id === item.id)) {
      throw new ApproveError(`item "${item.id}" already exists`);
    }
    const stored: QueueItem = { ...item, status: "pending" };
    file.items.push(stored);
    this.write(file);
    return { ...stored };
  }

  async list(status?: ItemStatus): Promise<QueueItem[]> {
    const items = this.read().items.map((item) => ({ ...item }));
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (status === undefined) return items;
    return items.filter((item) => item.status === status);
  }

  async get(id: string): Promise<QueueItem> {
    return { ...this.find(this.read(), id) };
  }

  async edit(id: string, patch: { title?: string; bodyKey?: string }): Promise<QueueItem> {
    const file = this.read();
    const item = this.find(file, id);
    pendingOnly(item, "edit");
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.bodyKey !== undefined) item.bodyKey = patch.bodyKey;
    item.updatedAt = new Date().toISOString();
    this.write(file);
    return { ...item };
  }

  async decide(id: string, decision: Decision, actor: string, reason?: string): Promise<QueueItem> {
    const file = this.read();
    const item = this.find(file, id);
    pendingOnly(item, decision === "approved" ? "approve" : "reject");
    item.status = decision;
    item.decidedBy = actor;
    item.decidedAt = new Date().toISOString();
    if (reason !== undefined) item.reason = reason;
    item.updatedAt = item.decidedAt;
    this.write(file);
    return { ...item };
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    const file = this.read();
    file.audit.push({ ...entry });
    this.write(file);
  }

  async audit(itemId?: string): Promise<AuditEntry[]> {
    const entries = this.read().audit.map((entry) => ({ ...entry }));
    entries.sort((a, b) => a.at.localeCompare(b.at));
    if (itemId === undefined) return entries;
    return entries.filter((entry) => entry.itemId === itemId);
  }
}

export class FileBlobStore implements BlobStore {
  readonly name = "file";
  private readonly bodiesDir: string;

  constructor(dataDir: string) {
    this.bodiesDir = join(dataDir, "bodies");
    mkdirSync(this.bodiesDir, { recursive: true });
  }

  private pathFor(key: string): string {
    if (key.includes("..")) {
      throw new ApproveError(`bad blob key "${key}"`);
    }
    const full = join(this.bodiesDir, key);
    mkdirSync(dirname(full), { recursive: true });
    return full;
  }

  async put(key: string, text: string): Promise<void> {
    writeFileSync(this.pathFor(key), text, "utf8");
  }

  async get(key: string): Promise<string> {
    try {
      return readFileSync(this.pathFor(key), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new ApproveError(`no blob at key "${key}"`);
      }
      throw error;
    }
  }
}
