# agentic-approve

[![npm version](https://img.shields.io/npm/v/agentic-approve)](https://www.npmjs.com/package/agentic-approve)
[![Downloads per month](https://img.shields.io/npm/dm/agentic-approve)](https://www.npmjs.com/package/agentic-approve)
[![MIT license](https://img.shields.io/npm/l/agentic-approve)](https://opensource.org/license/mit)

[Docs](https://www.npmjs.com/package/agentic-approve) · [Setup](#integration-guides) · [API](#runtime-surfaces) · [Comparisons](#compare) · [llms.txt](https://github.com/pooriaarab/agentic-approve/blob/main/llms.txt)

agentic-approve is an open-source approval queue for developers who review AI agent output before their applications act.
Reviewers edit drafts, approve or reject items, and read an audit log.
A Node.js SDK, command-line interface (CLI), Model Context Protocol (MCP) server, and self-hosted Worker expose the queue.

## Install

```sh
npm install agentic-approve
```

Use Node.js 18 or later. The package includes TypeScript declarations and has three direct runtime dependencies.
For terminal use, run `npm install -g agentic-approve`.

## Submit your first draft

Save this example as `review.mjs`. Run `node review.mjs` after installation.
No environment variables or credentials are required for this memory-backed example.

```js
import {
  QueueService, MemoryQueueStore, MemoryBlobStore, OpenGate, getCostReport,
} from 'agentic-approve';

const queue = new QueueService({
  store: new MemoryQueueStore(),
  blobs: new MemoryBlobStore(),
  gate: new OpenGate(),
});
const draft = {
  source: 'writer', kind: 'post', title: 'Launch note', body: 'We ship Tuesday.',
};
await queue.submit(draft, { dryRun: true });
const { item } = await queue.submit(draft);
console.log((await queue.show(item.id)).body);
await queue.decide(item.id, 'approved', 'ruth', { dryRun: true });
await queue.decide(item.id, 'approved', 'ruth');
console.log((await queue.show(item.id)).item.status);
console.log((await queue.audit(item.id)).map(entry => entry.action));
console.log(getCostReport());
```

The output includes `We ship Tuesday.`, `approved`, and audit actions `submit` and `approve`.
The final object reports costs recorded in this process. Memory data disappears when the process exits.

## How it works

```text
SDK / CLI / MCP / Worker API
            |
       QueueService
       /     |     \
 QueueStore  |   ReviewerGate <-- edit / approve / reject
             |
         BlobStore
             |
  item status + body + audit entries
```

The CLI and MCP server use local files by default. Their cloud backends are selected through environment variables.
The Worker uses memory stores per isolate; it does not use those D1 or R2 settings.
Each successful mutation appends an audit entry. A dry run returns a preview without service writes.

## Why it exists

Agent tools need a place to leave drafts for named reviewers.
agentic-approve stores text and decisions separately from the application that publishes or sends the approved output.
LangGraph interrupts and Temporal workflows address broader execution and state-management needs.
This package provides a review queue that callers can use without adopting either workflow runtime.

## Compare

Scope checked on October 14, 2026, against the linked official documentation.
These are alternatives for approval workflows, not built-in integrations.

| Property | agentic-approve | [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | [Temporal](https://docs.temporal.io/workflows) |
| --- | --- | --- | --- |
| Scope | Text review queue and audit log | Graph execution with interrupts and resume | Durable workflow execution |
| Approval mechanism | Pending item becomes approved or rejected | Caller resumes an interrupt with input | Application defines the review workflow |
| State model | Queue records and body stores | Thread state with a checkpointer | Workflow execution history |
| Application wiring | Caller reads the decision | Caller supplies resume input | Application defines workflow code |
| Deployment | Node.js process or self-hosted Worker | Application runtime with a checkpointer | Workflow workers and a Temporal service |
| Configuration | Constructor options or environment variables | Graph code and checkpoint configuration | Workflow code and worker configuration |
| Pricing reference | MIT package; cloud vendor charges apply | [LangSmith pricing](https://www.langchain.com/pricing) for related services | [Temporal pricing](https://temporal.io/pricing) for its cloud service |

## Coverage table

| Backend or integration | Status | Implemented behavior |
| --- | --- | --- |
| Local filesystem | ✓ | JSON queue, audit entries, and text bodies |
| In-memory stores | ✓ | Queue and bodies within one process or Worker isolate |
| Cloudflare D1 | Implemented; mock-tested | Queue and audit SQL through the REST API |
| Cloudflare R2 | Implemented; mock-tested | Text body GET and PUT with AWS Signature V4 |
| Cloudflare Access | Implemented; generated-token tests | RS256 token signature, issuer, audience, and expiry checks |
| Cloudflare Workers | Scaffold deployment config; memory-backed handler | Browser review console and JSON routes |

The source implements three Cloudflare adapters: D1, R2, and Access.
Repository tests use mocked network calls and locally generated Access tokens.
This rewrite verifies zero adapters with live credentials; live cloud deployment remains unverified.
MCP clients call eight registered tools. The code has no client-specific Claude Code or Codex connector.

## Common use cases

1. Content developers with Node.js: file post drafts, review copy, and let a separate publisher read approved items.
2. Support teams with a Node.js bot: store reply drafts as `message` items and record reviewer reasons.
3. Voice-agent developers with the CLI: file call summaries and scripts before a separate dialer uses them.
4. Print teams with the Worker console: review postcard copy and art notes before an external print job runs.

## Feature list

- **Draft review:** Submit, read, edit, approve, and reject text items through the [runtime surfaces](#runtime-surfaces).
- **Audit entries:** Record the action, actor, timestamp, and optional note for each successful mutation.
- **Dry runs:** Preview submit, edit, and decision calls through the SDK, CLI, or MCP tools.
- **Storage selection:** Choose local, memory, or Cloudflare stores through [backend setup](#integration-guides).
- **Reviewer gates:** Require a name with `OpenGate`, or check an Access token with `AccessGate`.
- **Cost reports:** Read process-local accounting through `getCostReport()`, `costs`, or `get_cost_report`.

## Runtime surfaces

### SDK

The Node.js SDK exports `QueueService` and its store, blob, and gate adapters.
Service methods are `backendNames`, `submit`, `list`, `show`, `edit`, `decide`, and `audit`.
Use `decide(id, 'approved' | 'rejected', actor, options)` for decisions.
Use `resolveBackends(process.env)` for the same backend selection as the CLI and MCP server.
The package imports Node.js modules; browser-only SDK use is unsupported.

### CLI

All 11 commands run as `agentic-approve <command>`:

| Command | Inputs and behavior |
| --- | --- |
| `submit` | `--source`, `--kind`, `--title`, and `--body` or `--file` |
| `list` | Optional `--status pending`, `approved`, or `rejected` |
| `show` | `--id`; returns the item and body |
| `edit` | `--id`, `--actor`, and `--title`, `--body`, or `--file`; optional `--note` |
| `approve` | `--id`, `--actor`; optional `--reason` |
| `reject` | `--id`, `--actor`; optional `--reason` |
| `audit` | Optional `--id`; returns entries oldest first |
| `costs` | Returns the current process cost report |
| `mcp` | Starts the stdio MCP server |
| `help` | Prints command help; aliases `--help`, `-h` |
| `version` | Prints the version; aliases `--version`, `-V` |

Submit, edit, approve, and reject accept `--dry-run`.
Reviewer commands accept `--token`; `APPROVE_ACTOR` and `APPROVE_TOKEN` provide fallbacks.
`--file` takes precedence over `--body`. Data commands return JSON.

### MCP

Start with `agentic-approve mcp` or `npx agentic-approve-mcp`.
The stdio server registers all eight tools below.
Discover them with `tools/list`. Preview mutations with `dryRun: true` before submitting the real call.

| Tool | Behavior |
| --- | --- |
| `approve_submit` | Files source, kind, title, and body |
| `approve_list` | Lists items; optional status filter |
| `approve_show` | Reads an item and its body by id |
| `approve_edit` | Changes title or body; requires actor |
| `approve_approve` | Approves an item; requires actor |
| `approve_reject` | Rejects an item; requires actor |
| `approve_audit` | Reads entries; optional `itemId` filter |
| `get_cost_report` | Reads session cost accounting |

### Worker

The repository includes a Worker handler, browser console, and sample Wrangler configuration.
From a source checkout, run `npx wrangler deploy` and open `/` at the deployment URL.
Deployment compatibility has not been verified in this rewrite.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/` | Review console |
| GET | `/health` | Health, package name, and version |
| GET | `/queue?status=pending` | Queue list; status is optional |
| GET | `/item?id=ID` | Item and body |
| GET | `/audit?item=ID` | Audit entries; item is optional |
| POST | `/submit` | Files source, kind, title, and body |
| POST | `/edit` | Edits by id and actor; accepts title, body, note, and token |
| POST | `/decide` | Decides by id, actor, and decision; accepts reason and token |

## Delivery/behavior limits

- Approval changes queue status. It does not send messages, publish posts, execute tools, or resume another agent.
- Titles allow 200 characters; bodies allow 1,000,000 characters. Blank submit fields are rejected.
- Stores reject edits and decisions after an item leaves pending status.
- Dry-run edits and decisions check the gate and read the item, but do not enforce the store's pending-state check.
- Mutations, body writes, and audit writes are separate operations. A later failure can leave earlier writes in place.
- Local JSON storage has no cross-process locking. D1 decisions have no atomic pending-state update.
- Network adapters have a default 10-second request timeout and no retry loop.
- `OpenGate` checks only that the actor name is nonblank. Access does not bind the supplied actor to token identity.
- Queue reads and submissions do not pass through the reviewer gate.
- Worker memory is per isolate and disappears on replacement. Different isolates do not share a durable queue.
- Worker routes expose no dry-run option. The console provides no Access-token input or automatic token forwarding.
- Cost accounting is process-local, not a durable billing report. Separate CLI invocations do not share totals.

## Integration guides

### Local Node.js and CLI setup

Set `APPROVE_DATA_DIR` to change the default `.approve-data` directory.
The CLI and MCP server read existing environment variables; they do not load `.env` files automatically.
Export variables in your shell or use an environment loader before starting them.

Preview a draft before filing it:

```sh
agentic-approve submit --source writer --kind post --title 'Launch post' --body 'We ship Tuesday.' --dry-run
agentic-approve submit --source writer --kind post --title 'Launch post' --body 'We ship Tuesday.'
agentic-approve list --status pending
```

Copy the returned item id into these commands. Inspect the item before deciding.

```sh
agentic-approve show --id ID
agentic-approve approve --id ID --actor ruth --reason 'Ready' --dry-run
agentic-approve approve --id ID --actor ruth --reason 'Ready'
agentic-approve audit --id ID
agentic-approve costs
```

The audit output contains submit and approve entries for that id.
To review a file, replace `--body` with `--file examples/sample-post.md` from a source checkout.

### Cloudflare backend setup

Export each complete group to switch that backend for the CLI or MCP server.
Partial groups throw an error. D1 creates its tables and indexes on first use.
Create the database, bucket, credentials, and Access application through Cloudflare first.

| Backend | Required variables |
| --- | --- |
| D1 queue | `APPROVE_D1_ACCOUNT_ID`, `APPROVE_D1_DATABASE_ID`, `APPROVE_D1_API_TOKEN` |
| R2 bodies | `APPROVE_R2_ACCOUNT_ID`, `APPROVE_R2_BUCKET`, `APPROVE_R2_ACCESS_KEY_ID`, `APPROVE_R2_SECRET_ACCESS_KEY` |
| Access gate | `APPROVE_ACCESS_TEAM`, `APPROVE_ACCESS_AUD` |

Use a team domain such as `team.cloudflareaccess.com` for `APPROVE_ACCESS_TEAM`.
Supply a reviewer token with `--token`, `APPROVE_TOKEN`, or the MCP `token` argument.
For SDK calls, pass it in the edit or decision options.

- [Cloudflare D1 database setup](https://developers.cloudflare.com/d1/get-started/)
- [Cloudflare R2 S3 credentials and API setup](https://developers.cloudflare.com/r2/api/s3/api/)
- [Cloudflare Access token validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

## Status

Version 0.1.0 is an early release. APIs and storage formats may change before 1.0.
Use [GitHub issues](https://github.com/pooriaarab/agentic-approve/issues) for bugs and support.
Public case studies are not yet published in this repository.

### Contributing and release flow

Run the repository gates before pushing:

```sh
npm run build && npm run typecheck && npm test
```

Check the packaged CLI from a tarball:

```sh
npm pack
npx --yes --package ./agentic-approve-0.1.0.tgz agentic-approve --version
```

The publish workflow runs on `release` pushes or manual dispatch.
It publishes only when the current package version is absent from npm.
README updates reach npm through a later package publish.

### Repository layout

- `src/index.ts` exports the SDK; `src/cli.ts` implements terminal commands.
- `src/mcp.ts` defines tools; `src/mcp-bin.ts` starts the server.
- `src/worker.ts` contains the console and HTTP routes.
- `src/service.ts` defines queue operations; `src/store.ts` defines interfaces and memory stores.
- `src/local.ts`, `src/d1.ts`, and `src/r2.ts` implement storage adapters.
- `src/access.ts` checks Access tokens; `src/env.ts` selects backends.
- `agentic-core.d.ts` and `docs/agentic-core.md` describe the shared contract.
- `docs/onboarding.md` and `examples/sample-post.md` provide repository examples.

## FAQ

### What is agentic-approve?

agentic-approve is a text review queue for agent output. It records drafts, edits, reviewer decisions, and audit entries.

### Which integrations are verified?

agentic-approve has tests for local stores and mocked Cloudflare D1 and R2 calls. Access tests use locally generated signed tokens.
No live credential verification occurs in this rewrite.

### Does agentic-approve provide a managed approval service?

agentic-approve provides software you run yourself. Its Worker is self-hosted and stores its queue in isolate memory.

### How is agentic-approve different from LangGraph?

agentic-approve stores review items and decisions independently of agent execution.
[LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) pause graph execution and use caller input to resume it.

### How is agentic-approve different from Temporal?

agentic-approve exposes queue operations through its SDK, CLI, MCP server, and Worker.
[Temporal workflows](https://docs.temporal.io/workflows) manage durable workflow execution; application code defines the review process.

### Can agentic-approve work with Claude Code or Codex?

agentic-approve exposes a stdio MCP server and CLI that compatible clients can invoke.
It includes no client-specific connector; configure the client to start `agentic-approve mcp`.

### Does approval send or publish the draft?

agentic-approve changes the item's status and records the reviewer decision.
Your application must read approved items and perform any external action.

### Where does agentic-approve store data?

agentic-approve defaults to local files for CLI and MCP use, with optional D1 and R2 adapters.
Its Worker and the memory-backed SDK example lose data when their process or isolate is replaced.

### Does agentic-approve authenticate every request?

agentic-approve gates edits and decisions, while reads and submissions bypass that gate.
The default gate requires a name; the optional Access gate verifies a token without matching its identity to that name.

### Does agentic-approve load my .env file?

agentic-approve reads process environment variables without loading `.env` files.
Export those variables or load the file before starting the CLI or MCP server.

## License

MIT. See the [MIT license text](https://github.com/pooriaarab/agentic-approve/blob/main/LICENSE).
