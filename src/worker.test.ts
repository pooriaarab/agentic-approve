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

  test("GET / serves the review console", async () => {
    const response = await worker.fetch(new Request("https://pack.test/"), {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    expect(page).toContain("review console");
    expect(page).toContain("/decide");
  });

  test("GET /item needs an id and reads a filed item", async () => {
    const missing = await worker.fetch(new Request("https://pack.test/item"), {});
    expect(missing.status).toBe(400);

    const filed = (await (
      await worker.fetch(
        new Request("https://pack.test/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "s", kind: "k", title: "item probe", body: "probe body" }),
        }),
        {},
      )
    ).json()) as { item: { id: string } };
    const found = await worker.fetch(
      new Request(`https://pack.test/item?id=${filed.item.id}`),
      {},
    );
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      item: { id: filed.item.id, title: "item probe" },
      body: "probe body",
    });
  });

  test("POST /edit changes a pending item and rejects an empty patch", async () => {
    const filed = (await (
      await worker.fetch(
        new Request("https://pack.test/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "s", kind: "k", title: "before", body: "b" }),
        }),
        {},
      )
    ).json()) as { item: { id: string } };

    const empty = await worker.fetch(
      new Request("https://pack.test/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: filed.item.id, actor: "ruth" }),
      }),
      {},
    );
    expect(empty.status).toBe(400);

    const edited = await worker.fetch(
      new Request("https://pack.test/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: filed.item.id, actor: "ruth", title: "after" }),
      }),
      {},
    );
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ dryRun: false, item: { title: "after" } });
  });

  test("a filed item flows through decide into the audit log", async () => {
    const filed = (await (
      await worker.fetch(
        new Request("https://pack.test/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "s", kind: "k", title: "flow", body: "b" }),
        }),
        {},
      )
    ).json()) as { item: { id: string } };
    const decided = await worker.fetch(
      new Request("https://pack.test/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: filed.item.id, decision: "approved", actor: "ruth" }),
      }),
      {},
    );
    expect(decided.status).toBe(200);
    const audit = await worker.fetch(
      new Request(`https://pack.test/audit?item=${filed.item.id}`),
      {},
    );
    expect(audit.status).toBe(200);
    expect(await audit.json()).toMatchObject([
      { action: "submit" },
      { action: "approve", actor: "ruth" },
    ]);
  });
});
