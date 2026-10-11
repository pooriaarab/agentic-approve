import { describe, expect, test } from "vitest";
import { VendorError } from "agentic-core";
import { D1QueueStore } from "./d1.js";
import { ApproveError } from "./store.js";

// A tiny fake of the D1 REST API: it answers schema calls with empty
// results and keeps rows in memory for the pack's own SQL.
function fakeD1(onRequest?: (sql: string, params: unknown[]) => void): {
  fetchFn: typeof fetch;
  rows: () => Record<string, unknown>[];
} {
  const items: Record<string, unknown>[] = [];
  const audit: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
    const payload = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] };
    onRequest?.(payload.sql, payload.params);
    const answer = (results: Record<string, unknown>[]): Response =>
      Response.json({ success: true, result: [{ results, success: true, meta: {} }], errors: [] });
    const sql = payload.sql;
    if (sql.startsWith("CREATE") || sql.startsWith("INSERT INTO approve_audit")) {
      if (sql.startsWith("INSERT")) {
        const [id, item_id, action, actor, at, note] = payload.params as unknown[];
        audit.push({ id, item_id, action, actor, at, note });
      }
      return answer([]);
    }
    if (sql.startsWith("INSERT INTO approve_items")) {
      const [id, source, kind, title, body_key, created_at, updated_at] =
        payload.params as unknown[];
      if (items.some((row) => row.id === id)) {
        return Response.json({
          success: false,
          result: [],
          errors: [{ message: "UNIQUE constraint failed: approve_items.id" }],
        });
      }
      items.push({
        id,
        source,
        kind,
        title,
        body_key,
        status: "pending",
        created_at,
        updated_at,
        decided_by: null,
        decided_at: null,
        reason: null,
      });
      return answer([]);
    }
    if (sql.startsWith("SELECT * FROM approve_items WHERE id")) {
      return answer(items.filter((row) => row.id === payload.params[0]));
    }
    if (sql.startsWith("SELECT * FROM approve_items WHERE status")) {
      return answer(items.filter((row) => row.status === payload.params[0]));
    }
    if (sql.startsWith("SELECT * FROM approve_items")) {
      return answer([...items]);
    }
    if (sql.startsWith("UPDATE approve_items SET title")) {
      const [title, body_key, updated_at, id] = payload.params as unknown[];
      const row = items.find((candidate) => candidate.id === id);
      if (row !== undefined) {
        row.title = title;
        row.body_key = body_key;
        row.updated_at = updated_at;
      }
      return answer([]);
    }
    if (sql.startsWith("UPDATE approve_items")) {
      const [status, decided_by, decided_at, reason, updated_at, id] = payload.params as unknown[];
      const row = items.find((candidate) => candidate.id === id);
      if (row !== undefined) {
        row.status = status;
        row.decided_by = decided_by;
        row.decided_at = decided_at;
        row.reason = reason;
        row.updated_at = updated_at;
      }
      return answer([]);
    }
    if (sql.startsWith("SELECT * FROM approve_audit WHERE")) {
      return answer(audit.filter((row) => row.item_id === payload.params[0]));
    }
    if (sql.startsWith("SELECT * FROM approve_audit")) {
      return answer([...audit]);
    }
    throw new Error(`fake D1 has no answer for: ${sql.slice(0, 60)}`);
  }) as typeof fetch;
  return { fetchFn, rows: () => items };
}

const CONFIG = { accountId: "acct", databaseId: "db", apiToken: "tok" };

const ITEM = {
  id: "d1",
  source: "tool",
  kind: "draft",
  title: "T",
  bodyKey: "bodies/d1.txt",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("D1QueueStore", () => {
  test("runs the full queue flow over the REST shape", async () => {
    const seen: string[] = [];
    const { fetchFn } = fakeD1((sql) => seen.push(sql));
    const store = new D1QueueStore({ ...CONFIG, fetchFn });
    await store.submit(ITEM);
    expect(seen.some((sql) => sql.startsWith("CREATE TABLE"))).toBe(true);
    expect(await store.get("d1")).toMatchObject({ status: "pending", title: "T" });
    await store.edit("d1", { title: "T2" });
    expect((await store.get("d1")).title).toBe("T2");
    await store.decide("d1", "approved", "ruth", "fine");
    expect(await store.get("d1")).toMatchObject({ status: "approved", decidedBy: "ruth" });
    await store.appendAudit({ id: "e1", itemId: "d1", action: "submit", actor: "tool", at: "t" });
    expect(await store.audit("d1")).toHaveLength(1);
    expect((await store.list("pending"))).toHaveLength(0);
  });

  test("maps missing and decided items to ApproveError", async () => {
    const { fetchFn } = fakeD1();
    const store = new D1QueueStore({ ...CONFIG, fetchFn });
    await expect(store.get("missing")).rejects.toThrow(ApproveError);
    await store.submit(ITEM);
    await expect(store.submit(ITEM)).rejects.toThrow(/already exists/);
    await store.decide("d1", "rejected", "ruth");
    await expect(store.edit("d1", { title: "x" })).rejects.toThrow(/already rejected/);
  });

  test("throws VendorError on non-2xx, on success false, and on network failure", async () => {
    const badStatus = new D1QueueStore({
      ...CONFIG,
      fetchFn: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    await expect(badStatus.list()).rejects.toThrow(VendorError);

    const failedQuery = new D1QueueStore({
      ...CONFIG,
      fetchFn: (async () =>
        Response.json({ success: false, result: [], errors: [{ message: "bad sql" }] })) as typeof fetch,
    });
    const error = await failedQuery.list().then(
      () => null,
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(VendorError);
    expect((error as Error).message).toContain("bad sql");

    const down = new D1QueueStore({
      ...CONFIG,
      fetchFn: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.list()).rejects.toThrow(VendorError);
  });

  test("sends the bearer token and the bound params", async () => {
    let auth = "";
    let body = "";
    const store = new D1QueueStore({
      ...CONFIG,
      fetchFn: (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        auth = init?.headers?.authorization ?? "";
        body = init?.body ?? "";
        return Response.json({ success: true, result: [{ results: [], success: true }], errors: [] });
      }) as typeof fetch,
    });
    await store.list("pending");
    expect(auth).toBe("Bearer tok");
    expect(body).toContain("approve_items");
  });
});
