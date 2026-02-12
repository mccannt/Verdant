
import { GoogleGenerativeAI } from '@google/generative-ai';
import { type LlmDecisionRequest, type Decision, decisionSchema } from '../types.js';

export const requestGoogleDecision = async (request: LlmDecisionRequest): Promise<Decision> => {
    const genAI = new GoogleGenerativeAI(request.apiKey);
    const model = genAI.getGenerativeModel({
        model: request.model || 'gemini-1.5-flash',
        generationConfig: { responseMimeType: 'application/json' }
    });

    const chat = model.startChat({
        history: [
            {
                role: 'user',
                parts: [{ text: request.systemPrompt }]
            },
            {
                role: 'model',
                parts: [{ text: 'Understood. I will provide all future responses in the requested JSON format complying with the schema.' }]
            }
        ]
    });

    const result = await chat.sendMessage(request.userPrompt);
    const responseText = result.response.text();

    try {
        const json = JSON.parse(responseText.replace(/```json\n?|```/g, ''));
        return decisionSchema.parse(json);
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to parse Gemini response: ${error.message}\nRaw: ${responseText}`);
        }
        throw new Error('Failed to parse Gemini response: Unknown error');
    }
};
