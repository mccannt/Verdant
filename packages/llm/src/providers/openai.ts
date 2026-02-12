
import { z } from 'zod';
import { decisionSchema, type Decision, type LlmDecisionRequest } from '../types.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const openAiSchema = z.object({
    choices: z.array(
        z.object({
            message: z.object({
                content: z.string().nullable().optional()
            })
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

export const requestOpenaiDecision = async (request: LlmDecisionRequest): Promise<Decision> => {
    const response = await withTimeout(
        OPENAI_URL,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${request.apiKey}`
            },
            body: JSON.stringify({
                model: request.model ?? 'gpt-4o-mini',
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: request.systemPrompt },
                    { role: 'user', content: request.userPrompt }
                ]
            })
        },
        request.timeoutMs
    );

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${body}`);
    }

    const data = openAiSchema.parse(await response.json());
    const content = data.choices[0]?.message.content;

    if (!content) {
        throw new Error('OpenAI returned empty content.');
    }

    return ensureDecision(extractJson(content));
};
