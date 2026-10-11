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

function serviceFor(env: WorkerEnv): QueueService {
  const gate =
    env.APPROVE_ACCESS_TEAM !== undefined && env.APPROVE_ACCESS_AUD !== undefined
      ? new AccessGate({ teamDomain: env.APPROVE_ACCESS_TEAM, audience: env.APPROVE_ACCESS_AUD })
      : new OpenGate();
  // One service per isolate: the worker keeps its queue in memory and
  // gates decisions through Access when the env carries a team and aud.
  return new QueueService({ store: new MemoryQueueStore(), blobs: new MemoryBlobStore(), gate });
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

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const service = serviceFor(env);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, pack: env.PACK_NAME ?? "agentic-approve", version: VERSION });
    }
    if (request.method === "GET" && url.pathname === "/queue") {
      return json(await service.list(statusOf(url)));
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
        const denied =
          error instanceof Error && (error.name === "GuardError" || error.name === "ApproveError");
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          denied ? 403 : 502,
        );
      }
    }
    return json({ error: "not found" }, 404);
  },
};
