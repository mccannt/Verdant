export type Provider = 'openai' | 'anthropic' | 'google' | 'deepseek';

export type RunPayload = {
  surveyUrl: string;
  sheetUrl?: string;
  csvContent?: string;
  instructions: string;
  strategy: 'first' | 'last' | 'random' | 'ruleset';
  ruleset?: unknown;
  speedMode: 'fast' | 'reliable';
  captureScreenshots: boolean;
  completeSurvey: boolean;
  provider: Provider;
  model?: string;
  apiKey?: string;
  maxSteps?: number;
  recordVideo?: boolean;
  verbose?: boolean;
  runId?: string;
  sheetData?: Record<string, string>;
};

export type RunState = {
  runId: string;
  surveyUrl: string;
  status: 'queued' | 'running' | 'success' | 'blocked' | 'error';
  createdAt: string;
  updatedAt: string;
  report: any | null;
  error: string | null;
};

const parseJson = async (response: Response) => {
  const json =
    response.status === 204
      ? {}
      : await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((json as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  return json;
};

export const api = {
  health: async () => parseJson(await fetch('/api/health')),
  listKeys: async () => parseJson(await fetch('/api/keys')),
  saveKey: async (provider: Provider, apiKey: string) =>
    parseJson(
      await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey })
      })
    ),
  deleteKey: async (provider: Provider) =>
    parseJson(
      await fetch(`/api/keys/${provider}`, {
        method: 'DELETE'
      })
    ),
  resolveSheet: async (input: { sheetUrl?: string; csvContent?: string }) =>
    parseJson(
      await fetch('/api/sheet/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      })
    ),
  startRun: async (payload: RunPayload) =>
    parseJson(
      await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
    ),
  getRun: async (runId: string) => parseJson(await fetch(`/api/runs/${runId}`))
};
