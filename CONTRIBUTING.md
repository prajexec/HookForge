# Contributing to HookForge

## Workflow

Create a focused branch from the current default branch. Keep each meaningful,
tested feature in its own commit using Conventional Commits, for example
`feat(events): persist idempotent events`. Do not push automatically from local
development.

## Code conventions

- Use strict TypeScript and explicit SQL migrations.
- Keep API, worker, web, and shared code in their workspace boundaries.
- Validate external input at the boundary and parameterize SQL.
- Do not log secrets, authorization headers, signing secrets, or payloads by
  default.
- Prefer small modules with tests for failure behavior.

## Required checks

Before opening a pull request, run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Update the relevant architecture, API, security, operations, and changelog
documentation with each feature. Do not add unimplemented routes to docs.
