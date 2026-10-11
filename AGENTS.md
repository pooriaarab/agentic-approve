# agentic-approve agent guide

Review queue for agent output: edit, approve, reject, audit.

## Mental model

Tools file drafts. Reviewers edit, approve, or reject them. Each
step lands in the audit log. One queue serves all three faces, so
each face returns the same shape.

## The three faces

- SDK: `import { QueueService } from "agentic-approve"`.
- CLI: `npx agentic-approve submit --source "..." --kind "..." --title "..." --body "..."`.
- MCP: `npx agentic-approve mcp`, then call a tool below.

Keywords: approval, review-queue, agentic-suite, claude-code, codex, cli, mcp.

## MCP tools

| Tool | Use it for |
| --- | --- |
| approve_submit | File one item. Pass dryRun to preview. |
| approve_list | List items, oldest first. |
| approve_show | Show one item with its body. |
| approve_edit | Change a pending item. Pass dryRun to preview. |
| approve_approve | Approve a pending item. Pass dryRun to preview. |
| approve_reject | Reject a pending item. Pass dryRun to preview. |
| approve_audit | Read audit entries, oldest first. |
| get_cost_report | Read session cost totals. |

## The loop

1. Discover the tools with `tools/list`.
2. File with `approve_submit` and dryRun true.
3. File for real when the preview looks right.
4. Read the item back with `approve_show`.
5. Preview the decision with dryRun true.
6. Decide with `approve_approve` or `approve_reject`.
7. Read `approve_audit` and state what changed.

## Rules

- Preview with dry run before each file, edit, and decision.
- File from any source. Decide only as a named reviewer.
- Stop when a guard denies the call. State the reason.
- Never retry a denied call with changed text to dodge a guard.
- Report adapter errors as errors. Never present them as success.
- State the cost report before you claim the task is done.
