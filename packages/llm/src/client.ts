
import { requestAnthropicDecision } from './providers/anthropic.js';
import { requestOpenaiDecision } from './providers/openai.js';
import { requestGoogleDecision } from './providers/google.js';
import { requestDeepSeekDecision } from './providers/deepseek.js';
import { requestGroqDecision } from './providers/groq.js';
import { requestOpenRouterDecision } from './providers/openrouter.js';
import { requestXaiDecision } from './providers/xai.js';
import { type Decision, type LlmDecisionRequest } from './types.js';

export const requestLlmDecision = async (request: LlmDecisionRequest): Promise<Decision> => {
  if (!request.apiKey) {
    throw new Error('Missing provider API key.');
  }

  switch (request.provider) {
    case 'openai':
      return requestOpenaiDecision(request);
    case 'anthropic':
      return requestAnthropicDecision(request);
    case 'google':
      return requestGoogleDecision(request);
    case 'deepseek':
      return requestDeepSeekDecision(request);
    case 'groq':
      return requestGroqDecision(request);
    case 'xai':
      return requestXaiDecision(request);
    case 'openrouter':
      return requestOpenRouterDecision(request);
    default:
      throw new Error(`Unsupported LLM provider: ${request.provider}`);
  }
};
