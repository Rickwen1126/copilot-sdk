# Repo Instructions

## Canonical Docs

- Read `README.md` first, then `docs/spec.md`, then `docs/todo.md`, then repo-specific docs, then `.progress/progress.md`.
- `docs/spec.md` is the canonical project entrypoint; it must link active todo, completed todo archive, and the runtime backend guide, or mark missing artifacts as P0 gaps.
- `docs/todo.md` is the only active todo list.
- `docs/todo-finished.md` is the archive for completed and superseded work.
- `.progress/progress.md` is continuity only, not canonical project state.

## Working Rules

- Keep runtime backend experiments behind adapter boundaries.
- Do not treat session continuity notes as the source of truth when canonical docs exist.
- Do not delete or rewrite historical work unless it has been migrated into the canonical docs.
