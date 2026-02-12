
import { z } from 'zod';
import { decisionSchema, type Decision, type LlmDecisionRequest } from '../types.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const anthropicSchema = z.object({
    content: z.array(
        z.object({
            type: z.string(),
            text: z.string().optional()
        })
    )
});

const extractJson = (text: string): unknown => {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        const match = trimmed.match(/\{[\s\S]*\}/);
        if (!match) {
            throw new Error('LLM output did not include valid JSON.');
        }
        return JSON.parse(match[0]);
    }
};

const ensureDecision = (payload: unknown): Decision => decisionSchema.parse(payload);

const withTimeout = async (input: RequestInfo | URL, init: RequestInit, timeoutMs = 30000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
};

export const requestAnthropicDecision = async (request: LlmDecisionRequest): Promise<Decision> => {
    const response = await withTimeout(
        ANTHROPIC_URL,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': request.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: request.model ?? 'claude-3-5-haiku-latest',
                max_tokens: 800,
                temperature: 0,
                system: request.systemPrompt,
                messages: [{ role: 'user', content: request.userPrompt }]
            })
        },
        request.timeoutMs
    );

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic request failed (${response.status}): ${body}`);
    }

    const data = anthropicSchema.parse(await response.json());
    const textBlocks = data.content.filter((entry) => entry.type === 'text').map((entry) => entry.text ?? '');

    if (textBlocks.length === 0) {
        throw new Error('Anthropic returned empty content.');
    }

    return ensureDecision(extractJson(textBlocks.join('\n')));
};
