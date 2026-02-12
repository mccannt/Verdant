# PROMPTS

## System Prompt (Static)
Used for every step. It enforces:
- no invented options,
- visible labels only,
- strategy/instruction compliance,
- JSON-only output.

Source: `packages/survey-engine/src/prompts.ts` (`SYSTEM_PROMPT`).

## Step Prompt (Dynamic)
Built per survey step from:
- user instructions,
- strategy/ruleset,
- Google Sheet dictionary,
- extracted question state,
- strict output schema description.

Source: `packages/survey-engine/src/prompts.ts` (`buildStepPrompt`).

## Output Schema
Validated with Zod before execution:
```json
{
  "action": "select_single | select_multi | type_text | click_next | click_submit | cannot_proceed",
  "selections": [{ "label": "string" }],
  "text": "string",
  "confidence": 0.0,
  "reason": "string",
  "needs_screenshot": true,
  "assertions": ["string"]
}
```

## Auditing
Every run stores step state, model decision, assertion outcomes, and artifacts in `report.json` so decisions are fully reviewable.
