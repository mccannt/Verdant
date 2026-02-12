import Groq from 'groq-sdk';
import { type Decision, type LlmDecisionRequest, decisionSchema } from '../types.js';

export const requestGroqDecision = async (request: LlmDecisionRequest): Promise<Decision> => {
    const client = new Groq({
        apiKey: request.apiKey
    });

    const model = request.model || 'llama-3.3-70b-versatile';

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
        throw new Error('Groq returned empty content.');
    }

    try {
        const json = JSON.parse(content);
        return decisionSchema.parse(json);
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to parse Groq response: ${error.message}\nRaw: ${content}`);
        }
        throw new Error('Failed to parse Groq response: Unknown error');
    }
};
