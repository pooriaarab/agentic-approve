#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createLogger, getCostReport, GuardError, VendorError } from "agentic-core";
import { resolveBackends } from "./env.js";
import { DEFAULT_BRAND } from "./index.js";
import { QueueService } from "./service.js";
import { ApproveError, type ItemStatus } from "./store.js";
import { VERSION } from "./version.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type CliCommand =
  | "submit"
  | "list"
  | "show"
  | "edit"
  | "approve"
  | "reject"
  | "audit"
  | "costs"
  | "mcp"
  | "help"
  | "version";

export interface CliRequest {
  command: CliCommand;
  id?: string;
  source?: string;
  kind?: string;
  title?: string;
  body?: string;
  file?: string;
  status?: ItemStatus;
  actor?: string;
  token?: string;
  reason?: string;
  note?: string;
  dryRun: boolean;
}

const COMMANDS: CliCommand[] = [
  "submit",
  "list",
  "show",
  "edit",
  "approve",
  "reject",
  "audit",
  "costs",
  "mcp",
  "help",
  "version",
];

function takeValue(args: string[], flag: string): string {
  const value = args.shift();
  if (value === undefined) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliRequest {
  const request: CliRequest = { command: "help", dryRun: false };
  const args = [...argv];
  const first = args.shift();
  if (first === undefined || first === "--help" || first === "-h") {
    return request;
  }
  if (first === "--version" || first === "-V") {
    request.command = "version";
    return request;
  }
  if (!(COMMANDS as string[]).includes(first)) {
    throw new UsageError(`unknown command "${first}"`);
  }
  request.command = first as CliCommand;
  while (args.length > 0) {
    const flag = args.shift() as string;
    if (flag === "--dry-run") {
      request.dryRun = true;
      continue;
    }
    if (
      flag === "--id" ||
      flag === "--source" ||
      flag === "--kind" ||
      flag === "--title" ||
      flag === "--body" ||
      flag === "--file" ||
      flag === "--status" ||
      flag === "--actor" ||
      flag === "--token" ||
      flag === "--reason" ||
      flag === "--note"
    ) {
      const value = takeValue(args, flag);
      if (flag === "--id") request.id = value;
      if (flag === "--source") request.source = value;
      if (flag === "--kind") request.kind = value;
      if (flag === "--title") request.title = value;
      if (flag === "--body") request.body = value;
      if (flag === "--file") request.file = value;
      if (flag === "--actor") request.actor = value;
      if (flag === "--token") request.token = value;
      if (flag === "--reason") request.reason = value;
      if (flag === "--note") request.note = value;
      if (flag === "--status") {
        if (value !== "pending" && value !== "approved" && value !== "rejected") {
          throw new UsageError(`--status needs pending, approved, or rejected, got "${value}"`);
        }
        request.status = value;
      }
      continue;
    }
    throw new UsageError(`unknown flag "${flag}" for "${request.command}"`);
  }
  checkRequired(request);
  return request;
}

function checkRequired(request: CliRequest): void {
  switch (request.command) {
    case "submit":
      if (request.source === undefined) throw new UsageError("submit needs --source");
      if (request.kind === undefined) throw new UsageError("submit needs --kind");
      if (request.title === undefined) throw new UsageError("submit needs --title");
      if (request.body === undefined && request.file === undefined) {
        throw new UsageError("submit needs --body or --file");
      }
      break;
    case "show":
    case "approve":
    case "reject":
      if (request.id === undefined) throw new UsageError(`${request.command} needs --id`);
      break;
    case "edit":
      if (request.id === undefined) throw new UsageError("edit needs --id");
      if (request.title === undefined && request.body === undefined && request.file === undefined) {
        throw new UsageError("edit needs --title, --body, or --file");
      }
      break;
    default:
      break;
  }
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): string;
  service(): QueueService;
  env(): NodeJS.ProcessEnv;
}

function defaultIo(): CliIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readFile: (path) => readFileSync(path, "utf8"),
    service: () => {
      const backends = resolveBackends(process.env);
      return new QueueService({ ...backends, logger: createLogger({ level: "warn" }) });
    },
    env: () => process.env,
  };
}

function helpText(): string {
  const command = DEFAULT_BRAND.command;
  return [
    `${DEFAULT_BRAND.name} ${VERSION}`,
    `${DEFAULT_BRAND.description}`,
    "",
    `Usage: ${command} <command> [flags]`,
    "",
    "Commands:",
    "  submit --source <s> --kind <k> --title <t> [--body <b>] [--file <p>] [--dry-run]",
    "      File one item for review, print the item.",
    "  list [--status <pending|approved|rejected>]   List items, oldest first.",
    "  show --id <id>                               Print one item with its body.",
    "  edit --id <id> [--title <t>] [--body <b>] [--file <p>] [--actor <a>] [--dry-run]",
    "      Change a pending item.",
    "  approve --id <id> [--actor <a>] [--reason <r>] [--dry-run]   Approve a pending item.",
    "  reject --id <id> [--actor <a>] [--reason <r>] [--dry-run]    Reject a pending item.",
    "  audit [--id <id>]                            Print audit entries, oldest first.",
    "  costs                                        Print the cost report as JSON.",
    "  mcp                                          Start the MCP server on stdio.",
    "",
    "Flags:",
    "  --actor <a>        Reviewer name. Falls back to APPROVE_ACTOR.",
    "  --token <t>        Access token. Falls back to APPROVE_TOKEN.",
    "  --help, -h         Print this help.",
    "  --version, -V      Print the version.",
  ].join("\n");
}

function readBody(request: CliRequest, io: CliIo): string | undefined {
  if (request.file !== undefined) return io.readFile(request.file);
  return request.body;
}

function actorFor(request: CliRequest, io: CliIo): string {
  const actor = request.actor ?? io.env().APPROVE_ACTOR ?? "";
  if (actor.trim().length === 0) {
    throw new UsageError("this command needs --actor or APPROVE_ACTOR");
  }
  return actor;
}

function tokenFor(request: CliRequest, io: CliIo): string | undefined {
  return request.token ?? io.env().APPROVE_TOKEN;
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let request: CliRequest;
  try {
    request = parseArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(`Run "${DEFAULT_BRAND.command} --help" for usage.`);
    return 2;
  }
  try {
    switch (request.command) {
      case "help":
        io.out(helpText());
        return 0;
      case "version":
        io.out(VERSION);
        return 0;
      case "costs":
        io.out(JSON.stringify(getCostReport()));
        return 0;
      case "mcp": {
        const { startMcp } = await import("./mcp.js");
        await startMcp();
        return 0;
      }
      case "submit": {
        const service = io.service();
        const result = await service.submit(
          {
            source: request.source as string,
            kind: request.kind as string,
            title: request.title as string,
            body: readBody(request, io) as string,
          },
          { dryRun: request.dryRun },
        );
        io.out(JSON.stringify(result));
        return 0;
      }
      case "list": {
        const items = await io.service().list(request.status);
        io.out(JSON.stringify(items));
        return 0;
      }
      case "show": {
        const found = await io.service().show(request.id as string);
        io.out(JSON.stringify(found));
        return 0;
      }
      case "edit": {
        const result = await io.service().edit(
          request.id as string,
          { title: request.title, body: readBody(request, io) },
          actorFor(request, io),
          { dryRun: request.dryRun, token: tokenFor(request, io), note: request.note },
        );
        io.out(JSON.stringify(result));
        return 0;
      }
      case "approve":
      case "reject": {
        const result = await io.service().decide(
          request.id as string,
          request.command === "approve" ? "approved" : "rejected",
          actorFor(request, io),
          { dryRun: request.dryRun, token: tokenFor(request, io), reason: request.reason },
        );
        io.out(JSON.stringify(result));
        return 0;
      }
      case "audit": {
        const entries = await io.service().audit(request.id);
        io.out(JSON.stringify(entries));
        return 0;
      }
    }
  } catch (error) {
    if (
      error instanceof GuardError ||
      error instanceof VendorError ||
      error instanceof UsageError ||
      error instanceof ApproveError
    ) {
      io.err(`${error.name}: ${error.message}`);
      return 1;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      io.err(`file not found: ${request.file ?? ""}`);
      return 1;
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // Exit nonzero at once. On zero, fall off the end so a running
      // server (mcp) keeps its stdio handles open. Plain commands
      // hold no handles and exit 0 on their own.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
