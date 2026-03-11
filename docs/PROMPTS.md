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
  "action": "select_single | select_multi | type_text | click_next | click_submit | cannot_proceed | set_slider | set_date | select_matrix",
  "selections": [{ "label": "string" }],
  "text": "string (numeric value for set_slider, ISO-8601 date YYYY-MM-DD for set_date)",
  "matrixSelections": [{ "rowLabel": "string", "columnLabel": "string" }],
  "confidence": 0.0,
  "reason": "string",
  "needs_screenshot": true,
  "assertions": ["string"]
}
```

### Action reference

| Action | When used | Key fields |
|--------|-----------|------------|
| `select_single` | Radio buttons, yes/no, button grids | `selections[0].label` |
| `select_multi` | Checkboxes | `selections[].label` |
| `type_text` | Text, email, number, tel inputs | `text` |
| `click_next` | Navigation (Next / Continue / OK) | — |
| `click_submit` | Final submission | — |
| `set_slider` | Range inputs / NPS sliders | `text` — numeric string within `[sliderMin, sliderMax]` |
| `set_date` | Date / datetime-local inputs | `text` — ISO-8601 date (`YYYY-MM-DD`) |
| `select_matrix` | Likert-scale batteries (multiple radio rows) | `matrixSelections[].rowLabel` + `columnLabel` |
| `cannot_proceed` | No actionable UI found | — |

## Auditing
Every run stores step state, model decision, assertion outcomes, and artifacts in `report.json` so decisions are fully reviewable.
