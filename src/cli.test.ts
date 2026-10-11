import { describe, expect, test } from "vitest";
import { parseArgs, runCli, UsageError, type CliIo } from "./cli.js";
import { QueueService } from "./service.js";
import { MemoryBlobStore, MemoryQueueStore, OpenGate } from "./store.js";

function testService(): QueueService {
  let next = 0;
  return new QueueService({
    store: new MemoryQueueStore(),
    blobs: new MemoryBlobStore(),
    gate: new OpenGate(),
    newId: () => `id-${(next += 1)}`,
  });
}

function testIo(service: QueueService): CliIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    readFile: (path) => `file:${path}`,
    service: () => service,
    env: () => ({ APPROVE_ACTOR: "ruth" }),
  };
}

describe("parseArgs", () => {
  test("empty args print help", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  test("--version selects version", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
  });

  test("submit takes its fields", () => {
    expect(
      parseArgs(["submit", "--source", "s", "--kind", "k", "--title", "t", "--body", "b"]),
    ).toMatchObject({ command: "submit", source: "s", kind: "k", title: "t", body: "b" });
  });

  test("list takes a status filter", () => {
    expect(parseArgs(["list", "--status", "pending"]).status).toBe("pending");
    expect(() => parseArgs(["list", "--status", "bogus"])).toThrow(/--status/);
  });

  test("unknown command throws UsageError", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(UsageError);
  });

  test("missing required flags throw", () => {
    expect(() => parseArgs(["submit", "--source", "s"])).toThrow(/--kind/);
    expect(() => parseArgs(["show"])).toThrow(/--id/);
    expect(() => parseArgs(["edit", "--id", "x"])).toThrow(/--title/);
    expect(() => parseArgs(["list", "--bogus", "x"])).toThrow(/unknown flag/);
  });
});

describe("runCli", () => {
  test("submit, list, show, and audit flow as JSON", async () => {
    const service = testService();
    const io = testIo(service);
    expect(
      await runCli(["submit", "--source", "s", "--kind", "k", "--title", "t", "--body", "b"], io),
    ).toBe(0);
    expect(JSON.parse(io.outLines[0] as string)).toMatchObject({
      dryRun: false,
      item: { id: "id-1", status: "pending" },
    });

    const listIo = testIo(service);
    expect(await runCli(["list"], listIo)).toBe(0);
    expect(JSON.parse(listIo.outLines[0] as string)).toHaveLength(1);

    const showIo = testIo(service);
    expect(await runCli(["show", "--id", "id-1"], showIo)).toBe(0);
    expect(JSON.parse(showIo.outLines[0] as string)).toMatchObject({ item: { id: "id-1" }, body: "b" });

    const auditIo = testIo(service);
    expect(await runCli(["audit", "--id", "id-1"], auditIo)).toBe(0);
    expect(JSON.parse(auditIo.outLines[0] as string)).toMatchObject([{ action: "submit" }]);
  });

  test("approve decides with the actor from env", async () => {
    const service = testService();
    await runCli(["submit", "--source", "s", "--kind", "k", "--title", "t", "--body", "b"], testIo(service));
    const io = testIo(service);
    expect(await runCli(["approve", "--id", "id-1", "--reason", "good"], io)).toBe(0);
    expect(JSON.parse(io.outLines[0] as string)).toMatchObject({
      item: { status: "approved", decidedBy: "ruth", reason: "good" },
    });
  });

  test("decide without an actor exits 1 with a usage error", async () => {
    const service = testService();
    const io = testIo(service);
    io.env = () => ({});
    await runCli(["submit", "--source", "s", "--kind", "k", "--title", "t", "--body", "b"], io);
    const code = await runCli(["approve", "--id", "id-1"], io);
    expect(code).toBe(1);
    expect(io.errLines.join("\n")).toContain("APPROVE_ACTOR");
  });

  test("missing items exit 1, bad usage exits 2", async () => {
    const missing = testIo(testService());
    expect(await runCli(["show", "--id", "nope"], missing)).toBe(1);
    expect(missing.errLines.join("\n")).toContain("ApproveError");

    const bad = testIo(testService());
    expect(await runCli(["bogus"], bad)).toBe(2);
  });

  test("version prints a version string", async () => {
    const io = testIo(testService());
    expect(await runCli(["--version"], io)).toBe(0);
    expect(io.outLines[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
