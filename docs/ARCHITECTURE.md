# ARCHITECTURE

## Monorepo Layout
```
/apps
  /ui            React + Vite + Tailwind UI
  /runner        Express API + WebSocket + run control
/packages
  /llm           Provider-agnostic LLM adapter (OpenAI, Anthropic)
  /survey-engine Playwright survey executor
/docs
```

## Runtime Flow
1. UI submits run configuration to `POST /api/runs`.
2. Runner resolves optional Google Sheet/CSV data.
3. Runner starts survey engine with provider + strategy config.
4. Survey engine:
   - opens survey in headless Chromium,
   - extracts question state (accessibility-first),
   - asks LLM for next action,
   - validates JSON via Zod,
   - executes action and assertions,
   - streams logs/decisions/artifacts.
5. Runner persists `report.json` and exposes artifacts under `/artifacts`.
6. UI receives live WebSocket events and polls final run status.

## Key Components
- `apps/runner/src/lib/key-vault.ts`: AES-256-GCM encryption-at-rest for API keys.
- `apps/runner/src/lib/sheet.ts`: Google Sheet URL parsing and CSV key/value extraction.
- `packages/llm/src/client.ts`: Provider abstraction + strict decision parsing.
- `packages/survey-engine/src/extractor/question-state.ts`: Dynamic question/input extraction.
- `packages/survey-engine/src/run-survey.ts`: Step loop, retries, assertions, screenshots, reporting.

## Artifacts
- `artifacts/runs/<run-id>/report.json`
- `artifacts/runs/<run-id>/screenshots/*.png` (when enabled or requested)
