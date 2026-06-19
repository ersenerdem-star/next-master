# Quote Desk Next MVP

This is a clean, separate rebuild workspace for the next-generation Quote Desk application.

## Goals

- keep the current `ersen-quote-desk` untouched
- build a production-ready modular MVP in parallel
- migrate feature-by-feature

## First run

```bash
cd /Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp
npm install
npm run dev
```

## Workspace

- `apps/web` -> React frontend
- `supabase` -> migrations and functions
- `docs` -> architecture and planning docs

## Core architecture

- See `docs/core-architecture.md` for the module tree and protocol chain.
- See `docs/core-guardian.md` for the fail-closed core protection rules.

## Repo hygiene

- Source files must stay in `apps/web/src`, `netlify/functions`, `supabase/migrations`, and `scripts`.
- Generated run outputs stay local and ignored. Summarize durable findings in Markdown instead of committing raw batch CSV/JSON files.
- Run `npm run predeploy:verify` before production deploys.
- See `docs/repo-hygiene-protocol.md` for the full boundary and RTL/workbench rules.
