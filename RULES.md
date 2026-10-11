# agentic-approve rules

These rules bind every run of agentic-approve. They also bind
agents that drive this pack over MCP.

1. Preview before you act. Run each file, edit, and decision with dry run first.
2. Respect guards. A denied call stays denied.
3. Report failures as failures. Adapters throw, and callers surface
   the error. No silent success follows a failed call.
4. Count the cost. Read the cost report before you close a task.
5. Keep quiet hours. The pack refuses routes inside the window.

Pack: Review queue for agent output: edit, approve, reject, audit. Keywords: approval, review-queue, agentic-suite, claude-code, codex, cli, mcp.
