import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createLogger, getCostReport, GuardError, VendorError, type Logger } from "agentic-core";
import { resolveBackends } from "./env.js";
import { DEFAULT_BRAND } from "./index.js";
import { QueueService } from "./service.js";
import { ApproveError } from "./store.js";

export interface McpDeps {
  service?: QueueService;
  logger?: Logger;
}

function errorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function okResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fail(error: unknown): { content: { type: "text"; text: string }[]; isError?: true } {
  if (error instanceof GuardError || error instanceof VendorError || error instanceof ApproveError) {
    return errorResult(error);
  }
  throw error;
}

const statusSchema = z.enum(["pending", "approved", "rejected"]).optional();

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const logger = deps.logger ?? createLogger({ quiet: true });
  const service =
    deps.service ?? new QueueService({ ...resolveBackends(process.env), logger });
  const server = new McpServer({
    name: DEFAULT_BRAND.command,
    version: DEFAULT_BRAND.version,
  });

  server.registerTool(
    "approve_submit",
    {
      description: "File one item for review. Pass dryRun to preview only.",
      inputSchema: {
        source: z.string().describe("Tool that produced the item."),
        kind: z.string().describe("Item kind, like draft or send."),
        title: z.string().describe("Short title, max 200 chars."),
        body: z.string().describe("Full body text."),
        dryRun: z.boolean().optional().describe("Preview without filing."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ source, kind, title, body, dryRun }) => {
      try {
        return okResult(await service.submit({ source, kind, title, body }, { dryRun: dryRun ?? false }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "approve_list",
    {
      description: "List queued items, oldest first. Filter by status when set.",
      inputSchema: {
        status: statusSchema.describe("Pending, approved, or rejected."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      try {
        return okResult(await service.list(status));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "approve_show",
    {
      description: "Show one item with its full body.",
      inputSchema: {
        id: z.string().describe("Item id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        return okResult(await service.show(id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "approve_edit",
    {
      description: "Change a pending item. Pass dryRun to preview only.",
      inputSchema: {
        id: z.string().describe("Item id."),
        title: z.string().optional().describe("New title."),
        body: z.string().optional().describe("New body."),
        actor: z.string().describe("Reviewer name."),
        token: z.string().optional().describe("Access token when the gate needs one."),
        note: z.string().optional().describe("Audit note."),
        dryRun: z.boolean().optional().describe("Preview without saving."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, title, body, actor, token, note, dryRun }) => {
      try {
        return okResult(
          await service.edit(id, { title, body }, actor, { token, note, dryRun: dryRun ?? false }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "approve_approve",
    {
      description: "Approve a pending item. Pass dryRun to preview only.",
      inputSchema: {
        id: z.string().describe("Item id."),
        actor: z.string().describe("Reviewer name."),
        reason: z.string().optional().describe("Why it passed."),
        token: z.string().optional().describe("Access token when the gate needs one."),
        dryRun: z.boolean().optional().describe("Preview without deciding."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, actor, reason, token, dryRun }) => {
      try {
        return okResult(
          await service.decide(id, "approved", actor, { reason, token, dryRun: dryRun ?? false }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "approve_reject",
    {
      description: "Reject a pending item. Pass dryRun to preview only.",
      inputSchema: {
        id: z.string().describe("Item id."),
        actor: z.string().describe("Reviewer name."),
        reason: z.string().optional().describe("Why it failed."),
        token: z.string().optional().describe("Access token when the gate needs one."),
        dryRun: z.boolean().optional().describe("Preview without deciding."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, actor, reason, token, dryRun }) => {
      try {
        return okResult(
          await service.decide(id, "rejected", actor, { reason, token, dryRun: dryRun ?? false }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "approve_audit",
    {
      description: "Read audit entries, oldest first. Filter by item id when set.",
      inputSchema: {
        itemId: z.string().optional().describe("Item id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ itemId }) => {
      try {
        return okResult(await service.audit(itemId));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_cost_report",
    {
      description: "Read the cost report for this session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => okResult(getCostReport()),
  );

  return server;
}

export async function startMcp(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
