import { describe, expect, test } from "vitest";
import { createGuards, getCostReport, GuardError, resetCosts } from "agentic-core";
import { QueueService } from "./service.js";
import {
  ApproveError,
  MemoryBlobStore,
  MemoryQueueStore,
  OpenGate,
} from "./store.js";

function fixedService() {
  let next = 0;
  const at = new Date("2026-01-02T03:04:05.000Z");
  const service = new QueueService({
    store: new MemoryQueueStore(),
    blobs: new MemoryBlobStore(),
    gate: new OpenGate(),
    now: () => at,
    newId: () => `id-${(next += 1)}`,
  });
  return service;
}

const INPUT = { source: "draft-tool", kind: "draft", title: "Hello", body: "Hello world" };

describe("submit", () => {
  test("files a pending item and writes an audit entry", async () => {
    resetCosts();
    const service = fixedService();
    const result = await service.submit(INPUT);
    expect(result.dryRun).toBe(false);
    expect(result.item).toMatchObject({
      id: "id-1",
      source: "draft-tool",
      status: "pending",
      bodyKey: "bodies/id-1.txt",
      createdAt: "2026-01-02T03:04:05.000Z",
    });
    const found = await service.show("id-1");
    expect(found.body).toBe("Hello world");
    const audit = await service.audit("id-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "submit", actor: "draft-tool" });
    expect(getCostReport().units).toBe(INPUT.body.length);
  });

  test("dry run writes nothing and records no cost", async () => {
    resetCosts();
    const service = fixedService();
    const result = await service.submit(INPUT, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(await service.list()).toEqual([]);
    expect(await service.audit()).toEqual([]);
    expect(getCostReport()).toEqual({ entries: [], dispatches: 0, units: 0 });
  });

  test("blank fields and oversize bodies throw", async () => {
    const service = fixedService();
    await expect(service.submit({ ...INPUT, title: "  " })).rejects.toThrow(ApproveError);
    await expect(service.submit({ ...INPUT, body: "" })).rejects.toThrow(ApproveError);
    await expect(service.submit({ ...INPUT, source: "" })).rejects.toThrow(ApproveError);
    await expect(service.submit({ ...INPUT, title: "t".repeat(201) })).rejects.toThrow(/max is 200/);
    await expect(service.submit({ ...INPUT, body: "b".repeat(1_000_001) })).rejects.toThrow(
      /max is 1000000/,
    );
  });

  test("a blocklisted body never enters the queue", async () => {
    resetCosts();
    const service = new QueueService({
      store: new MemoryQueueStore(),
      blobs: new MemoryBlobStore(),
      gate: new OpenGate(),
      guards: createGuards({ blocklist: ["secret"] }),
    });
    await expect(service.submit({ ...INPUT, body: "holds a SECRET" })).rejects.toThrow(GuardError);
    expect(await service.list()).toEqual([]);
  });
});

describe("edit", () => {
  test("changes title and body on a pending item", async () => {
    const service = fixedService();
    await service.submit(INPUT);
    const result = await service.edit("id-1", { title: "New", body: "New body" }, "ruth", {
      note: "fix typo",
    });
    expect(result.dryRun).toBe(false);
    expect(result.item.title).toBe("New");
    expect((await service.show("id-1")).body).toBe("New body");
    const audit = await service.audit("id-1");
    expect(audit.map((entry) => entry.action)).toEqual(["submit", "edit"]);
    expect(audit[1]).toMatchObject({ actor: "ruth", note: "fix typo" });
  });

  test("dry run leaves the stored item alone", async () => {
    const service = fixedService();
    await service.submit(INPUT);
    const result = await service.edit("id-1", { title: "New" }, "ruth", { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.item.title).toBe("New");
    expect((await service.show("id-1")).body).toBe("Hello world");
    expect((await service.audit("id-1")).map((entry) => entry.action)).toEqual(["submit"]);
  });

  test("edit needs a change and a reviewer", async () => {
    const service = fixedService();
    await service.submit(INPUT);
    await expect(service.edit("id-1", {}, "ruth")).rejects.toThrow(/needs a new title/);
    await expect(service.edit("id-1", { title: "x" }, "  ")).rejects.toThrow(/actor name/);
    await expect(service.edit("missing", { title: "x" }, "ruth")).rejects.toThrow(/no item/);
  });
});

describe("decide", () => {
  test("approve and reject record the reviewer and the reason", async () => {
    const service = fixedService();
    await service.submit(INPUT);
    await service.submit({ ...INPUT, title: "Second" });
    const approved = await service.decide("id-1", "approved", "ruth", { reason: "looks right" });
    expect(approved.item).toMatchObject({
      status: "approved",
      decidedBy: "ruth",
      reason: "looks right",
    });
    const rejected = await service.decide("id-3", "rejected", "ruth", { reason: "wrong tone" });
    expect(rejected.item.status).toBe("rejected");
    expect((await service.list("pending")).map((item) => item.id)).toEqual([]);
    expect((await service.list("approved")).map((item) => item.id)).toEqual(["id-1"]);
    const audit = await service.audit();
    expect(audit.map((entry) => entry.action)).toEqual(["submit", "submit", "approve", "reject"]);
  });

  test("a decided item stays decided", async () => {
    const service = fixedService();
    await service.submit(INPUT);
    await service.decide("id-1", "approved", "ruth");
    await expect(service.decide("id-1", "rejected", "ruth")).rejects.toThrow(/already approved/);
    await expect(service.edit("id-1", { title: "x" }, "ruth")).rejects.toThrow(/already approved/);
  });

  test("dry run decides nothing", async () => {
    const service = fixedService();
    await service.submit(INPUT);
    const result = await service.decide("id-1", "approved", "ruth", { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.item.status).toBe("approved");
    expect((await service.show("id-1")).item.status).toBe("pending");
  });
});

describe("reads", () => {
  test("list sorts oldest first and show joins the body", async () => {
    const service = fixedService();
    await service.submit({ ...INPUT, title: "First" });
    await service.submit({ ...INPUT, title: "Second" });
    expect((await service.list()).map((item) => item.title)).toEqual(["First", "Second"]);
    await expect(service.show("missing")).rejects.toThrow(/no item/);
  });
});
