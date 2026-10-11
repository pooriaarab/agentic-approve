---
name: agentic-approve
description: Review queue for agent output: edit, approve, reject, audit. Keywords: approval, review-queue, agentic-suite, claude-code, codex, cli, mcp.
---

# agentic-approve

Review queue for agent output: edit, approve, reject, audit.

## Use the SDK

```js
import { QueueService, MemoryQueueStore, MemoryBlobStore, OpenGate } from "agentic-approve";

const queue = new QueueService({
  store: new MemoryQueueStore(),
  blobs: new MemoryBlobStore(),
  gate: new OpenGate(),
});
await queue.submit({ source: "tool", kind: "draft", title: "Hi", body: "Hello." });
```

## Use the CLI

```sh
agentic-approve submit --source "tool" --kind draft --title "Hi" --body "Hello."
agentic-approve approve --id <id> --actor ruth --dry-run
```

## Use the MCP server

Start the server with `agentic-approve mcp`. Call `approve_submit`
to file, `approve_show` to read, `approve_approve` or
`approve_reject` to decide, `approve_audit` to review history.

## Rules

- Preview each file, edit, and decision with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
