
import OpenAI from 'openai';
import { type LlmDecisionRequest, type Decision, decisionSchema } from '../types.js';

export const requestDeepSeekDecision = async (request: LlmDecisionRequest): Promise<Decision> => {
    const client = new OpenAI({
        baseURL: 'https://api.deepseek.com',
        apiKey: request.apiKey
    });

    const model = request.model || 'deepseek-chat';

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
        throw new Error('DeepSeek returned empty content.');
    }

    try {
        const json = JSON.parse(content);
        return decisionSchema.parse(json);
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to parse DeepSeek response: ${error.message}\nRaw: ${content}`);
        }
        throw new Error('Failed to parse DeepSeek response: Unknown error');
    }
};
