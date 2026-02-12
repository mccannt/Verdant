import type { AnswerStrategy, QuestionState, RulesetConfig } from './types/index.js';

export const SYSTEM_PROMPT = `You are an automated QA agent controlling a browser to validate and complete a web-based survey.

You receive structured information about the current survey step.
You must decide what action to take next.

Rules:
- Never invent options.
- Use visible labels only.
- Follow the provided answer strategy and instructions exactly.
- Prefer deterministic choices unless instructed otherwise.

Return ONLY valid JSON matching the provided schema.`;

const schemaDoc = {
  action: 'select_single | select_multi | type_text | click_next | click_submit | cannot_proceed',
  selections: [{ label: 'string' }],
  text: 'string',
  confidence: 0,
  reason: 'string',
  needs_screenshot: true,
  assertions: ['string']
};

export const buildStepPrompt = (input: {
  instructions: string;
  strategy: AnswerStrategy;
  ruleset?: RulesetConfig;
  sheetData?: Record<string, string>;
  state: QuestionState;
}) => {
  const payload = {
    testInstructions: input.instructions,
    strategy: input.strategy,
    ruleset: input.ruleset ?? null,
    sheetData: input.sheetData ?? {},
    questionState: input.state,
    outputSchema: schemaDoc,
    requirements: [
      'Use only options from questionState.options.',
      'If the question is already answered and Next/Submit is available, prefer click_next or click_submit.',
      'When inputType is text, type useful deterministic text based on instructions/ruleset/sheetData.',
      'Set cannot_proceed only when no safe action exists.'
    ]
  };

  return JSON.stringify(payload, null, 2);
};
