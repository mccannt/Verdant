import type { AnswerStrategy, QuestionState, RulesetConfig } from './types/index.js';

const seededIndex = (seed: string, length: number) => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return length === 0 ? 0 : hash % length;
};

const pickByMode = (labels: string[], mode: 'first' | 'last' | 'random', seed: string) => {
  if (labels.length === 0) {
    return '';
  }

  if (mode === 'first') {
    return labels[0] ?? '';
  }

  if (mode === 'last') {
    return labels[labels.length - 1] ?? '';
  }

  return labels[seededIndex(seed, labels.length)] ?? '';
};

export const chooseTextByRuleset = (
  state: QuestionState,
  ruleset: RulesetConfig | undefined,
  fallback = 'AUTO_TEST_RESPONSE'
): string => {
  const defaultValue = ruleset?.text?.default ?? fallback;
  const byKeyword = ruleset?.text?.byKeyword ?? {};
  const haystack = `${state.questionText} ${state.supportText.join(' ')}`.toLowerCase();

  const entry = Object.entries(byKeyword).find(([keyword]) => haystack.includes(keyword.toLowerCase()));
  return entry?.[1] ?? defaultValue;
};

export const deterministicSelection = (
  state: QuestionState,
  strategy: AnswerStrategy,
  ruleset: RulesetConfig | undefined,
  runId: string
): string[] => {
  const labels = state.options.map((option) => option.label);
  if (labels.length === 0) {
    return [];
  }

  if (strategy !== 'ruleset') {
    const mode = strategy === 'first' ? 'first' : strategy === 'last' ? 'last' : 'random';

    if (state.inputType === 'multi_select') {
      const picked = pickByMode(labels, mode, `${runId}:${state.questionText}`);
      return picked ? [picked] : [];
    }

    return [pickByMode(labels, mode, `${runId}:${state.questionText}`)].filter(Boolean);
  }

  if (state.inputType === 'multi_select') {
    const mode = ruleset?.multiSelect?.mode ?? 'first_n';
    const n = Math.max(1, ruleset?.multiSelect?.n ?? 2);

    if (mode === 'all') {
      return labels;
    }

    if (mode === 'random_n') {
      const chosen = [...labels];
      const result: string[] = [];
      while (chosen.length > 0 && result.length < n) {
        const idx = seededIndex(`${runId}:${state.questionText}:${result.length}`, chosen.length);
        const [label] = chosen.splice(idx, 1);
        if (label) {
          result.push(label);
        }
      }
      return result;
    }

    return labels.slice(0, n);
  }

  const singleMode = ruleset?.singleSelect ?? 'first';
  return [pickByMode(labels, singleMode, `${runId}:${state.questionText}`)].filter(Boolean);
};
