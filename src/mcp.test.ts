import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createMcpServer } from "./mcp.js";
import { QueueService } from "./service.js";
import { MemoryBlobStore, MemoryQueueStore, OpenGate } from "./store.js";

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0].text;
}

function testService(): QueueService {
  return new QueueService({
    store: new MemoryQueueStore(),
    blobs: new MemoryBlobStore(),
    gate: new OpenGate(),
  });
}

async function linked(service: QueueService): Promise<{
  client: Client;
  server: ReturnType<typeof createMcpServer>;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ service });
  await server.connect(serverTransport);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("mcp server", () => {
  test("serves eight tools over a client link", async () => {
    const { client, close } = await linked(testService());
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "approve_approve",
        "approve_audit",
        "approve_edit",
        "approve_list",
        "approve_reject",
        "approve_show",
        "approve_submit",
        "get_cost_report",
      ]);
    } finally {
      await close();
    }
  });

  test("submit, edit, approve, and audit flow through tools", async () => {
    const { client, close } = await linked(testService());
    try {
      const filed = await client.callTool({
        name: "approve_submit",
        arguments: { source: "s", kind: "k", title: "t", body: "b" },
      });
      const id = (JSON.parse(textOf(filed)) as { item: { id: string } }).item.id;
      expect(typeof id).toBe("string");

      const listed = await client.callTool({ name: "approve_list", arguments: {} });
      expect(JSON.parse(textOf(listed))).toHaveLength(1);

      const edited = await client.callTool({
        name: "approve_edit",
        arguments: { id, title: "t2", actor: "ruth" },
      });
      expect(JSON.parse(textOf(edited))).toMatchObject({ item: { title: "t2" } });

      const decided = await client.callTool({
        name: "approve_approve",
        arguments: { id, actor: "ruth", reason: "good" },
      });
      expect(JSON.parse(textOf(decided))).toMatchObject({ item: { status: "approved" } });

      const audit = await client.callTool({ name: "approve_audit", arguments: { itemId: id } });
      expect(JSON.parse(textOf(audit))).toMatchObject([
        { action: "submit" },
        { action: "edit" },
        { action: "approve" },
      ]);
    } finally {
      await close();
    }
  });

  test("a bad decision returns a tool error, not a crash", async () => {
    const { client, close } = await linked(testService());
    try {
      const result = await client.callTool({
        name: "approve_approve",
        arguments: { id: "missing", actor: "ruth" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("no item");
    } finally {
      await close();
    }
  });
});
