import type { Decision } from '@verdant/llm';
import type { Locator, Page } from 'playwright';
import { extractQuestionState, stateFingerprint, isValidSurveySurface } from '../extractor/question-state.js';
import type { QuestionState, SpeedMode } from '../types/index.js';

const NEXT_BUTTON = /\b(next|continue|ok|start)\b/i;
const SUBMIT_BUTTON = /\b(submit|send|finish|done|complete)\b/i;

const allContexts = (page: Page): Array<Page | import('playwright').Frame> => {
  return [page, ...page.frames()];
};

const clickIfVisibleInContexts = async (
  page: Page,
  finder: (context: Page | import('playwright').Frame) => Promise<Locator>
): Promise<boolean> => {
  for (const context of allContexts(page)) {
    const locator = await finder(context);
    const count = await locator.count();

    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (await target.isVisible()) {
        try {
          // Ensure we scroll into view before clicking
          await target.scrollIntoViewIfNeeded();
          console.debug(`[DEBUG] Clicking element: ${await target.innerHTML()}`);
          await target.click({ timeout: 2000 }); // Short timeout to fail fast if blocked
          return true;
        } catch (err) {
          // If click fails (e.g. detached), try next
          // console.warn('Click failed on visible element, trying next...', err);
        }
      }
    }
  }
  return false;
};

const clickOptionByLabel = async (page: Page, label: string): Promise<boolean> => {
  // prioritize semantic roles first to ensure we interact with the form element
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByRole('radio', { name: label, exact: true }))) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByRole('checkbox', { name: label, exact: true }))) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByRole('button', { name: label, exact: true }))) return true;

  // Try Label text (associated input)
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByLabel(label, { exact: true }))) return true;

  // Final fallback: exact text match (risky for short numbers, so last resort)
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByText(label, { exact: true }))) return true;

  return false;
};

const clickNavigation = async (page: Page, pattern: RegExp): Promise<boolean> => {
  // Support for data-qa attributes which are common in Typeform and other modern apps
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="ok"]`))) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="start"]`))) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="next"]`))) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="continue"]`))) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="submit"]`))) return true;

  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByRole('button', { name: pattern }))) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByText(pattern))) return true;
  return false;
};

const verifyTextFilled = async (page: Page, expectedText: string): Promise<boolean> => {
  for (const context of allContexts(page)) {
    const textbox = context.getByRole('textbox');
    const count = await textbox.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = textbox.nth(index);
      if (!(await candidate.isVisible())) {
        continue;
      }

      const value = await candidate.evaluate((node) => {
        const input = node as HTMLInputElement | HTMLTextAreaElement;
        return 'value' in input ? input.value : '';
      });

      if (value.includes(expectedText) || expectedText.includes(value)) {
        return true;
      }
    }
  }
  return false;
};

const waitForProgress = async (
  page: Page,
  before: QuestionState,
  speedMode: SpeedMode
): Promise<{ progressed: boolean; afterState: QuestionState }> => {
  const timeoutMs = speedMode === 'fast' ? 2000 : 5000; // Aggressive optimizations: 2s fast, 5s reliable
  const start = Date.now();
  const beforeFingerprint = stateFingerprint(before);

  while (Date.now() - start < timeoutMs) {
    await page.waitForLoadState('domcontentloaded');
    const state = await extractQuestionState(page);
    const afterFingerprint = stateFingerprint(state);

    // If state changed AND it's a valid survey surface, we are good.
    if (afterFingerprint !== beforeFingerprint) {
      if (isValidSurveySurface(state)) {
        return { progressed: true, afterState: state };
      }
      // DEBUG: Log that we are waiting for valid state
      // const elapsed = Date.now() - start;
      // if (elapsed > 2000 && elapsed % 2000 < 250) { // Log every ~2s
      //   console.log(`[INFO] State changed but invalid (loading?). Waiting... (${Math.round(elapsed / 1000)}s)`);
      // }
    }

    // If state changed but is INVALID (empty), we might be loading. Continue waiting.

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { progressed: false, afterState: await extractQuestionState(page) };
};

const checkAssertion = (assertion: string, state: QuestionState): boolean => {
  const haystack = `${state.questionText} ${state.supportText.join(' ')} ${state.options
    .filter((option) => option.selected)
    .map((option) => option.label)
    .join(' ')} ${state.filledValue}`.toLowerCase();

  return haystack.includes(assertion.toLowerCase());
};

export const executeDecision = async (input: {
  page: Page;
  beforeState: QuestionState;
  decision: Decision;
  speedMode: SpeedMode;
}): Promise<{
  actionSucceeded: boolean;
  progressed: boolean;
  afterState: QuestionState;
  assertionsPassed: string[];
  assertionsFailed: string[];
}> => {
  const { page, beforeState, decision, speedMode } = input;

  const perform = async (): Promise<boolean> => {
    if (decision.action === 'select_single') {
      const label = decision.selections[0]?.label;
      return label ? clickOptionByLabel(page, label) : false;
    }

    if (decision.action === 'select_multi') {
      if (decision.selections.length === 0) {
        return false;
      }

      let selectedAny = false;
      for (const selection of decision.selections) {
        const clicked = await clickOptionByLabel(page, selection.label);
        selectedAny = selectedAny || clicked;
      }
      return selectedAny;
    }

    if (decision.action === 'type_text') {
      // Find visible textbox in any context
      for (const context of allContexts(page)) {
        const textbox = context.getByRole('textbox').first();
        if (await textbox.count() > 0 && await textbox.isVisible()) {
          await textbox.fill(decision.text);
          return true;
        }
      }
      return false;
    }

    if (decision.action === 'click_next') {
      return clickNavigation(page, NEXT_BUTTON);
    }

    if (decision.action === 'click_submit') {
      return clickNavigation(page, SUBMIT_BUTTON);
    }

    return true;
  };

  let actionSucceeded = false;
  let attempt = 0;

  while (attempt < 2 && !actionSucceeded) {
    try {
      actionSucceeded = await perform();
      if (decision.action === 'type_text' && actionSucceeded) {
        actionSucceeded = await verifyTextFilled(page, decision.text);
      }
      if (!actionSucceeded && decision.action !== 'cannot_proceed') {
        attempt += 1;
        continue;
      }
    } catch {
      actionSucceeded = false;
    }
    attempt += 1;
  }

  const { progressed, afterState } = await waitForProgress(page, beforeState, speedMode);

  const assertionsPassed: string[] = [];
  const assertionsFailed: string[] = [];


  // Optimization: If the question text changed, satisfying the selection on the *new* question is impossible/irrelevant.
  // We assume that if the question changed, the action (selection) implicitly succeeded in triggering navigation.
  const questionChanged = beforeState.questionText !== afterState.questionText;

  if (!questionChanged) {
    for (const assertion of decision.assertions) {
      if (checkAssertion(assertion, afterState)) {
        assertionsPassed.push(assertion);
      } else {
        assertionsFailed.push(assertion);
      }
    }

    if (decision.action === 'select_single' || decision.action === 'select_multi') {
      const selectedLabels = afterState.options.filter((option) => option.selected).map((option) => option.label.toLowerCase());
      for (const selection of decision.selections) {
        if (!selectedLabels.includes(selection.label.toLowerCase())) {
          assertionsFailed.push(`Selection not reflected: ${selection.label}`);
        }
      }
    }

    if (decision.action === 'type_text' && decision.text && !afterState.filledValue.includes(decision.text)) {
      assertionsFailed.push('Typed text is not visible in the input.');
    }
  } else {
    // If we advanced, we treat it as a success for the previous action's intent (usually)
    assertionsPassed.push('Successfully navigated to next step.');
  }

  return {
    actionSucceeded,
    progressed,
    afterState,
    assertionsPassed,
    assertionsFailed
  };
};
