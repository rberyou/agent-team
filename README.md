# Agent Team

Event-driven multi-agent orchestration system that simulates a software development team. Seven AI agents collaborate through an EventBus to take a project from requirements to deployment, covering the full lifecycle: analysis, design, implementation, testing, and acceptance.

## Architecture

```
User (requirement / confirm / change)
  │
  ▼
API Gateway (Fastify + WebSocket)
  │
  ▼
EventBus (publish / subscribe / persist)
  │
  ├── PM Agent           — orchestrator, phase gating, task assignment
  ├── Product Designer   — requirement analysis, PRD authoring
  ├── UI Designer        — UI layout & style guide (conditional)
  ├── Developer Engineer — architecture, sub-agent management, integration
  │   └── SubAgent × N   — parallel module implementation
  ├── Code Reviewer      — code quality & architecture compliance review
  ├── QA Engineer        — test case design, execution, bug reporting
  └── DevOps             — env config (testing) + deployment plan (acceptance)
  │
  ▼
File System Persistence (.agent-team/projects/{id}/)
  ├── events/      event log (JSONL, append-only)
  ├── tasks/       task state
  ├── artifacts/   phase outputs (PRD, design, code, tests, deployment)
  └── output/      extracted source files for preview
```

## Requirements

- Node.js >= 20
- An OpenAI-compatible LLM API (e.g. MiniMax). Without LLM config the system still runs using built-in fallback templates.

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env   # then edit LLM_BASE_URL, LLM_API_KEY, LLM_MODEL

# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

The server starts at `http://localhost:3000` by default.

## Configuration

All configuration is via environment variables (or `.env` file):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `localhost` | Bind address |
| `DATA_DIR` | `.agent-team` | Data directory for projects and events |
| `LOG_LEVEL` | `info` | Log level (trace/debug/info/warn/error/fatal) |
| `LLM_BASE_URL` | — | OpenAI-compatible API base URL |
| `LLM_API_KEY` | — | API key |
| `LLM_MODEL` | — | Model name |
| `LLM_TEMPERATURE` | `0.7` | Sampling temperature |
| `LLM_MAX_TOKENS` | `4096` | Max output tokens |
| `LLM_TIMEOUT_MS` | `60000` | Request timeout (ms) |
| `LLM_MAX_RETRIES` | `3` | Retry count on failure |

## Usage

### 1. Submit a requirement

```bash
curl -X POST http://localhost:3000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"requirement":"Build a counter page with + and - buttons","projectName":"counter"}'
```

### 2. Monitor progress

Open the dashboard at `http://localhost:3000` — tasks are grouped by phase with real-time WebSocket updates.

### 3. Confirm phase gates

Each phase gate (PRD review, design review, test review, acceptance trial, deployment review) requires user confirmation:

```bash
curl -X POST http://localhost:3000/api/projects/{projectId}/confirm \
  -H 'Content-Type: application/json' \
  -d '{"confirmationType":"prd_review","taskId":"task_xxx"}'
```

Confirmation types in order: `prd_review` → `design_review` → `test_review` → `acceptance_trial` → `deployment_review`.

### 4. Preview generated code

After implementation completes, source files are extracted to the output directory and served at:

```
http://localhost:3000/preview/{projectId}/
```

## API Reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/projects` | Create project from requirement |
| `GET` | `/api/projects` | List all projects |
| `GET` | `/api/projects/:id` | Project details |
| `GET` | `/api/projects/:id/tasks` | List tasks |
| `GET` | `/api/projects/:id/events` | Event timeline |
| `POST` | `/api/projects/:id/confirm` | Confirm phase gate |
| `POST` | `/api/projects/:id/reject` | Reject with feedback |
| `GET` | `/api/projects/:id/artifacts/:phase/:filename` | Get artifact |
| `GET` | `/preview/:projectId/*` | Serve generated files |
| `GET` | `/` | Dashboard UI |

## Development

```bash
npm run type-check   # TypeScript type checking
npm test             # Run tests (vitest)
npm run test:watch   # Watch mode
npm run test:coverage # Coverage report
```

## Project Structure

```
src/
├── main.ts              entry point
├── config.ts            env-based configuration (zod validation)
├── container.ts         dependency injection & bootstrap
├── api/
│   ├── server.ts        Fastify routes + static preview serving
│   └── dashboard.ts     HTML dashboard with WebSocket updates
├── agents/
│   ├── base-agent.ts    abstract base (subscribe/publish helpers)
│   ├── pm/              PM Agent — orchestration & phase gating
│   ├── product-designer/ PRD generation
│   ├── ui-designer/     UI design (conditional activation)
│   ├── developer/       Developer + SubAgent parallel implementation
│   ├── code-reviewer/   Code review
│   ├── qa/              Testing & acceptance
│   └── devops/          Environment config & deployment
└── core/
    ├── event-bus.ts      publish/subscribe with file persistence
    ├── types.ts          shared type definitions
    ├── llm/              LLM service (OpenAI-compatible)
    └── persistence/
        ├── file-store.ts  file I/O abstraction
        └── stores.ts      ProjectStore, TaskStore, ArtifactStore
```

## License

MIT
