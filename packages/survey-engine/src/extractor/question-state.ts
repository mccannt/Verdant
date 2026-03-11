import type { Locator, Page } from 'playwright';
import type { QuestionState, SurveyOption } from '../types/index.js';

/** Mutable reference to the frame that currently hosts the survey surface. */
export type ContextRef = { value: Page | import('playwright').Frame };

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

export const extractQuestionState = async (
  context: Page | import('playwright').Frame,
  contextRef?: ContextRef
): Promise<QuestionState> => {
  // Helper to extract state from a given context (page or frame)
  const extractFromContext = async (target: Page | import('playwright').Frame): Promise<QuestionState> => {
    // Fast path: single browser-side evaluate — O(1) IPC instead of O(N sequential roundtrips)
    try {
      return await target.evaluate((): {
        questionText: string;
        supportText: string[];
        inputType: string;
        options: { label: string; selected: boolean }[];
        filledValue: string;
        navigationButtons: string[];
        progress: string | null;
        visibleInputCount: number;
        url: string;
        sliderMin?: number;
        sliderMax?: number;
        sliderStep?: number;
        matrixRows?: Array<{ rowLabel: string; options: Array<{ label: string; selected: boolean }> }>;
      } => {
        const NAV = /\b(next|continue|ok|submit|done|finish|start|send|complete|previous|back)\b/i;
        const clean = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();

        const isVis = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          // checkVisibility (Chrome 105+) walks the full ancestor chain and catches opacity:0
          // on any ancestor — critical for Typeform which pre-renders adjacent questions inside
          // opacity:0 parent containers so they appear hidden even though the elements themselves
          // have opacity:1.
          if ('checkVisibility' in el) {
            return (el as Element & { checkVisibility: (opts?: object) => boolean }).checkVisibility({ opacityProperty: true, visibilityProperty: true });
          }
          // Fallback: walk up and check each ancestor's own opacity
          for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
          }
          return true;
        };

        const getName = (el: Element): string => {
          const aria = clean(el.getAttribute('aria-label'));
          if (aria) return aria;
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            for (const id of labelledBy.split(/\s+/)) {
              const node = document.getElementById(id);
              const t = clean(node?.textContent);
              if (t) return t;
            }
          }
          const id = el.getAttribute('id');
          if (id) {
            const lbl = document.querySelector(`label[for="${id}"]`);
            if (lbl) { const t = clean(lbl.textContent); if (t) return t; }
          }
          const closest = el.closest('label');
          if (closest) { const t = clean(closest.textContent); if (t) return t; }
          return clean(el.textContent);
        };

        const isCheckedEl = (el: Element): boolean => {
          const inp = el as HTMLInputElement;
          if (typeof inp.checked === 'boolean' && inp.checked) return true;
          if (el.getAttribute('aria-checked') === 'true') return true;
          let parent = el.parentElement;
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
            ) return true;
            if (parent.tagName === 'FORM' || parent.getAttribute('role') === 'group') break;
            parent = parent.parentElement;
          }
          return false;
        };

        // --- Headings ---
        const headings: string[] = [];
        for (const el of document.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6')) {
          if (!isVis(el)) continue;
          const label = getName(el);
          if (label) headings.push(label);
        }
        // Always collect visible <legend> text as supplementary headings so that survey platforms
        // like Typeform (which use a <legend> per question inside a shared section header) produce
        // unique fingerprints for each question even when the top-level heading is identical.
        for (const el of document.querySelectorAll('legend')) {
          if (!isVis(el)) continue;
          const t = clean(el.textContent);
          if (t && !headings.includes(t)) headings.push(t);
        }

        // --- Buttons (navigation + option) ---
        const navigationSet = new Set<string>();
        const optionsMap = new Map<string, { label: string; selected: boolean }>();

        for (const el of document.querySelectorAll('[role="button"], button')) {
          if (!isVis(el)) continue;
          const label = getName(el);
          if (!label) continue;
          if (NAV.test(label)) {
            navigationSet.add(label);
          } else {
            if (!optionsMap.has(label)) {
              const ariaPressed = el.getAttribute('aria-pressed');
              const ariaSelected = el.getAttribute('aria-selected');
              const selected = ariaPressed === 'true' || ariaSelected === 'true' ||
                el.classList.contains('selected') || el.classList.contains('active');
              optionsMap.set(label, { label, selected });
            }
          }
        }

        // --- Radios ---
        let radioCount = 0;
        for (const el of document.querySelectorAll('[role="radio"], input[type="radio"]')) {
          if (!isVis(el)) continue;
          radioCount++;
          const label = getName(el);
          if (label) optionsMap.set(label, { label, selected: isCheckedEl(el) });
        }

        // --- Checkboxes ---
        let checkboxCount = 0;
        for (const el of document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')) {
          if (!isVis(el)) continue;
          checkboxCount++;
          const label = getName(el);
          if (label) optionsMap.set(label, { label, selected: isCheckedEl(el) });
        }

        // --- Textboxes (includes email/number/tel which behave like plain text inputs) ---
        let visibleTextInputCount = 0;
        let filledValue = '';
        for (const el of document.querySelectorAll('[role="textbox"], input[type="text"], input[type="email"], input[type="number"], input[type="tel"], input:not([type]), textarea')) {
          if (!isVis(el)) continue;
          visibleTextInputCount++;
          if (!filledValue) {
            const val = clean((el as HTMLInputElement).value);
            if (val) filledValue = val;
          }
        }

        // --- Sliders ---
        let sliderMin = 0;
        let sliderMax = 100;
        let sliderStep = 1;
        let sliderCount = 0;
        for (const el of document.querySelectorAll('input[type="range"], [role="slider"]')) {
          if (!isVis(el)) continue;
          sliderCount++;
          if (sliderCount === 1) {
            const inp = el as HTMLInputElement;
            sliderMin = parseFloat(inp.min || '0');
            sliderMax = parseFloat(inp.max || '100');
            sliderStep = parseFloat(inp.step || '1');
            if (!filledValue) filledValue = inp.value || String(sliderMin);
          }
        }

        // --- Date pickers ---
        let dateCount = 0;
        for (const el of document.querySelectorAll('input[type="date"], input[type="datetime-local"], input[type="month"], input[type="week"]')) {
          if (!isVis(el)) continue;
          dateCount++;
          if (!filledValue) filledValue = (el as HTMLInputElement).value;
        }

        // --- Matrix (multiple radio groups sharing identical column labels) ---
        const matrixRows: Array<{ rowLabel: string; options: Array<{ label: string; selected: boolean }> }> = [];
        for (const group of document.querySelectorAll('[role="radiogroup"], fieldset')) {
          if (!isVis(group)) continue;
          const legend = group.querySelector('legend, [role="legend"]');
          const rowLabel = legend ? clean(legend.textContent) : '';
          if (!rowLabel) continue;
          const groupOptions: Array<{ label: string; selected: boolean }> = [];
          for (const radio of group.querySelectorAll('[role="radio"], input[type="radio"]')) {
            if (!isVis(radio)) continue;
            const label = getName(radio);
            if (!label) continue;
            groupOptions.push({ label, selected: isCheckedEl(radio) });
          }
          if (groupOptions.length >= 2) matrixRows.push({ rowLabel, options: groupOptions });
        }
        const isMatrix = matrixRows.length >= 2 &&
          matrixRows.every(r => r.options.map(o => o.label).join('|') === matrixRows[0]!.options.map(o => o.label).join('|'));

        // --- Native <select> dropdowns ---
        let selectCount = 0;
        for (const el of document.querySelectorAll('select')) {
          if (!isVis(el)) continue;
          selectCount++;
          const sel = el as HTMLSelectElement;
          for (const opt of Array.from(sel.options)) {
            if (opt.disabled || opt.value === '' || !opt.text.trim()) continue;
            const t = clean(opt.text);
            if (t) optionsMap.set(t, { label: t, selected: opt.selected });
          }
        }

        // --- Open listbox options (e.g. Typeform/custom dropdown already expanded) ---
        for (const el of document.querySelectorAll('[role="option"]')) {
          if (!isVis(el)) continue;
          const label = getName(el);
          if (!label || NAV.test(label)) continue;
          const selected = el.getAttribute('aria-selected') === 'true';
          if (!optionsMap.has(label)) optionsMap.set(label, { label, selected });
        }

        // --- inputType (priority: slider > date_picker > matrix > text > single_select > multi_select > yes_no > unknown) ---
        let inputType = 'unknown';
        if (radioCount > 0 && checkboxCount === 0) inputType = 'single_select';
        if (checkboxCount > 0) inputType = 'multi_select';
        if (selectCount > 0) inputType = 'single_select';
        if (visibleTextInputCount > 0) inputType = 'text'; // text inputs win over dropdown
        if (isMatrix) inputType = 'matrix'; // matrix wins over plain radio/single_select
        if (dateCount > 0) inputType = 'date_picker'; // date beats plain text inputs
        if (sliderCount > 0) inputType = 'slider'; // slider is most specific, beats everything
        const optionKeys = [...optionsMap.keys()].map((k) => k.toLowerCase());
        if (optionKeys.length === 2 && optionKeys.includes('yes') && optionKeys.includes('no')) inputType = 'yes_no';
        // Promote button-only pages: if still unknown but ≥2 non-nav options exist, those are
        // likely clickable choice buttons (e.g. NPS/picture-choice/custom scale).
        if (inputType === 'unknown' && optionsMap.size >= 2) inputType = 'single_select';

        // --- Progress ---
        let progress: string | null = null;
        for (const el of document.querySelectorAll('[role="progressbar"]')) {
          if (!isVis(el)) continue;
          const label = getName(el);
          if (label) { progress = label; break; }
        }
        if (!progress) {
          const text = document.body?.innerText ?? '';
          const pct = text.match(/\b\d{1,3}%\b/);
          if (pct) { progress = pct[0]; }
          else {
            const steps = text.match(/\b\d+\s+of\s+\d+\b/i);
            if (steps) progress = steps[0];
          }
        }

        const options = [...optionsMap.values()];
        const questionText = headings[0] ?? (options.length > 0 ? 'Please answer this question' : 'Survey step');
        const supportText = headings.slice(1, 3);
        const visibleInputCount = visibleTextInputCount + radioCount + checkboxCount + selectCount + sliderCount + dateCount + optionsMap.size;

        return {
          questionText,
          supportText,
          inputType,
          options,
          filledValue,
          navigationButtons: [...navigationSet],
          progress,
          visibleInputCount,
          url: window.location.href,
          ...(sliderCount > 0 ? { sliderMin, sliderMax, sliderStep } : {}),
          ...(isMatrix ? { matrixRows } : {})
        };
      }) as QuestionState;
    } catch (err) {
      // Fallback: original multi-roundtrip approach (handles edge cases the evaluate cannot)
      console.debug(`[PERF] evaluate fast-path failed, using fallback:`, err instanceof Error ? err.message : err);
    }

    // --- Fallback path ---
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

    // Textboxes: include email/number/tel alongside standard text inputs
    const textboxes = target.locator('[role="textbox"], input[type="text"], input[type="email"], input[type="number"], input[type="tel"], input:not([type]), textarea');
    let visibleTextInputCount = 0;
    const textboxCount = await textboxes.count();
    for (let index = 0; index < textboxCount; index += 1) {
      if (await textboxes.nth(index).isVisible()) {
        visibleTextInputCount += 1;
      }
    }

    // Native <select> dropdowns
    let selectCount = 0;
    const selectLocator = target.locator('select');
    const nativeSelectCount = await selectLocator.count();
    for (let i = 0; i < nativeSelectCount; i++) {
      const sel = selectLocator.nth(i);
      if (!(await sel.isVisible())) continue;
      selectCount++;
      const opts = await sel.evaluate((el: HTMLSelectElement) =>
        Array.from(el.options)
          .filter((o) => !o.disabled && o.value !== '' && o.text.trim())
          .map((o) => ({ label: o.text.trim(), selected: o.selected }))
      );
      for (const opt of opts) {
        if (!optionsMap.has(opt.label)) optionsMap.set(opt.label, opt);
      }
    }

    // Open listbox options ([role="option"]) — custom dropdowns already expanded
    const optionItems = await target.locator('[role="option"]').all();
    for (const item of optionItems) {
      if (!(await item.isVisible())) continue;
      const label = await elementLabel(item);
      if (!label || NAVIGATION_LABEL.test(label)) continue;
      const selected = (await item.getAttribute('aria-selected')) === 'true';
      if (!optionsMap.has(label)) optionsMap.set(label, { label, selected });
    }

    // Sliders (input[type="range"] / [role="slider"])
    let sliderCount = 0;
    let sliderMin = 0;
    let sliderMax = 100;
    let sliderStep = 1;
    const sliderLocator = target.locator('input[type="range"], [role="slider"]');
    const sliderTotalCount = await sliderLocator.count();
    for (let i = 0; i < sliderTotalCount; i++) {
      const el = sliderLocator.nth(i);
      if (!(await el.isVisible())) continue;
      sliderCount++;
      if (sliderCount === 1) {
        sliderMin = parseFloat((await el.getAttribute('min')) ?? '0');
        sliderMax = parseFloat((await el.getAttribute('max')) ?? '100');
        sliderStep = parseFloat((await el.getAttribute('step')) ?? '1');
      }
    }

    // Date pickers
    let dateCount = 0;
    const dateLocator = target.locator('input[type="date"], input[type="datetime-local"], input[type="month"], input[type="week"]');
    const dateTotalCount = await dateLocator.count();
    for (let i = 0; i < dateTotalCount; i++) {
      const el = dateLocator.nth(i);
      if (!(await el.isVisible())) continue;
      dateCount++;
    }

    // Matrix detection (multiple radio groups sharing identical column labels)
    const matrixRowsData: Array<{ rowLabel: string; options: SurveyOption[] }> = [];
    const groupLocator = target.locator('[role="radiogroup"], fieldset');
    const groupCount = await groupLocator.count();
    for (let i = 0; i < groupCount; i++) {
      const group = groupLocator.nth(i);
      if (!(await group.isVisible())) continue;
      const legend = group.locator('legend, [role="legend"]').first();
      let rowLabel = '';
      if (await legend.count() > 0) {
        rowLabel = ((await legend.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      }
      if (!rowLabel) continue;
      const groupOptions: SurveyOption[] = [];
      const radios = group.locator('[role="radio"], input[type="radio"]');
      const radioCountInGroup = await radios.count();
      for (let j = 0; j < radioCountInGroup; j++) {
        const radio = radios.nth(j);
        if (!(await radio.isVisible())) continue;
        const label = await elementLabel(radio);
        if (!label) continue;
        const selected = await radio.evaluate((node) => {
          const inp = node as HTMLInputElement;
          return (typeof inp.checked === 'boolean' && inp.checked) || node.getAttribute('aria-checked') === 'true';
        });
        groupOptions.push({ label, selected });
      }
      if (groupOptions.length >= 2) matrixRowsData.push({ rowLabel, options: groupOptions });
    }
    const isMatrix = matrixRowsData.length >= 2 &&
      matrixRowsData.every(r => r.options.map(o => o.label).join('|') === matrixRowsData[0]!.options.map(o => o.label).join('|'));

    const radioCount = await target.getByRole('radio').count();
    const checkboxCount = await target.getByRole('checkbox').count();

    let inputType: QuestionState['inputType'] = 'unknown';
    if (radioCount > 0 && checkboxCount === 0) {
      inputType = 'single_select';
    }
    if (checkboxCount > 0) {
      inputType = 'multi_select';
    }
    if (selectCount > 0) inputType = 'single_select';
    if (visibleTextInputCount > 0) {
      inputType = 'text'; // text inputs win over dropdown
    }
    if (isMatrix) inputType = 'matrix';
    if (dateCount > 0) inputType = 'date_picker';
    if (sliderCount > 0) inputType = 'slider';

    const optionLabels = [...optionsMap.keys()].map((label) => label.toLowerCase());
    if (optionLabels.length === 2 && optionLabels.includes('yes') && optionLabels.includes('no')) {
      inputType = 'yes_no';
    }
    // Button-only questions: promote to single_select when ≥2 non-nav options found
    if (inputType === 'unknown' && optionsMap.size >= 2) inputType = 'single_select';

    const questionText = headings[0] ?? (optionsMap.size > 0 ? 'Please answer this question' : 'Survey step');
    const supportText = headings.slice(1, 3);
    const filledValue = await readFilledText(target);
    const visibleInputCount = visibleTextInputCount + radioCount + checkboxCount + selectCount + sliderCount + dateCount + optionsMap.size;
    const progress = await detectProgress(target);

    return {
      questionText,
      supportText,
      inputType,
      options: [...optionsMap.values()],
      filledValue,
      navigationButtons,
      progress,
      visibleInputCount,
      url: target.url(),
      ...(sliderCount > 0 ? { sliderMin, sliderMax, sliderStep } : {}),
      ...(isMatrix ? { matrixRows: matrixRowsData } : {})
    };
  };

  // Fast path: use cached frame if available and it differs from the passed context
  if (contextRef && contextRef.value !== context) {
    try {
      const cachedState = await extractFromContext(contextRef.value);
      if (isValidSurveySurface(cachedState)) {
        return cachedState;
      }
      // Cache is stale — reset and fall through to full discovery
      contextRef.value = context;
    } catch {
      contextRef.value = context;
    }
  }

  // Try the passed context first
  const state = await extractFromContext(context);

  if (isValidSurveySurface(state)) {
    if (contextRef) contextRef.value = context;
    return state;
  }

  // If no valid surface found and this is a Page (has frames), search for the right frame
  if ('frames' in context) {
    const frames = context.frames();
    for (const frame of frames) {
      if (frame === context.mainFrame()) continue;

      try {
        await frame.waitForLoadState('domcontentloaded');
        const frameState = await extractFromContext(frame);

        if (isValidSurveySurface(frameState)) {
          if (contextRef) contextRef.value = frame; // Cache for next time
          return frameState;
        }
      } catch (err) {
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
  // Include supportText so questions sharing a header (e.g. Typeform rating groups) produce
  // distinct fingerprints even when questionText, options and progress are identical.
  `${state.questionText}|${state.supportText.join('\n')}|${state.progress ?? ''}|${state.options
    .map((option) => `${option.label}:${option.selected ? '1' : '0'}`)
    .join(',')}|${state.filledValue}`;
