import OpenAI from 'openai';
import { type Decision, type LlmDecisionRequest, decisionSchema } from '../types.js';

export const requestOpenRouterDecision = async (request: LlmDecisionRequest): Promise<Decision> => {
    const client = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: request.apiKey,
        defaultHeaders: {
            'HTTP-Referer': 'https://verdant.dev', // Required by OpenRouter
            'X-Title': 'Verdant LLM Runner'
        }
    });

    const model = request.model || 'openai/gpt-4o';

    const completion = await client.chat.completions.create({
        messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt }
        ],
        model,
        response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
        throw new Error('OpenRouter returned empty content.');
    }

    try {
        const json = JSON.parse(content);
        return decisionSchema.parse(json);
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to parse OpenRouter response: ${error.message}\nRaw: ${content}`);
        }
        throw new Error('Failed to parse OpenRouter response: Unknown error');
    }
};
