import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * @param {string|null} systemPrompt
 * @param {string} userMessage
 * @returns {Promise<{ reply: string, inputTokens: number, outputTokens: number }>}
 */
export async function callGemini(systemPrompt, userMessage) {
  const modelConfig = { model: 'gemini-2.5-flash' };

  if (systemPrompt) {
    modelConfig.systemInstruction = systemPrompt;
  }

  const model = genAI.getGenerativeModel(modelConfig);
  const result = await model.generateContent(userMessage);
  const response = result.response;

  return {
    reply: response.text(),
    inputTokens:  response.usageMetadata?.promptTokenCount     ?? 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
