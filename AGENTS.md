# AGENTS.md

## CI handoff — 2026-10-05
- Quality workflow keeps `main`, `feature/chatgpt-agent-bridge`, and manual triggers.
- Duplicate `pull_request` trigger removed because feature pushes already run the same checks.
- Added concurrency cancellation for stale runs on the same ref.
