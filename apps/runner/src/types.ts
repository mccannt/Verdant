import { z } from 'zod';

export const providerSchema = z.enum(['openai', 'anthropic', 'google', 'deepseek', 'groq', 'openrouter', 'xai']);
export const strategySchema = z.enum(['first', 'last', 'random', 'ruleset']);
export const speedModeSchema = z.enum(['fast', 'reliable']);

export const rulesetSchema = z
  .object({
    singleSelect: z.enum(['first', 'last', 'random']).optional(),
    multiSelect: z
      .object({
        mode: z.enum(['first_n', 'all', 'random_n']),
        n: z.number().int().min(1).max(10).optional()
      })
      .optional(),
    text: z
      .object({
        default: z.string().optional(),
        byKeyword: z.record(z.string()).optional()
      })
      .optional()
  })
  .optional();

export const resolveSheetRequestSchema = z.object({
  sheetUrl: z.string().url().optional(),
  csvContent: z.string().optional()
});

export const saveKeyRequestSchema = z.object({
  provider: providerSchema,
  apiKey: z.string().min(8)
});

export const runRequestSchema = z.object({
  surveyUrl: z.string().url(),
  sheetUrl: z.string().url().optional(),
  csvContent: z.string().optional(),
  instructions: z.string().min(1),
  strategy: strategySchema,
  ruleset: rulesetSchema,
  speedMode: speedModeSchema,
  captureScreenshots: z.boolean().default(false),
  recordVideo: z.boolean().default(false),
  completeSurvey: z.boolean().default(true),
  provider: providerSchema,
  model: z.string().optional(),
  apiKey: z.string().min(8).optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
  verbose: z.boolean().default(false),
  runId: z.string().uuid().optional(),
  sheetData: z.record(z.string()).optional()
});

export type RunRequest = z.infer<typeof runRequestSchema>;
