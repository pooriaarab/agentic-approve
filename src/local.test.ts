import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FileBlobStore, FileQueueStore } from "./local.js";
import { ApproveError } from "./store.js";

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "approve-local-"));
}

const ITEM = {
  id: "a1",
  source: "tool",
  kind: "draft",
  title: "T",
  bodyKey: "bodies/a1.txt",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("FileQueueStore", () => {
  test("round-trips items and audit entries across instances", async () => {
    const dir = newDir();
    const first = new FileQueueStore(dir);
    await first.submit(ITEM);
    await first.appendAudit({ id: "e1", itemId: "a1", action: "submit", actor: "tool", at: ITEM.createdAt });
    await first.decide("a1", "approved", "ruth", "fine");

    const second = new FileQueueStore(dir);
    expect(await second.get("a1")).toMatchObject({ status: "approved", decidedBy: "ruth" });
    expect(await second.audit("a1")).toHaveLength(1);
    await expect(second.get("missing")).rejects.toThrow(ApproveError);
    await expect(second.submit(ITEM)).rejects.toThrow(/already exists/);
  });

  test("locks decided items", async () => {
    const store = new FileQueueStore(newDir());
    await store.submit(ITEM);
    await store.decide("a1", "rejected", "ruth");
    await expect(store.edit("a1", { title: "x" })).rejects.toThrow(/already rejected/);
    await expect(store.decide("a1", "approved", "ruth")).rejects.toThrow(/already rejected/);
  });
});

describe("FileBlobStore", () => {
  test("round-trips bodies and rejects bad keys", async () => {
    const blobs = new FileBlobStore(newDir());
    await blobs.put("bodies/a1.txt", "hello");
    expect(await blobs.get("bodies/a1.txt")).toBe("hello");
    await expect(blobs.get("bodies/missing.txt")).rejects.toThrow(ApproveError);
    await expect(blobs.put("../escape.txt", "x")).rejects.toThrow(/bad blob key/);
  });
});
