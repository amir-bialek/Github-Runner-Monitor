# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Backend, in code/backend (Node 24):

```bash
npm ci
npm test                          # Jest, also runs code/debug-job/tests
npx jest tests/webhook.test.ts    # one test file
npx jest -t "test name"           # one test by name
npm run lint
```

Frontend, in code/frontend (Node 22):

```bash
npm ci
npx vitest run                    # npm test starts watch mode and never exits
npx vitest run src/App.test.tsx   # one test file
npm run typecheck
npm run dev                       # port 3000, forwards /api to BACKEND_URL or http://localhost:3001
```

Whole app with made-up data, at http://localhost:8080:

```bash
docker compose -f docker/docker-compose.yml up --build -d
```

Helm chart tests (needs helm 3 and the full git history):

```bash
bash helm/tests/chart-test.sh
```

The attack tests in helm/tests/attack run only in CI (.github/workflows/attack-tests.yml), on a kind cluster with repository secrets.

## Architecture

- Three parts: the backend (Express in TypeScript, run directly by tsx, imports use .ts extensions), the frontend (React 19, MUI, TanStack Query, Vite), and the Debug Job image in code/debug-job.
- The browser calls only /api/*. nginx (docker/nginx.conf) or the Vite dev server removes /api, so backend routes have no /api prefix.
- Jobs come from the GitHub organization webhook: src/routes/githubWebhook.ts feeds src/services/jobStore.ts, held in memory and saved to S3 by src/services/statePersistence.ts. Runners and scale sets are read from the GitHub API through src/services/githubClient.ts.
- USE_MOCK_DATA=true (the default) serves src/services/mockData.ts and runs Debug it through src/services/debugIt/demoLifecycle.ts, with no GitHub, Kubernetes or Anthropic call.
- Debug it (src/services/debugIt/, src/routes/debugIt*.ts): lifecycle.ts queues each run, creates one Kubernetes Job per run, sends it the failed job's log and code, and receives the result on a separate results port (src/routes/debugItResults.ts). Debug it stays off until the startup isolation check in isolation.ts passes.
- The Debug Job (code/debug-job/src) holds three programs: receiver.ts takes the log and code, keyHelper.ts is the only holder of the Anthropic key, and wrapper.ts checks network isolation and then runs Claude Code with only Read, Grep, Glob and Edit. The result format is code/debug-job/schema/result.v1.json. CI requires Claude Code 2.1.316 in the image.
- Lint rule: the GitHub, Kubernetes, AWS and Anthropic SDKs, and the api.anthropic.com host, may be used only in src/adapters/ (see code/backend/eslint.config.js).
- With Debug it off, the Helm chart must render exactly as the 1.x chart did; helm/tests/chart-test.sh compares against the 1.x commit.
- The safety rules SR1 to SR17 and the architecture decisions AD-n referenced in code comments are explained in docs/security-design.md.
- Every backend and frontend environment variable is listed in README.md under Configuration. Frontend values are written into config.js at container start by docker/docker-entrypoint.d/10-app-config.sh.

## Releasing

Every merge to main is a release, so every pull request must set a version X.Y.Z higher than main's, or PR Validate fails:

1. helm/chart/Chart.yaml: version and appVersion X.Y.Z.
2. helm/values-backend.yaml: tag backend-vX.Y.Z.
3. helm/values-frontend.yaml: tag frontend-vX.Y.Z.
4. CHANGELOG.md: a new ## X.Y.Z section at the top.
5. A new major version N only: screenshots in docs/images/vN.
