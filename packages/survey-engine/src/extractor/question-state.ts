import type { Locator, Page } from 'playwright';
import type { QuestionState, SurveyOption } from '../types/index.js';

const NAVIGATION_LABEL = /\b(next|continue|ok|submit|done|finish|start|send|complete|previous|back)\b/i;

const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();

const elementLabel = async (locator: Locator): Promise<string> => {
  try {
    const aria = clean(await locator.getAttribute('aria-label'));
    if (aria) {
      return aria;
    }

    const labelledBy = await locator.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = await locator.page().evaluate((idList) => {
        for (const id of idList.split(/\s+/)) {
          const node = document.getElementById(id);
          if (node?.textContent?.trim()) {
            return node.textContent;
          }
        }
        return '';
      }, labelledBy);
      const normalized = clean(label);
      if (normalized) {
        return normalized;
      }
    }

    const text = await locator.evaluate((node) => (node.textContent ?? '').trim());
    return clean(text);
  } catch {
    return '';
  }
};

const visibleLabelsForRole = async (page: Page | import('playwright').Frame, role: 'heading' | 'button'): Promise<string[]> => {
  const items = await page.getByRole(role).all();
  const labels: string[] = [];

  for (const item of items) {
    try {
      if (!(await item.isVisible())) {
        continue;
      }
      const label = await elementLabel(item);
      if (label) {
        labels.push(label);
      }
    } catch {
      // Ignore fallback
    }
  }

  return labels;
};

const readOptionsFromRole = async (
  page: Page | import('playwright').Frame,
  role: 'radio' | 'checkbox',
  existing: Map<string, SurveyOption>
): Promise<void> => {
  const items = await page.getByRole(role).all();

  for (const item of items) {
    try {
      if (!(await item.isVisible())) {
        continue;
      }

      const label = await elementLabel(item);
      if (!label) {
        continue;
      }

      const selected = await item.evaluate((node) => {
        const input = node as HTMLInputElement;
        const ariaChecked = node.getAttribute('aria-checked');
        if (typeof input.checked === 'boolean' && input.checked) {
          return true;
        }
        if (ariaChecked === 'true') {
          return true;
        }
        // Check for class-based selection on parent/wrapper
        let parent = node.parentElement;
        while (parent && parent !== document.body) {
          if (
            parent.classList.contains('checked') ||
            parent.classList.contains('selected') ||
            parent.classList.contains('active') ||
            parent.classList.contains('is-selected') ||
            parent.classList.contains('is-active') ||
            parent.classList.contains('choice--selected') ||
            parent.getAttribute('data-selected') === 'true' ||
            parent.getAttribute('aria-checked') === 'true'
          ) {
            return true;
          }
          // Don't go too far up
          if (parent.tagName === 'FORM' || parent.getAttribute('role') === 'group') break;
          parent = parent.parentElement;
        }

        return false;
      });

      existing.set(label, { label, selected });
    } catch (err) {
      // Ignore individual element errors to prevent crashing the whole extraction
    }
  }
};

const readOptionButtons = async (page: Page | import('playwright').Frame, existing: Map<string, SurveyOption>): Promise<void> => {
  const buttons = await page.getByRole('button').all();

  for (const item of buttons) {
    try {
      if (!(await item.isVisible())) {
        continue;
      }

      const label = await elementLabel(item);
      if (!label || NAVIGATION_LABEL.test(label)) {
        continue;
      }

      const selected = await item.evaluate((node) => {
        const ariaPressed = node.getAttribute('aria-pressed');
        const ariaSelected = node.getAttribute('aria-selected');
        return ariaPressed === 'true' || ariaSelected === 'true' || node.classList.contains('selected') || node.classList.contains('active');
      });

      if (!existing.has(label)) {
        existing.set(label, { label, selected });
      }
    } catch {
      // Ignore
    }
  }
};

const detectProgress = async (page: Page | import('playwright').Frame): Promise<string | null> => {
  const progressbars = await page.getByRole('progressbar').all();

  for (const item of progressbars) {
    try {
      if (!(await item.isVisible())) {
        continue;
      }
      const label = await elementLabel(item);
      if (label) {
        return label;
      }
    } catch {
      // Ignore
    }
  }

  const maybeProgressText = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const percent = text.match(/\b\d{1,3}%\b/);
    if (percent) {
      return percent[0];
    }
    const steps = text.match(/\b\d+\s+of\s+\d+\b/i);
    return steps?.[0] ?? '';
  });

  return clean(maybeProgressText) || null;
};

const readFilledText = async (page: Page | import('playwright').Frame): Promise<string> => {
  const textboxes = await page.getByRole('textbox').all();

  for (const item of textboxes) {
    try {
      if (!(await item.isVisible())) {
        continue;
      }

      const value = await item.evaluate((node) => {
        const input = node as HTMLInputElement | HTMLTextAreaElement;
        if ('value' in input) {
          return input.value;
        }
        return '';
      });

      if (clean(value)) {
        return clean(value);
      }
    } catch {
      // Ignore
    }
  }

  return '';
};

export const extractQuestionState = async (context: Page | import('playwright').Frame): Promise<QuestionState> => {
  // Helper to extract state from a given context (page or frame)
  const extractFromContext = async (target: Page | import('playwright').Frame): Promise<QuestionState> => {
    const headings = await visibleLabelsForRole(target, 'heading');

    // Fallback: check for <legend> if no headings found
    if (headings.length === 0) {
      const legends = await target.locator('legend').all();
      for (const legend of legends) {
        if (await legend.isVisible()) {
          headings.push((await legend.innerText()).trim());
        }
      }
    }

    const rawButtons = await visibleLabelsForRole(target, 'button');
    const navigationButtons = [...new Set(rawButtons.filter((label) => NAVIGATION_LABEL.test(label)))];

    const optionsMap = new Map<string, SurveyOption>();
    await readOptionsFromRole(target, 'radio', optionsMap);
    await readOptionsFromRole(target, 'checkbox', optionsMap);
    await readOptionButtons(target, optionsMap);

    const textboxes = target.getByRole('textbox');
    let visibleTextInputCount = 0;
    const textboxCount = await textboxes.count();
    for (let index = 0; index < textboxCount; index += 1) {
      if (await textboxes.nth(index).isVisible()) {
        visibleTextInputCount += 1;
      }
    }

    const radioCount = await target.getByRole('radio').count();
    const checkboxCount = await target.getByRole('checkbox').count();

    let inputType: QuestionState['inputType'] = 'unknown';
    if (radioCount > 0 && checkboxCount === 0) {
      inputType = 'single_select';
    }
    if (checkboxCount > 0) {
      inputType = 'multi_select';
    }
    if (visibleTextInputCount > 0) {
      inputType = 'text';
    }

    const optionLabels = [...optionsMap.keys()].map((label) => label.toLowerCase());
    if (optionLabels.length === 2 && optionLabels.includes('yes') && optionLabels.includes('no')) {
      inputType = 'yes_no';
    }

    const questionText = headings[0] ?? (optionsMap.size > 0 ? 'Please answer this question' : 'Survey step');
    const supportText = headings.slice(1, 3);
    const filledValue = await readFilledText(target);
    const visibleInputCount = visibleTextInputCount + radioCount + checkboxCount + optionsMap.size;
    const progress = await detectProgress(target);

    // DEBUG: Log if we are returning an empty state
    // console.warn(`[DEBUG] Context: ${target.url?.() || 'frame'} | Inputs: ${visibleInputCount} | Buttons: ${navigationButtons.length}`);

    return {
      questionText,
      supportText,
      inputType,
      options: [...optionsMap.values()],
      filledValue,
      navigationButtons,
      progress,
      visibleInputCount,
      url: target.url()
    };
  };

  // Try the main context first
  const state = await extractFromContext(context);

  if (isValidSurveySurface(state)) {
    return state;
  }

  // If no valid surface found and this is a Page (has frames), try to find a valid frame
  if ('frames' in context) {
    const frames = context.frames();
    // console.warn(`[DEBUG] Checking ${frames.length} frames...`);
    for (const frame of frames) {
      if (frame === context.mainFrame()) continue;

      try {
        await frame.waitForLoadState('domcontentloaded');
        const frameState = await extractFromContext(frame);

        // Console log found frame state for debugging
        // if (frame.url().includes('typeform')) {
        //   console.warn(`[INFO] Typeform frame found. Inputs: ${frameState.visibleInputCount}, Buttons: ${frameState.navigationButtons.length}`);
        // }

        if (isValidSurveySurface(frameState)) {
          return frameState;
        }
      } catch (err) {
        // Log error to help debug why frames are skipped
        console.warn(`[WARN] Failed to extract state from frame ${frame.url()}: ${err}`);
      }
    }
  }

  return state;
};

export const isValidSurveySurface = (state: QuestionState): boolean => {
  if (state.visibleInputCount > 0) {
    return true;
  }

  return state.navigationButtons.length > 0;
};

export const stateFingerprint = (state: QuestionState): string =>
  `${state.questionText}|${state.progress ?? ''}|${state.options
    .map((option) => `${option.label}:${option.selected ? '1' : '0'}`)
    .join(',')}|${state.filledValue}`;
