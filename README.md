# Agentic approve

Review queue for agent output: edit, approve, reject, audit.

One tool files a draft. A reviewer reads it, fixes it, and approves
or rejects it. The queue records each step, so you always know who
decided what and when.

## How it works

The pack gives one queue with three faces: a terminal command, an
npm import, and an MCP server. Filing stays open, so any tool can
file. Decisions need a reviewer name. All output is JSON.

Local files back the queue by default. It runs with no keys and no
network. Set env vars to move the queue to D1, the bodies to R2,
and the decisions behind Cloudflare Access.

## Quick start

```sh
npm install -g agentic-approve
agentic-approve submit --source notes --kind draft --title "Launch note" --body "We ship Tuesday."
agentic-approve list
agentic-approve show --id <id>
APPROVE_ACTOR=ruth agentic-approve approve --id <id> --reason "Reads well."
agentic-approve audit --id <id>
```

Preview a decision before it lands:

```sh
APPROVE_ACTOR=ruth agentic-approve reject --id <id> --reason "Wrong date." --dry-run
```

Call the library:

```js
import { QueueService, MemoryQueueStore, MemoryBlobStore, OpenGate } from "agentic-approve";

const queue = new QueueService({
  store: new MemoryQueueStore(),
  blobs: new MemoryBlobStore(),
  gate: new OpenGate(),
});
const filed = await queue.submit({ source: "notes", kind: "draft", title: "Hi", body: "Hello." });
await queue.decide(filed.item.id, "approved", "ruth");
```

Start the MCP server:

```sh
agentic-approve mcp
```

## Three usecases

1. You hold each agent draft for review before you send it.
2. You fix a queued draft, then approve the fixed text.
3. You read the audit log to see who approved each item.

## Backends

| Part | Default | Vendor |
| --- | --- | --- |
| Queue | Local JSON file | D1 |
| Bodies | Local dir | R2 |
| Gate | Open, needs a name | Cloudflare Access |

Set a full group to switch one part. A half-set group throws.

```sh
# Queue in D1
export APPROVE_D1_ACCOUNT_ID=<account>
export APPROVE_D1_DATABASE_ID=<database>
export APPROVE_D1_API_TOKEN=<token>
# Bodies in R2
export APPROVE_R2_ACCOUNT_ID=<account>
export APPROVE_R2_BUCKET=<bucket>
export APPROVE_R2_ACCESS_KEY_ID=<key>
export APPROVE_R2_SECRET_ACCESS_KEY=<secret>
# Decisions behind Access
export APPROVE_ACCESS_TEAM=<team>.cloudflareaccess.com
export APPROVE_ACCESS_AUD=<policy-aud>
export APPROVE_TOKEN=<reviewer-jwt>
```

Local data lives in `.approve-data`. Set `APPROVE_DATA_DIR` to move it.

## Gates

Run all three before you push:

```sh
npm run build && npm run typecheck && npm test
```

Then run the real installed CLI once from a tarball:

```sh
npm pack
npx --yes --package ./agentic-approve-0.1.0.tgz agentic-approve --version
```

## Release flow

Push to `main` for review. Merge to `release` to publish. The
publish workflow ships only when the version is new.

## Layout

- `src/index.ts`: the library face.
- `src/cli.ts`: the terminal face.
- `src/mcp.ts`: the MCP server. `src/mcp-bin.ts` starts it.
- `src/worker.ts`: the edge worker face.
- `src/service.ts`: the queue rules.
- `src/store.ts`: the domain and the memory backends.
- `src/local.ts`: the file backends.
- `src/d1.ts`: the D1 backend.
- `src/r2.ts`: the R2 backend.
- `src/access.ts`: the Access gate.
- `agentic-core.d.ts`: the frozen contract.
- `docs/agentic-core.md`: the contract in plain words.

## License

MIT. See `LICENSE`.
