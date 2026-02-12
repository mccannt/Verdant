import OpenAI from 'openai';
import { type Decision, type LlmDecisionRequest, decisionSchema } from '../types.js';

export const requestXaiDecision = async (request: LlmDecisionRequest): Promise<Decision> => {
    const client = new OpenAI({
        baseURL: 'https://api.x.ai/v1',
        apiKey: request.apiKey
    });

    const model = request.model || 'grok-beta';

    const completion = await client.chat.completions.create({
        messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt }
        ],
        model,
        // xAI supports JSON mode
        response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
        throw new Error('xAI returned empty content.');
    }

    try {
        const json = JSON.parse(content);
        return decisionSchema.parse(json);
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to parse xAI response: ${error.message}\nRaw: ${content}`);
        }
        throw new Error('Failed to parse xAI response: Unknown error');
    }
};
