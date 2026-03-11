import type { Decision } from '@verdant/llm';
import type { Locator, Page } from 'playwright';
import { extractQuestionState, stateFingerprint, isValidSurveySurface, type ContextRef } from '../extractor/question-state.js';
import type { QuestionState, SpeedMode } from '../types/index.js';

const NEXT_BUTTON = /\b(next|continue|ok|start)\b/i;
const SUBMIT_BUTTON = /\b(submit|send|finish|done|complete)\b/i;

const allContexts = (page: Page, contextRef?: ContextRef): Array<Page | import('playwright').Frame> => {
  if (contextRef && contextRef.value !== page) {
    // Cached frame first — avoids redundant main-page attempts on every element lookup
    const cached = contextRef.value;
    return [cached, page, ...page.frames().filter((f) => f !== cached)];
  }
  return [page, ...page.frames()];
};

const clickIfVisibleInContexts = async (
  page: Page,
  finder: (context: Page | import('playwright').Frame) => Promise<Locator>,
  contextRef?: ContextRef
): Promise<boolean> => {
  for (const context of allContexts(page, contextRef)) {
    const locator = await finder(context);
    const count = await locator.count();

    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (await target.isVisible()) {
        try {
          // Ensure we scroll into view before clicking
          await target.scrollIntoViewIfNeeded();
          console.debug(`[DEBUG] Clicking element: ${await target.innerHTML()}`);
          await target.click({ timeout: 100 }); // Fail fast so next locator strategy can try
          return true;
        } catch (err) {
          // If click fails (e.g. detached), try next
          console.warn(`[WARN] Click failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        }
      }
    }
  }
  return false;
};

// Selector for the currently focused question block. Typeform (and similar platforms) pre-render
// adjacent questions in the DOM; the focused selector scopes clicks to the ACTIVE question only,
// preventing clicks from landing on covered pre-rendered content that would be silently swallowed.
const FOCUSED_BLOCK = '[data-qa-focused="true"]';

const clickOptionByLabel = async (page: Page, label: string, contextRef?: ContextRef): Promise<boolean> => {
  // ── Force-click strategy (highest priority) ──────────────────────────────────────────────────
  // Use Element.checkVisibility({opacityProperty:true}) to detect ancestor opacity — Typeform
  // pre-renders adjacent questions inside opacity:0 parent containers, making the elements
  // invisible even though their own opacity:1. Both isVisible() and getComputedStyle(el).opacity
  // only check the element itself, not ancestors. checkVisibility walks the full ancestor chain.
  // force:true bypasses Playwright's "receives events" check (overlay blocks actionability)
  // while still dispatching a trusted CDP mouse event.
  for (const ctx of allContexts(page, contextRef)) {
    for (const role of ['radio', 'checkbox'] as const) {
      const locator = ctx.getByRole(role, { name: label, exact: true });
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const target = locator.nth(i);
        try {
          const actuallyVisible = await target.evaluate((el) => {
            if ('checkVisibility' in el) {
              return (el as Element & { checkVisibility: (opts?: object) => boolean }).checkVisibility({ opacityProperty: true, visibilityProperty: true });
            }
            // Fallback: walk ancestor opacity chain
            for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
              if (parseFloat(getComputedStyle(n).opacity) < 0.05) return false;
            }
            return true;
          });
          if (!actuallyVisible) continue;
          console.debug(`[FORCE] role=${role} label=${label} i=${i}`);
          await target.click({ force: true, timeout: 3000 });
          return true;
        } catch (err) {
          console.warn(`[FORCE] ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        }
      }
    }
  }

  // ── Keyboard Space fallback ───────────────────────────────────────────────────────────────────
  // Pressing Space on a focused <button role="radio"> fires a trusted click in some browsers.
  // Used as fallback after force-click in case force-click hits the wrong coordinate.
  for (const ctx of allContexts(page, contextRef)) {
    for (const role of ['radio', 'checkbox'] as const) {
      const locator = ctx.getByRole(role, { name: label, exact: true });
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const target = locator.nth(i);
        try {
          const actuallyVisible = await target.evaluate((el) => {
            if ('checkVisibility' in el) {
              return (el as Element & { checkVisibility: (opts?: object) => boolean }).checkVisibility({ opacityProperty: true, visibilityProperty: true });
            }
            for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
              if (parseFloat(getComputedStyle(n).opacity) < 0.05) return false;
            }
            return true;
          });
          if (!actuallyVisible) continue;
          console.debug(`[PRESS] role=${role} label=${label} i=${i}`);
          await target.press('Space', { timeout: 3000 });
          return true;
        } catch (err) {
          console.warn(`[PRESS] ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        }
      }
    }
  }

  // ── Focused-block Playwright strategies ────────────────────────────────────────────────────
  // Secondary approach: scope Playwright locators to the active question block so we don't
  // accidentally resolve to a pre-loaded question whose buttons are covered.
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(FOCUSED_BLOCK).getByRole('radio', { name: label, exact: true }), contextRef)) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(FOCUSED_BLOCK).getByRole('checkbox', { name: label, exact: true }), contextRef)) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(FOCUSED_BLOCK).getByText(label, { exact: true }), contextRef)) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(FOCUSED_BLOCK).getByRole('button', { name: label, exact: true }), contextRef)) return true;

  // ── Global fallback strategies (for platforms without focused-block markup) ─────────────────
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByRole('radio', { name: label, exact: true }), contextRef)) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByRole('checkbox', { name: label, exact: true }), contextRef)) return true;

  // Exact text match before button role — catches custom elements (e.g. Typeform rating spans)
  // that report as role=button but aren't truly clickable via that strategy, saving 100ms wasted timeout
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByText(label, { exact: true }), contextRef)) return true;

  // Try Label text (associated input)
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByLabel(label, { exact: true }), contextRef)) return true;

  // Last resort: button role (can waste 100ms timeout on non-actionable elements)
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByRole('button', { name: label, exact: true }), contextRef)) return true;

  // ── Dropdown fallback (native <select> / combobox / open listbox) ────────────────────────────
  if (await clickOptionViaDropdown(page, label, contextRef)) return true;

  return false;
};

// ── Dropdown / Select interaction ─────────────────────────────────────────────────────────────────
// Handles three patterns:
//   1. Native <select> — uses Playwright selectOption (most reliable)
//   2. Open [role="listbox"] — options already visible, click the matching [role="option"]
//   3. Closed [role="combobox"] — click the trigger to expand, then click the option
const clickOptionViaDropdown = async (page: Page, label: string, contextRef?: ContextRef): Promise<boolean> => {
  // Strategy 1: Native <select>
  for (const ctx of allContexts(page, contextRef)) {
    const selects = ctx.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      try {
        if (!(await sel.isVisible())) continue;
        await sel.selectOption({ label }, { timeout: 2000 });
        return true;
      } catch { /* try next */ }
    }
  }

  // Strategy 2: [role="option"] already visible (listbox already open)
  for (const ctx of allContexts(page, contextRef)) {
    const opts = ctx.getByRole('option', { name: label, exact: true });
    const count = await opts.count();
    for (let i = 0; i < count; i++) {
      const target = opts.nth(i);
      try {
        const actuallyVisible = await target.evaluate((el) => {
          if ('checkVisibility' in el) {
            return (el as Element & { checkVisibility: (opts?: object) => boolean }).checkVisibility({ opacityProperty: true, visibilityProperty: true });
          }
          for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
            if (parseFloat(getComputedStyle(n).opacity) < 0.05) return false;
          }
          return true;
        });
        if (!actuallyVisible) continue;
        await target.click({ force: true, timeout: 2000 });
        return true;
      } catch { /* continue */ }
    }
  }

  // Strategy 3: Click [role="combobox"] trigger to open, then click the option
  for (const ctx of allContexts(page, contextRef)) {
    const combos = ctx.locator('[role="combobox"]');
    const count = await combos.count();
    for (let i = 0; i < count; i++) {
      const combo = combos.nth(i);
      try {
        if (!(await combo.isVisible())) continue;
        await combo.click({ timeout: 2000 });
        // Wait briefly for listbox to expand
        await new Promise<void>((resolve) => setTimeout(resolve, 400));
        const opt = ctx.getByRole('option', { name: label, exact: true }).first();
        if (await opt.count() > 0 && await opt.isVisible()) {
          await opt.click({ timeout: 2000 });
          return true;
        }
      } catch { /* continue */ }
    }
  }

  return false;
};

// ── Matrix cell selection ──────────────────────────────────────────────────────────────────────────
// Finds the radiogroup/fieldset whose legend matches rowLabel, then clicks the radio with columnLabel.
const clickMatrixCell = async (
  page: Page,
  rowLabel: string,
  columnLabel: string,
  contextRef?: ContextRef
): Promise<boolean> => {
  for (const ctx of allContexts(page, contextRef)) {
    const groups = ctx.locator('[role="radiogroup"], fieldset');
    const count = await groups.count();
    for (let i = 0; i < count; i++) {
      const group = groups.nth(i);
      const legend = group.locator('legend, [role="legend"]').first();
      const legendText = ((await legend.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      if (!legendText.toLowerCase().includes(rowLabel.toLowerCase())) continue;
      const radio = group.getByRole('radio', { name: columnLabel, exact: true });
      if (await radio.count() > 0 && await radio.isVisible()) {
        try {
          await radio.click({ force: true, timeout: 2000 });
          return true;
        } catch { /* try next group */ }
      }
    }
  }
  return false;
};

const clickNavigation = async (page: Page, pattern: RegExp, contextRef?: ContextRef): Promise<boolean> => {
  // Semantic role match works for most survey platforms
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByRole('button', { name: pattern }), contextRef)) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.getByText(pattern), contextRef)) return true;

  // Fall back to data-qa attributes (Typeform native interface on typeform.com)
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="ok"]`), contextRef)) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="start"]`), contextRef)) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="next"]`), contextRef)) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="continue"]`), contextRef)) return true;
  if (await clickIfVisibleInContexts(page, async (ctx) => ctx.locator(`[data-qa*="submit"]`), contextRef)) return true;

  return false;
};

const verifyTextFilled = async (page: Page, expectedText: string, contextRef?: ContextRef): Promise<boolean> => {
  for (const context of allContexts(page, contextRef)) {
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
  speedMode: SpeedMode,
  contextRef?: ContextRef
): Promise<{ progressed: boolean; afterState: QuestionState }> => {
  const timeoutMs = speedMode === 'fast' ? 4000 : 8000;
  // How long to wait for Typeform's auto-advance after an option is clicked. Typeform typically
  // fires within ~970ms. We wait 1300ms before giving up and returning to let the runner
  // re-evaluate (handles final questions that need an explicit Submit click, not auto-advance).
  const AUTO_ADVANCE_WAIT_MS = 1300;
  const start = Date.now();
  const beforeFingerprint = stateFingerprint(before);
  let fingerprintChangedAt: number | null = null;

  while (Date.now() - start < timeoutMs) {
    const state = await extractQuestionState(page, contextRef);
    if (stateFingerprint(state) !== beforeFingerprint && isValidSurveySurface(state)) {
      // If the question identity hasn't changed (same text + support text), this is Typeform
      // registering an option click — NOT a page advance. Keep polling until the auto-advance
      // timer fires and the actual question changes. This guards against surveys where many
      // questions share the same header text (e.g. Typeform rating groups).
      const sameQuestion =
        state.questionText === before.questionText &&
        state.supportText.join('\n') === before.supportText.join('\n');
      if (sameQuestion) {
        // Start timing from when we first detected the fingerprint change.
        if (fingerprintChangedAt === null) fingerprintChangedAt = Date.now();
        // If Typeform hasn't auto-advanced within the expected window, this is likely the final
        // question which needs an explicit Submit click. Return early so the runner can
        // re-evaluate and have the LLM click Submit.
        if (Date.now() - fingerprintChangedAt > AUTO_ADVANCE_WAIT_MS) {
          return { progressed: false, afterState: state };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        continue;
      }
      // Question changed — settle briefly so React finishes mounting the new question's
      // options before we return (especially important at high CDP playback rates).
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      const settledState = await extractQuestionState(page, contextRef);
      return { progressed: true, afterState: settledState };
    }
    // Reset the timer if the fingerprint reverted (e.g. Typeform deselected the option)
    fingerprintChangedAt = null;
    await page.waitForLoadState('domcontentloaded');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  return { progressed: false, afterState: await extractQuestionState(page, contextRef) };
};



export const executeDecision = async (input: {
  page: Page;
  beforeState: QuestionState;
  decision: Decision;
  speedMode: SpeedMode;
  contextRef?: ContextRef;
}): Promise<{
  actionSucceeded: boolean;
  progressed: boolean;
  afterState: QuestionState;
  assertionsPassed: string[];
  assertionsFailed: string[];
}> => {
  const { page, beforeState, decision, speedMode, contextRef } = input;

  const perform = async (): Promise<boolean> => {
    if (decision.action === 'select_single') {
      const label = decision.selections[0]?.label;
      return label ? clickOptionByLabel(page, label, contextRef) : false;
    }

    if (decision.action === 'select_multi') {
      if (decision.selections.length === 0) {
        return false;
      }

      let selectedAny = false;
      for (const selection of decision.selections) {
        const clicked = await clickOptionByLabel(page, selection.label, contextRef);
        selectedAny = selectedAny || clicked;
      }
      return selectedAny;
    }

    if (decision.action === 'type_text') {
      // Find visible textbox in any context
      for (const context of allContexts(page, contextRef)) {
        const textbox = context.getByRole('textbox').first();
        if (await textbox.count() > 0 && await textbox.isVisible()) {
          await textbox.fill(decision.text);
          return true;
        }
      }
      return false;
    }

    if (decision.action === 'click_next') {
      return clickNavigation(page, NEXT_BUTTON, contextRef);
    }

    if (decision.action === 'click_submit') {
      return clickNavigation(page, SUBMIT_BUTTON, contextRef);
    }

    if (decision.action === 'set_slider') {
      const numericValue = parseFloat(decision.text);
      if (isNaN(numericValue)) return false;
      for (const ctx of allContexts(page, contextRef)) {
        const slider = ctx.locator('input[type="range"], [role="slider"]').first();
        if (await slider.count() > 0 && await slider.isVisible()) {
          try {
            await slider.fill(String(numericValue));
            await slider.evaluate((el) => {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            });
            return true;
          } catch { /* try next context */ }
        }
      }
      return false;
    }

    if (decision.action === 'set_date') {
      const dateStr = decision.text;
      if (!dateStr) return false;
      for (const ctx of allContexts(page, contextRef)) {
        const datePicker = ctx.locator('input[type="date"], input[type="datetime-local"]').first();
        if (await datePicker.count() > 0 && await datePicker.isVisible()) {
          try {
            await datePicker.fill(dateStr);
            return true;
          } catch { /* try next context */ }
        }
      }
      return false;
    }

    if (decision.action === 'select_matrix') {
      if (!decision.matrixSelections?.length) return false;
      let anyClicked = false;
      for (const cell of decision.matrixSelections) {
        const ok = await clickMatrixCell(page, cell.rowLabel, cell.columnLabel, contextRef);
        anyClicked = anyClicked || ok;
      }
      return anyClicked;
    }

    return true;
  };

  let actionSucceeded = false;
  let attempt = 0;

  while (attempt < 2 && !actionSucceeded) {
    try {
      actionSucceeded = await perform();
      if (decision.action === 'type_text' && actionSucceeded) {
        actionSucceeded = await verifyTextFilled(page, decision.text, contextRef);
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

  const { progressed, afterState } = await waitForProgress(page, beforeState, speedMode, contextRef);

  const assertionsPassed: string[] = [];
  const assertionsFailed: string[] = [];


  // Optimization: If the question identity changed, satisfying the selection on the *new* question is impossible/irrelevant.
  // We compare both questionText AND supportText so that surveys where many questions share a common
  // header (e.g. Typeform rating groups) are still recognised as having advanced to a new question.
  const questionChanged =
    beforeState.questionText !== afterState.questionText ||
    beforeState.supportText.join('\n') !== afterState.supportText.join('\n');

  if (!questionChanged) {
    // Generic assertions from LLM are often natural language and fail naive substring checks.
    // We skip iterating decision.assertions to avoid false negatives.
    // Instead, we rely on the specific action verifications below (selection/typing).

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
