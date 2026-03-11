import { z } from 'zod';

export type LlmProvider = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'groq' | 'openrouter' | 'xai';

export const PROVIDER_MODELS: Record<LlmProvider, string[]> = {
  openai: ['gpt-5.2', 'gpt-5.1-high', 'gpt-4.5-preview', 'gpt-4o', 'o3-mini'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite'],
  anthropic: ['claude-4-6-opus-latest', 'claude-4-5-sonnet-latest', 'claude-3-7-opus-latest'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  openrouter: ['openai/gpt-5.2', 'anthropic/claude-4.6-opus', 'google/gemini-3.0-pro'],
  xai: ['grok-3-latest', 'grok-2-latest'],
  deepseek: ['deepseek-v3', 'deepseek-coder-v2']
};

export const decisionActionSchema = z.enum([
  'select_single',
  'select_multi',
  'type_text',
  'click_next',
  'click_submit',
  'cannot_proceed',
  'set_slider',    // Set a range input to a numeric value (value goes in `text` field)
  'set_date',      // Fill a date input with an ISO-8601 date string (goes in `text` field)
  'select_matrix'  // Select one cell per matrix row (uses `matrixSelections` field)
]);

export const decisionSchema = z.object({
  action: decisionActionSchema,
  selections: z.array(z.object({ label: z.string().min(1) })).default([]),
  text: z.string().nullable().transform((v) => v ?? '').default(''),
  confidence: z.number().transform((v) => (v > 1 ? v / 100 : v)).pipe(z.number().min(0).max(1)),
  reason: z.string().min(1),
  needs_screenshot: z.boolean().default(false),
  assertions: z.array(z.string()).default([]),
  // Used only for select_matrix: one { rowLabel, columnLabel } pair per row
  matrixSelections: z
    .array(z.object({ rowLabel: z.string(), columnLabel: z.string() }))
    .optional()
    .default([])
});

export type Decision = z.infer<typeof decisionSchema>;

export type LlmDecisionRequest = {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
};
