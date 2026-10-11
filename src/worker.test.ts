import { describe, expect, test } from "vitest";
import worker from "./worker.js";

describe("worker", () => {
  test("GET /health reports ok", async () => {
    const response = await worker.fetch(new Request("https://pack.test/health"), {
      PACK_NAME: "probe",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pack: "probe" });
  });

  test("GET /queue starts empty", async () => {
    const response = await worker.fetch(new Request("https://pack.test/queue"), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("POST /submit files an item", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "s", kind: "k", title: "t", body: "b" }),
      }),
      {},
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ dryRun: false, item: { status: "pending" } });
  });

  test("POST /submit rejects a bad body", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "t" }),
      }),
      {},
    );
    expect(response.status).toBe(400);
  });

  test("POST /decide rejects a bad decision and an unknown id", async () => {
    const badDecision = await worker.fetch(
      new Request("https://pack.test/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "x", decision: "maybe", actor: "ruth" }),
      }),
      {},
    );
    expect(badDecision.status).toBe(400);

    const unknown = await worker.fetch(
      new Request("https://pack.test/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "missing", decision: "approved", actor: "ruth" }),
      }),
      {},
    );
    expect(unknown.status).toBe(403);
  });

  test("unknown routes return 404", async () => {
    const response = await worker.fetch(new Request("https://pack.test/nowhere"), {});
    expect(response.status).toBe(404);
  });
});
