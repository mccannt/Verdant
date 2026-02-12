import type { Decision, LlmProvider } from '@verdant/llm';

export type AnswerStrategy = 'first' | 'last' | 'random' | 'ruleset';
export type SpeedMode = 'fast' | 'reliable';

export type RulesetConfig = {
  singleSelect?: 'first' | 'last' | 'random';
  multiSelect?: { mode: 'first_n' | 'all' | 'random_n'; n?: number };
  text?: {
    default?: string;
    byKeyword?: Record<string, string>;
  };
};

export type SurveyOption = {
  label: string;
  selected: boolean;
};

export type QuestionState = {
  questionText: string;
  supportText: string[];
  inputType: 'single_select' | 'multi_select' | 'text' | 'yes_no' | 'unknown';
  options: SurveyOption[];
  filledValue: string;
  navigationButtons: string[];
  progress: string | null;
  visibleInputCount: number;
  url: string;
};

export type StepArtifact = {
  type: 'screenshot';
  path: string;
};

export type StepResult = {
  step: number;
  state: QuestionState;
  decision: Decision;
  actionSucceeded: boolean;
  progressed: boolean;
  assertionsPassed: string[];
  assertionsFailed: string[];
  artifacts: StepArtifact[];
};

export type RunStatus = 'success' | 'blocked' | 'error' | 'running';

export type RunReport = {
  runId: string;
  surveyUrl: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepResult[];
  video?: string;
  message: string;
  artifactsDir: string;
};

export type EngineEvent =
  | {
    type: 'log';
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    step?: number;
    ts: string;
  }
  | {
    type: 'state';
    step: number;
    state: QuestionState;
    ts: string;
  }
  | {
    type: 'decision';
    step: number;
    decision: Decision;
    ts: string;
  }
  | {
    type: 'artifact';
    step: number;
    artifact: StepArtifact;
    ts: string;
  }
  | {
    type: 'status';
    status: RunStatus;
    message: string;
    ts: string;
  };

export type RunSurveyInput = {
  runId: string;
  surveyUrl: string;
  instructions: string;
  strategy: AnswerStrategy;
  speedMode: SpeedMode;
  captureScreenshots: boolean;
  recordVideo?: boolean;
  completeSurvey: boolean;
  verbose?: boolean;
  ruleset?: RulesetConfig;
  sheetData?: Record<string, string>;
  llm: {
    provider: LlmProvider;
    apiKey: string;
    model?: string;
  };
  artifactsDir: string;
  maxSteps?: number;
  onEvent?: (event: EngineEvent) => void;
};
