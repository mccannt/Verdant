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
  action: 'select_single | select_multi | type_text | click_next | click_submit | cannot_proceed | set_slider | set_date | select_matrix',
  selections: [{ label: 'string' }],
  text: 'string (numeric value for set_slider, ISO-8601 date YYYY-MM-DD for set_date)',
  matrixSelections: [{ rowLabel: 'string', columnLabel: 'string' }],
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
      'If inputType is unknown but options are listed, treat it as single_select and pick the best option.',
      'If inputType is unknown with no options but navigationButtons are present, use click_next or click_submit.',
      'Set cannot_proceed only when no safe action exists and no navigation is possible.',
      'For slider questions (inputType=slider): use set_slider and put the chosen number as a string in the text field. Pick a value between sliderMin and sliderMax that best suits the instructions.',
      'For date-picker questions (inputType=date_picker): use set_date and put an ISO-8601 date string (YYYY-MM-DD) in the text field.',
      'For matrix questions (inputType=matrix): use select_matrix and list one { rowLabel, columnLabel } pair per row from matrixRows. Every row must have a selection.'
    ]
  };

  return JSON.stringify(payload, null, 2);
};
