import { EventEmitter } from 'node:events';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runSurvey, type EngineEvent, type RunReport } from '@verdant/survey-engine';
import type { RunRequest } from '../types.js';
import { resolveSheetData } from './sheet.js';

export type RunState = {
  runId: string;
  surveyUrl: string;
  status: 'queued' | 'running' | 'success' | 'blocked' | 'error';
  createdAt: string;
  updatedAt: string;
  report: RunReport | null;
  error: string | null;
};

// ...



export type RunEventEnvelope = {
  runId: string;
  event: EngineEvent;
};

export class RunController {
  private readonly runs = new Map<string, RunState>();
  private readonly emitter = new EventEmitter();

  constructor(private readonly artifactsRoot: string) { }

  onEvent(listener: (event: RunEventEnvelope) => void): void {
    this.emitter.on('event', listener);
  }

  offEvent(listener: (event: RunEventEnvelope) => void): void {
    this.emitter.off('event', listener);
  }

  getRun(runId: string): RunState | null {
    return this.runs.get(runId) ?? null;
  }

  listRuns(): RunState[] {
    return [...this.runs.values()].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
  }

  async startRun(input: RunRequest & { apiKey: string }): Promise<RunState> {
    const runId = randomUUID();
    const now = new Date().toISOString();

    const initial: RunState = {
      runId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      report: null,
      error: null
    };

    this.runs.set(runId, initial);

    const artifactsDir = path.join(this.artifactsRoot, 'runs', runId);
    await mkdir(artifactsDir, { recursive: true });

    void (async () => {
      this.patchRun(runId, { status: 'running' });

      try {
        const sheetData = await resolveSheetData({
          ...(input.sheetUrl ? { sheetUrl: input.sheetUrl } : {}),
          ...(input.csvContent ? { csvContent: input.csvContent } : {})
        });

        const report = await runSurvey({
          runId,
          surveyUrl: input.surveyUrl,
          instructions: input.instructions,
          strategy: input.strategy,
          ...(input.ruleset ? {
            ruleset: {
              ...(input.ruleset.singleSelect ? { singleSelect: input.ruleset.singleSelect } : {}),
              ...(input.ruleset.multiSelect ? {
                multiSelect: {
                  mode: input.ruleset.multiSelect.mode,
                  ...(input.ruleset.multiSelect.n ? { n: input.ruleset.multiSelect.n } : {})
                }
              } : {}),
              ...(input.ruleset.text ? {
                text: {
                  ...(input.ruleset.text.default ? { default: input.ruleset.text.default } : {}),
                  ...(input.ruleset.text.byKeyword ? { byKeyword: input.ruleset.text.byKeyword } : {})
                }
              } : {})
            }
          } : {}),
          speedMode: input.speedMode,
          captureScreenshots: input.captureScreenshots,
          recordVideo: input.recordVideo,
          completeSurvey: input.completeSurvey,
          sheetData,
          llm: {
            provider: input.provider,
            apiKey: input.apiKey,
            ...(input.model ? { model: input.model } : {})
          },
          ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
          verbose: input.verbose,
          artifactsDir,
          onEvent: (event) => {
            this.emitter.emit('event', { runId, event } satisfies RunEventEnvelope);

            // Persist logs to file
            const logLine = `[${event.ts}] ${event.type.toUpperCase()}: ${'message' in event ? event.message : JSON.stringify(event)}\n`;
            import('node:fs/promises').then(({ appendFile }) => {
              appendFile(path.join(artifactsDir, 'logs.txt'), logLine).catch(() => { });
            });
          }
        });

        this.patchRun(runId, {
          status: report.status,
          report,
          error: null
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown run error.';
        this.patchRun(runId, {
          status: 'error',
          error: message
        });
      }
    })();

    return initial;
  }

  private patchRun(runId: string, patch: Partial<RunState>): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }

    this.runs.set(runId, {
      ...run,
      ...patch,
      updatedAt: new Date().toISOString()
    });
  }
}
