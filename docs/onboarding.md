# Onboarding: your first review in five minutes

This guide takes you from install to a decided item. You need
Node.js 18 or later. No keys and no network calls are required.

## 1. Install

```sh
npm install -g agentic-approve
agentic-approve --version
```

The version prints `0.1.0`.

## 2. File one item

```sh
agentic-approve submit --source notes --kind post --title "Launch post" --body "We ship Tuesday."
```

The command prints the filed item as JSON. Note its `id`.
Filing stays open: any tool can file, with no reviewer name.

## 3. Read it back

```sh
agentic-approve list --status pending
agentic-approve show --id <id>
```

`list` prints items oldest first. `show` prints one item
with its full body.

## 4. Edit it

```sh
APPROVE_ACTOR=ruth agentic-approve edit --id <id> --title "Launch post v2"
```

Edits need a reviewer name. Set it with `--actor` or with
`APPROVE_ACTOR`. Add `--dry-run` to preview without saving.

## 5. Decide it

```sh
APPROVE_ACTOR=ruth agentic-approve approve --id <id> --reason "Ships Tuesday."
```

Use `reject` with a reason to send an item back. Preview
first with `--dry-run`. A decided item cannot change again.

## 6. Read the audit log

```sh
agentic-approve audit --id <id>
```

Each entry names the action, the actor, and the time. The
log proves who filed, edited, and decided each item.

## 7. Pick a face

- CLI: you just used it. Run `agentic-approve --help`.
- SDK: `import { QueueService } from "agentic-approve"`.
- MCP: run `agentic-approve mcp`, then call `approve_submit`.
- Worker: run `npx wrangler deploy`, then open `/`.

## 8. Move past local files

Local files back the queue by default in `.approve-data`.
Set `APPROVE_DATA_DIR` to move the dir. Set the D1 group to
move the queue, the R2 group to move the bodies, and the
Access group to gate decisions. See `README.md`.
