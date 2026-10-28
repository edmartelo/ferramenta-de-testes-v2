# CLAUDE.md

Guidance for Claude Code in this repository.

## What this repo is

Config-driven QA framework (Node.js + TypeScript + Playwright + Vue/Vite UI) that tests **other
projects**: promotional-campaign sites (site + WhatsApp bot + admin panel) built by different
agencies. Each promotion is configured in the web UI (MySQL) with its URLs and local source paths
(`PromotionConfig.paths`); specs test via browser/URL, never by running that source directly.

The old checklist suite and Monday sync pipeline were removed (2026-09-23) and the suite is being
rebuilt. Don't recreate `knowledge-base/checklist/` or `src/reporting/` unless asked.

## Rules for the tested projects (`paths.frontend` / `paths.backend`)

- `git pull` on `dev` is allowed anytime. Discard local changes (`git checkout -- .`) if they block
  the pull, then re-apply the local test setup (e.g. front `endpoint_uri` pointing at local backend).
- Local-only changes for testing are fine (`.env`, `APP_KEY`, migrations, disabling reCAPTCHA).
- **Never commit or push in these projects.** Real code changes only via a PR, and only when the
  user explicitly asks.
- reCAPTCHA: on homolog the front check is skipped (`disableFrontRecaptcha`); production validates
  it, so `MANUAL_IN_PRODUCTION` tests are excluded there.

## Commands

```bash
npm install && npx playwright install
npm run dev                                   # web UI, port 15173

PROMO=<slug> npm test                         # full suite for a promotion
PROMO=<slug> npm test -- --grep "3\."         # filter
PROMO=<slug> npm run test:headed              # Playwright UI mode
npx playwright test tests/_lib/               # pure unit tests, no PROMO

npx tsc --noEmit                              # typecheck Node side + server/
npx vue-tsc --noEmit -p tsconfig.web.json     # typecheck browser side
```

`PROMO` must match a promotion `id` in MySQL; specs fail loudly otherwise (by design). Run both
typechecks when touching shared code: `tsconfig.json` covers Node files (`server/`, `src/fixtures`,
`src/lib`, `knowledge-base/`, `promotions/`, `tests/`, `scripts/`), `tsconfig.web.json` covers the Vue
app (`src/main.ts`, `App.vue`, `components/`, `views/`, `composables/`…).

## Architecture

- **Database**: one MySQL on Aiven (`db()`, `src/lib/db.ts`, `SHARED_DB_*` required, no Docker) for
  every machine: users, sessions, promotions, test_runs, logs (`server/logs.ts`, status and counts
  only), Aprendizado corrections (`atendimento_labels`, masked). Other Atendimento data never goes to the DB. Per-machine
  files: embeddings (`.ollama-embeddings.json`), Ollama answer cache (`.ollama-cache.json`,
  unmasked participant text), last Atendimento summary per promotion (`.atendimentos/_resumos.json`,
  shown on the home dashboard), Recorrências schedule (`.recurrences-schedule.json`,
  each user enables automation locally). `npm run dev` writes to the DB every 5 min so the Aiven
  Free plan doesn't power it off (`server/aiven-power.ts`). Users' TOTP secrets, and passwords,
  tokens and TOTP keys in `.connectors.json` / `.credentials.json`, are AES-GCM encrypted with
  `TOTP_ENCRYPTION_KEY` (`src/lib/secret-box.ts`); Testers get promotion credentials hidden. Schema
  changes go only as a new step at the end of `MIGRATIONS` in `db.ts` (version in
  `settings.schema_version`); never edit an applied step. Ollama must stay on loopback (`OLLAMA_URL`
  is validated). `server/local-housekeeping.ts` hourly: encrypts old secret files, archives promotions
  deleted elsewhere (without credentials/sessions), deletes `.atendimentos/*.json` older than 30 days.
- **Promotions**: MySQL `promotions` table, accessed via `promotions/index.ts`. Credentials never in
  the DB: they live in `promotions/<slug>/.credentials.json` (gitignored), read by
  `src/lib/promotion-credentials.ts`. `paths` are per machine too, in `.local-paths.json` there.
- **Agencies**: `knowledge-base/agencies/*.ts`, informational only (they don't select tests). The
  profiles in this repo are fictitious examples; copy `_template.ts` for a real one.
- **Specs**: `tests/<NN-group>/`, global for every promotion; groups listed in
  `knowledge-base/test-groups.ts`. A test whose form field is missing becomes N/A (manual review)
  via `requireField`/`fieldExists` (`src/lib/form-fields.ts`). Folders starting with `_` never run
  in a suite: `_lib` (unit), `_setup` (panel login, Recorrências, Atendimentos), `_mass-registration`.
- **Web UI**: Vue app in `src/`; API is a Vite plugin (`server/promotions-api.ts`), no separate
  backend; the full tool runs locally. `server/test-runner.ts` runs groups **one Playwright process per group, in sequence**
  (don't move this to `playwright.config.ts` dependencies). Job engine and locks in
  `server/playwright-jobs.ts` (kept in `globalThis`, survive Vite restarts): only one Playwright job
  at a time (409 otherwise); Atendimentos scans (`server/atendimentos-scan.ts`) run 2 at a time in a
  server queue, Ollama summaries 1 at a time.
- **Recorrências / Atendimentos**: scan promotion panels in **production**. The Atendimentos scan
  must stay strictly read-only: `src/lib/read-only-guard.ts` blocks non-GET requests (except login),
  hover-only reads, pinned by `tests/_lib/read-only-guard.spec.ts`. **Never loosen it.** The guard
  applies only to these tools, not to the test suite.
- **Atendimento summary**: classified by a **local** Ollama (`qwen3:14b` + `nomic-embed-text`);
  participant data never goes to external LLMs. User corrections live in the DB, already masked
  (`server/atendimento-labels.ts`); a leftover `.atendimento-labels.json` is imported once and renamed `.imported`.
  Grave = participant/coupon registration failing with no later registration, or the same doubt
  from 3+ participants; everything the SAC solves is "externo". WhatsApp gets Crítico + Alta only.
- **WhatsApp**: sends go through the local WhatsApp MCP app (`src/lib/whatsapp.ts`), never
  automatic except the scheduled Recorrências run (`server/recurrences-schedule.ts`, Windows
  `npm run dev` only).
- **Slack/Monday**: OAuth secrets in root `.env`; Slack send always via user-confirmed modal.
- **Demo**: `vite.demo.config.ts` (`npm run dev:demo`) swaps `src/api.ts` for `src/demo/api.ts`
  (fictitious data, fake runner in the browser) and the login for `src/demo/DemoLoginView.vue`. Only
  signup/login (`server/demo/accounts.ts`) touch a DB: a separate demo database with a
  least-privileged user, created by `npm run demo:setup` (writes the gitignored `.env.demo`). Keep the
  demo server free of `src/lib/db.ts`/`SHARED_DB_*` (pinned by `tests/_lib/demo.spec.ts`).

## Code style

- Specs and `src/lib/*-flow.ts`: no comments unless a non-obvious constraint needs one line.
- Prefer `getByRole` / `data-testid`; screenshots only for purely visual checks.
- Projects: desktop + mobile Chrome only.
- Scope reruns with `--grep`; report once at the end.
