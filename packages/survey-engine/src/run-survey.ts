import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requestLlmDecision, type Decision } from '@verdant/llm';
import { chromium } from 'playwright';
import { extractQuestionState, isValidSurveySurface, stateFingerprint } from './extractor/question-state.js';
import { executeDecision } from './executor/actions.js';
import { SYSTEM_PROMPT, buildStepPrompt } from './prompts.js';
import { chooseTextByRuleset, deterministicSelection } from './strategy.js';
import type { EngineEvent, QuestionState, RunReport, RunStatus, RunSurveyInput, StepArtifact, StepResult } from './types/index.js';

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

const emit = (input: RunSurveyInput, event: DistributiveOmit<EngineEvent, 'ts'>): void => {
  if (event.type === 'log' && event.level === 'debug' && !input.verbose) {
    return;
  }
  input.onEvent?.({ ...event, ts: new Date().toISOString() } as EngineEvent);
};

const ensureDir = async (target: string): Promise<void> => {
  await mkdir(target, { recursive: true });
};

const captureScreenshot = async (
  page: import('playwright').Page,
  artifactsDir: string,
  label: string,
  step: number
): Promise<StepArtifact> => {
  const screenshotsDir = path.join(artifactsDir, 'screenshots');
  await ensureDir(screenshotsDir);
  const filename = `step-${String(step).padStart(2, '0')}-${label}.png`;
  const absolutePath = path.join(screenshotsDir, filename);
  await page.screenshot({ path: absolutePath, fullPage: true });
  return { type: 'screenshot', path: absolutePath };
};

const fallbackDecision = (input: {
  runId: string;
  state: QuestionState;
  strategy: RunSurveyInput['strategy'];
  ruleset: RunSurveyInput['ruleset'];
}): Decision => {
  const { state } = input;

  if (state.inputType === 'text') {
    return {
      action: 'type_text',
      selections: [],
      text: chooseTextByRuleset(state, input.ruleset),
      confidence: 0.35,
      reason: 'Fallback strategy: typing deterministic text.',
      needs_screenshot: false,
      assertions: []
    };
  }

  if (state.inputType === 'single_select' || state.inputType === 'yes_no') {
    const selections = deterministicSelection(state, input.strategy, input.ruleset, input.runId)
      .slice(0, 1)
      .map((label) => ({ label }));

    if (selections.length > 0) {
      return {
        action: 'select_single',
        selections,
        text: '',
        confidence: 0.35,
        reason: 'Fallback strategy: choosing deterministic single option.',
        needs_screenshot: false,
        assertions: []
      };
    }
  }

  if (state.inputType === 'multi_select') {
    const selections = deterministicSelection(state, input.strategy, input.ruleset, input.runId).map((label) => ({ label }));

    if (selections.length > 0) {
      return {
        action: 'select_multi',
        selections,
        text: '',
        confidence: 0.35,
        reason: 'Fallback strategy: choosing deterministic multi options.',
        needs_screenshot: false,
        assertions: []
      };
    }
  }

  if (state.navigationButtons.length > 0) {
    const hasSubmit = state.navigationButtons.some((button) => /submit|finish|done|complete/i.test(button));
    return {
      action: hasSubmit ? 'click_submit' : 'click_next',
      selections: [],
      text: '',
      confidence: 0.3,
      reason: 'Fallback strategy: continue navigation.',
      needs_screenshot: false,
      assertions: []
    };
  }

  return {
    action: 'cannot_proceed',
    selections: [],
    text: '',
    confidence: 0.2,
    reason: 'Fallback strategy: no actionable UI.',
    needs_screenshot: true,
    assertions: []
  };
};

const isCompletionLikely = (state: QuestionState): boolean => {
  const text = `${state.questionText} ${state.supportText.join(' ')}`.toLowerCase();

  // Strictly require confirmation text to mark as success
  // Avoid single words like 'complete' which might appear in "questions to complete"
  if (/thank you|thanks|submitted|successfully|start again/.test(text)) {
    return true;
  }

  // Check for "completed" (past tense) but carefully
  if (/\b(completed|finished)\b/.test(text)) {
    return true;
  }

  // Do not assume success just because input is empty.
  // If no inputs are found but no success text is present, we should eventually stall (blocked)
  // rather than falsely reporting success.
  return false;
};

const writeReport = async (report: RunReport): Promise<void> => {
  await ensureDir(report.artifactsDir);
  await writeFile(path.join(report.artifactsDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
};

const finalReport = async (input: {
  status: RunStatus;
  message: string;
  startedAt: Date;
  run: RunSurveyInput;
  steps: StepResult[];
  video?: string;
}): Promise<RunReport> => {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - input.startedAt.getTime();
  const stepCount = input.steps.length;
  const avgStepTime = stepCount > 0 ? Math.round(durationMs / stepCount) : 0;

  const report: RunReport = {
    runId: input.run.runId,
    surveyUrl: input.run.surveyUrl,
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    steps: input.steps,
    message: input.message,
    artifactsDir: input.run.artifactsDir,
    ...(input.video ? { video: input.video } : {})
  };

  await writeReport(report);

  // Log a comprehensive summary similar to Playwright reporters
  const summary = [
    `\n📊 === Run Summary ===`,
    `Status:      ${input.status.toUpperCase()}`,
    `Total Time:  ${(durationMs / 1000).toFixed(2)}s`,
    `Total Steps: ${stepCount}`,
    `Avg/Step:    ${avgStepTime}ms`,
    `Outcome:     ${input.message}`,
    `Report:      ${path.join(input.run.artifactsDir, 'report.json')}`,
    `=====================\n`
  ].join('\n');

  emit(input.run, { type: 'log', level: 'info', message: summary });
  emit(input.run, { type: 'status', status: input.status, message: input.message });
  return report;
};

export const runSurvey = async (run: RunSurveyInput): Promise<RunReport> => {
  const startedAt = new Date();
  const maxSteps = run.maxSteps ?? 40;
  const steps: StepResult[] = [];
  let status: RunStatus = 'success';
  let message = 'Survey run completed.';

  await ensureDir(run.artifactsDir);

  const browser = await chromium.launch({ headless: true });

  const videoDir = path.join(run.artifactsDir, 'video');
  const context = await browser.newContext(
    run.recordVideo
      ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } }
      : {}
  );
  const page = await context.newPage();

  try {
    emit(run, { type: 'log', level: 'info', message: `Opening survey: ${run.surveyUrl}` });
    await page.goto(run.surveyUrl, {
      waitUntil: 'domcontentloaded',
      timeout: run.speedMode === 'fast' ? 8000 : 15000
    });

    // Retry extraction for up to 10 seconds to allow iframes/dynamic content to load
    let initialState = await extractQuestionState(page);
    let retries = 0;
    const maxRetries = 10;

    while (!isValidSurveySurface(initialState) && retries < maxRetries) {
      emit(run, { type: 'log', level: 'debug', message: `State extraction check ${retries + 1}/${maxRetries}: No valid surface found. Retrying in 1s...` });
      await new Promise(resolve => setTimeout(resolve, 1000));
      initialState = await extractQuestionState(page);
      retries++;
    }

    emit(run, {
      type: 'log',
      level: 'debug',
      message: `Initial Raw State (after ${retries} retries): ${JSON.stringify(initialState, null, 2)}`
    });

    if (!isValidSurveySurface(initialState)) {
      status = 'blocked';
      message = 'Survey page loaded but no visible question/input was detected.';
      if (run.captureScreenshots) {
        await captureScreenshot(page, run.artifactsDir, 'invalid-surface', 0);
      }
      // Should stop here, loop won't run because of check below?
      // Or we can just set maxSteps to 0 effectively?
      // Simplest is to wrap loop in if.
    } else {
      let stagnantSteps = 0;

      for (let step = 1; step <= maxSteps; step += 1) {
        const state = await extractQuestionState(page);
        emit(run, { type: 'state', step, state });
        emit(run, {
          type: 'log',
          level: 'info',
          step,
          message: `Step ${step}: ${state.questionText} (${state.inputType})`
        });

        // Emit intermediate status update for UI
        emit(run, {
          type: 'status',
          status: 'running',
          message: `Step ${step}: Analyzing question...`
        });

        emit(run, {
          type: 'log',
          level: 'debug',
          step,
          message: `Raw State: ${JSON.stringify(state, null, 2)}`
        });

        // 1. Check for explicit completion text BEFORE asking LLM
        if (isCompletionLikely(state)) {
          status = 'success';
          message = 'Survey appears complete (detected completion text).';
          break;
        }

        // 2. Check for functionality drift
        try {
          const currentUrl = new URL(state.url);
          const originalUrl = new URL(run.surveyUrl);

          const isKnownSurveyProvider = (hostname: string) => {
            return /typeform\.com|surveymonkey\.com|qualtrics\.com|google\.com\/forms|forms\.gle/.test(hostname);
          };

          if (currentUrl.hostname !== originalUrl.hostname) {
            if (isKnownSurveyProvider(currentUrl.hostname)) {
              emit(run, { type: 'log', level: 'debug', message: `Allowed redirect to survey provider: ${currentUrl.hostname}` });
            } else {
              if (step > 1) {
                status = 'success';
                message = `Survey exited to external domain: ${currentUrl.hostname}`;
                break;
              }
            }
          }
        } catch (e: any) {
          // Ignore URL parsing errors
        }

        const stepPrompt = buildStepPrompt({
          instructions: run.instructions,
          strategy: run.strategy,
          ...(run.ruleset ? { ruleset: run.ruleset } : {}),
          ...(run.sheetData ? { sheetData: run.sheetData } : {}),
          state
        });

        emit(run, {
          type: 'log',
          level: 'debug',
          step,
          message: `LLM Prompt:\n${stepPrompt}`
        });

        let decision: Decision;
        try {
          decision = await requestLlmDecision({
            provider: run.llm.provider,
            apiKey: run.llm.apiKey,
            ...(run.llm.model ? { model: run.llm.model } : {}),
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: stepPrompt,
            timeoutMs: run.speedMode === 'fast' ? 12000 : 20000
          });
        } catch (error) {
          emit(run, {
            type: 'log',
            level: 'warn',
            step,
            message: `LLM decision failed, falling back to strategy engine: ${error instanceof Error ? error.message : 'unknown error'}`
          });
          decision = fallbackDecision({
            runId: run.runId,
            state,
            strategy: run.strategy,
            ruleset: run.ruleset
          });
        }

        emit(run, { type: 'decision', step, decision });
        emit(run, {
          type: 'log',
          level: 'debug',
          step,
          message: `LLM Decision:\n${JSON.stringify(decision, null, 2)}`
        });

        const artifacts: StepArtifact[] = [];
        if (run.captureScreenshots || decision.needs_screenshot) {
          const artifact = await captureScreenshot(page, run.artifactsDir, 'pre-action', step);
          artifacts.push(artifact);
          emit(run, { type: 'artifact', step, artifact });
        }

        if (!run.completeSurvey && step > 1) {
          status = 'success';
          message = 'Stopped before completion because completeSurvey=false.';
          break;
        }

        if (decision.action === 'cannot_proceed') {
          status = 'blocked';
          message = `LLM reported cannot_proceed at step ${step}.`;

          if (!run.captureScreenshots) {
            const artifact = await captureScreenshot(page, run.artifactsDir, 'cannot-proceed', step);
            artifacts.push(artifact);
            emit(run, { type: 'artifact', step, artifact });
          }

          steps.push({
            step,
            state,
            decision,
            actionSucceeded: false,
            progressed: false,
            assertionsPassed: [],
            assertionsFailed: ['Cannot proceed.'],
            artifacts
          });
          break;
        }


        const beforeFingerprint = stateFingerprint(state);
        const execution = await executeDecision({
          page,
          beforeState: state,
          decision,
          speedMode: run.speedMode
        });

        // Emit status for action execution
        emit(run, {
          type: 'status',
          status: 'running',
          message: `Step ${step}: Executing ${decision.action}...`
        });

        const afterFingerprint = stateFingerprint(execution.afterState);
        let progressed = execution.progressed || afterFingerprint !== beforeFingerprint;

        // CRITICAL: If assertions failed, we consider this "not progressed" to prevent infinite loops of failing actions
        if (execution.assertionsFailed.length > 0) {
          progressed = false;
          emit(run, {
            type: 'log',
            level: 'warn',
            step,
            message: `Assertions failed, marking step as stagnant: ${execution.assertionsFailed.join('; ')}`
          });
        }

        if (!progressed) {
          stagnantSteps += 1;
        } else {
          stagnantSteps = 0;
        }

        const stepResult: StepResult = {
          step,
          state,
          decision,
          actionSucceeded: execution.actionSucceeded,
          progressed,
          assertionsPassed: execution.assertionsPassed,
          assertionsFailed: execution.assertionsFailed,
          artifacts
        };

        steps.push(stepResult);

        if (!execution.actionSucceeded) {
          emit(run, {
            type: 'log',
            level: 'warn',
            step,
            message: `Action did not succeed for ${decision.action}.`
          });
        }

        if (execution.assertionsFailed.length > 0) {
          emit(run, {
            type: 'log',
            level: 'warn',
            step,
            message: `Assertions failed: ${execution.assertionsFailed.join('; ')}`
          });
        }

        if (decision.action === 'click_submit' && (isCompletionLikely(execution.afterState) || !progressed)) {
          status = 'success';
          message = 'Survey submission step executed.';
          break;
        }

        if (isCompletionLikely(execution.afterState)) {
          status = 'success';
          message = 'Survey appears complete.';
          break;
        }

        if (stagnantSteps >= 2) {
          status = 'blocked';
          message = 'Runner cannot progress after repeated attempts.';
          if (!run.captureScreenshots) {
            const artifact = await captureScreenshot(page, run.artifactsDir, 'stagnant', step);
            stepResult.artifacts.push(artifact);
            emit(run, { type: 'artifact', step, artifact });
          }
          break;
        }

        if (step === maxSteps) {
          status = 'blocked';
          message = `Stopped after reaching maxSteps (${maxSteps}).`;
        }
      }
    }
  } catch (error) {
    status = 'error';
    message = error instanceof Error ? error.message : 'Unexpected runner error.';

    emit(run, { type: 'log', level: 'error', message });
    if (run.captureScreenshots) {
      try {
        const artifact = await captureScreenshot(page, run.artifactsDir, 'fatal', steps.length + 1);
        emit(run, { type: 'artifact', step: steps.length + 1, artifact });
      } catch {
        // ignore
      }
    }
  }

  // Cleanup & Video Processing
  let videoPath: string | undefined;

  try {
    await context.close();
    await browser.close();

    // Handle Video Rename
    if (run.recordVideo) {
      const { readdir, rename } = await import('node:fs/promises');
      const videoDir = path.join(run.artifactsDir, 'video');
      const files = await readdir(videoDir);
      const videoFile = files.find(f => f.endsWith('.webm'));

      if (videoFile) {
        const oldPath = path.join(videoDir, videoFile);
        const newPath = path.join(videoDir, 'recording.webm');
        await rename(oldPath, newPath);
        videoPath = 'video/recording.webm';
      }
    }
  } catch (err) {
    emit(run, { type: 'log', level: 'warn', message: 'Failed to process video recording.' });
  }

  return finalReport({
    status,
    message,
    startedAt,
    run,
    steps,
    ...(videoPath ? { video: videoPath } : {})
  });
};
