import { AccessGate } from "./access.js";
import { QueueService } from "./service.js";
import { MemoryBlobStore, MemoryQueueStore, OpenGate, type ItemStatus } from "./store.js";
import { VERSION } from "./version.js";

export interface WorkerEnv {
  PACK_NAME?: string;
  APPROVE_ACCESS_TEAM?: string;
  APPROVE_ACCESS_AUD?: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// One service per isolate and gate setup: the worker keeps its queue
// in memory, so requests that share an isolate share one queue. A
// fresh isolate starts empty.
const services = new Map<string, QueueService>();

function serviceFor(env: WorkerEnv): QueueService {
  const key = `${env.APPROVE_ACCESS_TEAM ?? ""}\n${env.APPROVE_ACCESS_AUD ?? ""}`;
  const hit = services.get(key);
  if (hit !== undefined) return hit;
  const gate =
    env.APPROVE_ACCESS_TEAM !== undefined && env.APPROVE_ACCESS_AUD !== undefined
      ? new AccessGate({ teamDomain: env.APPROVE_ACCESS_TEAM, audience: env.APPROVE_ACCESS_AUD })
      : new OpenGate();
  const service = new QueueService({
    store: new MemoryQueueStore(),
    blobs: new MemoryBlobStore(),
    gate,
  });
  services.set(key, service);
  return service;
}

function statusOf(url: URL): ItemStatus | undefined {
  const status = url.searchParams.get("status");
  if (status === null) return undefined;
  if (status !== "pending" && status !== "approved" && status !== "rejected") return undefined;
  return status;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await request.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function textField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function denied(error: unknown): boolean {
  return error instanceof Error && (error.name === "GuardError" || error.name === "ApproveError");
}

function consolePage(pack: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pack} review console</title>
<style>
body{font-family:system-ui,sans-serif;max-width:72rem;margin:0 auto;padding:1rem;color:#111}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}
tr.pick{cursor:pointer}tr.pick:hover{background:#f4f4f4}tr.sel{background:#e8f0fe}
label{display:block;margin:.6rem 0 .2rem}input,textarea,select{width:100%;box-sizing:border-box}
textarea{font-family:inherit}button{margin:.6rem .4rem 0 0;padding:.4rem .9rem}
.row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
pre{background:#f6f6f6;padding:.6rem;white-space:pre-wrap}
.err{color:#a00}.ok{color:#060}
</style>
</head>
<body>
<h1>${pack} review console</h1>
<p id="msg"></p>
<div class="row">
<div>
<h2>Queue</h2>
<label for="f-status">Status</label>
<select id="f-status"><option value="">all</option><option value="pending" selected>pending</option><option value="approved">approved</option><option value="rejected">rejected</option></select>
<table><thead><tr><th>Title</th><th>Kind</th><th>Source</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table>
<h2>File an item</h2>
<label for="n-source">Source</label><input id="n-source" value="console">
<label for="n-kind">Kind</label><input id="n-kind" value="post">
<label for="n-title">Title</label><input id="n-title">
<label for="n-body">Body</label><textarea id="n-body" rows="4"></textarea>
<button id="b-file">File</button>
</div>
<div>
<h2>Review</h2>
<label for="r-title">Title</label><input id="r-title">
<label for="r-body">Body</label><textarea id="r-body" rows="8"></textarea>
<label for="r-actor">Reviewer</label><input id="r-actor">
<label for="r-reason">Reason or note</label><input id="r-reason">
<div><button id="b-edit">Save edit</button><button id="b-approve">Approve</button><button id="b-reject">Reject</button></div>
<h2>Audit</h2>
<pre id="audit">(pick an item)</pre>
</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let current = null;
function say(text, bad) {
  const el = $("msg");
  el.textContent = text;
  el.className = bad ? "err" : "ok";
}
function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
async function call(path, init) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("request failed: " + res.status));
  return data;
}
async function refresh() {
  const status = $("f-status").value;
  const items = await call("/queue" + (status ? ("?status=" + status) : ""));
  $("rows").innerHTML = items
    .map(
      (i) =>
        '<tr class="pick' + (current === i.id ? " sel" : "") + '" data-id="' + esc(i.id) + '"><td>' +
        esc(i.title) + "</td><td>" + esc(i.kind) + "</td><td>" + esc(i.source) + "</td><td>" + esc(i.status) + "</td></tr>",
    )
    .join("");
  document.querySelectorAll("tr.pick").forEach((tr) =>
    tr.addEventListener("click", () => pick(tr.getAttribute("data-id"))),
  );
}
async function pick(id) {
  current = id;
  const found = await call("/item?id=" + encodeURIComponent(id));
  $("r-title").value = found.item.title;
  $("r-body").value = found.body;
  const entries = await call("/audit?item=" + encodeURIComponent(id));
  $("audit").textContent = entries.length
    ? entries.map((e) => e.at + " " + e.action + " by " + e.actor + (e.note ? (" — " + e.note) : "")).join("\\n")
    : "(no entries)";
  refresh().catch((e) => say(e.message, true));
}
function needActor() {
  const actor = $("r-actor").value.trim();
  if (!actor) throw new Error("a decision needs a reviewer name");
  return actor;
}
$("f-status").addEventListener("change", () => refresh().catch((e) => say(e.message, true)));
$("b-file").addEventListener("click", async () => {
  try {
    const filed = await call("/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: $("n-source").value, kind: $("n-kind").value, title: $("n-title").value, body: $("n-body").value }),
    });
    say("filed " + filed.item.id);
    await refresh();
  } catch (e) {
    say(e.message, true);
  }
});
$("b-edit").addEventListener("click", async () => {
  try {
    if (!current) throw new Error("pick an item first");
    await call("/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: current, actor: needActor(), title: $("r-title").value, body: $("r-body").value, note: $("r-reason").value || undefined }),
    });
    say("saved edit to " + current);
    await pick(current);
  } catch (e) {
    say(e.message, true);
  }
});
async function decide(decision) {
  try {
    if (!current) throw new Error("pick an item first");
    await call("/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: current, decision, actor: needActor(), reason: $("r-reason").value || undefined }),
    });
    say(decision + " " + current);
    current = null;
    await refresh();
  } catch (e) {
    say(e.message, true);
  }
}
$("b-approve").addEventListener("click", () => decide("approved"));
$("b-reject").addEventListener("click", () => decide("rejected"));
refresh().catch((e) => say(e.message, true));
</script>
</body>
</html>
`;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const service = serviceFor(env);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(consolePage(env.PACK_NAME ?? "agentic-approve"), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, pack: env.PACK_NAME ?? "agentic-approve", version: VERSION });
    }
    if (request.method === "GET" && url.pathname === "/queue") {
      return json(await service.list(statusOf(url)));
    }
    if (request.method === "GET" && url.pathname === "/item") {
      const id = url.searchParams.get("id");
      if (id === null || id.length === 0) {
        return json({ error: "item needs ?id=" }, 400);
      }
      try {
        return json(await service.show(id));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 403);
      }
    }
    if (request.method === "GET" && url.pathname === "/audit") {
      return json(await service.audit(url.searchParams.get("item") ?? undefined));
    }
    if (request.method === "POST" && url.pathname === "/submit") {
      const body = await readBody(request);
      const source = body === null ? undefined : textField(body, "source");
      const kind = body === null ? undefined : textField(body, "kind");
      const title = body === null ? undefined : textField(body, "title");
      const text = body === null ? undefined : textField(body, "body");
      if (source === undefined || kind === undefined || title === undefined || text === undefined) {
        return json({ error: "body needs source, kind, title, and body strings" }, 400);
      }
      try {
        return json(await service.submit({ source, kind, title, body: text }), 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/edit") {
      const body = await readBody(request);
      const id = body === null ? undefined : textField(body, "id");
      const actor = body === null ? undefined : textField(body, "actor");
      if (id === undefined || actor === undefined) {
        return json({ error: "body needs id and actor strings" }, 400);
      }
      const title = body === null ? undefined : textField(body, "title");
      const text = body === null ? undefined : textField(body, "body");
      if (title === undefined && text === undefined) {
        return json({ error: "edit needs a new title or a new body" }, 400);
      }
      const note = body === null ? undefined : textField(body, "note");
      const token = body === null ? undefined : textField(body, "token");
      try {
        return json(await service.edit(id, { title, body: text }, actor, { note, token }));
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          denied(error) ? 403 : 502,
        );
      }
    }
    if (request.method === "POST" && url.pathname === "/decide") {
      const body = await readBody(request);
      const id = body === null ? undefined : textField(body, "id");
      const decision = body === null ? undefined : textField(body, "decision");
      const actor = body === null ? undefined : textField(body, "actor");
      if (id === undefined || actor === undefined) {
        return json({ error: "body needs id and actor strings" }, 400);
      }
      if (decision !== "approved" && decision !== "rejected") {
        return json({ error: 'decision must be "approved" or "rejected"' }, 400);
      }
      const reason = body === null ? undefined : textField(body, "reason");
      const token = body === null ? undefined : textField(body, "token");
      try {
        return json(await service.decide(id, decision, actor, { reason, token }));
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          denied(error) ? 403 : 502,
        );
      }
    }
    return json({ error: "not found" }, 404);
  },
};
