import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
]

export async function callGemini(systemPrompt, userMessage) {
  let lastError

  for (const modelName of MODELS) {
    try {
      const modelConfig = { model: modelName }
      if (systemPrompt) modelConfig.systemInstruction = systemPrompt

      const model = genAI.getGenerativeModel(modelConfig)
      const result = await model.generateContent(userMessage)
      const response = result.response

      console.log(`[gemini] используем модель: ${modelName}`)

      return {
        reply: response.text(),
        inputTokens:  response.usageMetadata?.promptTokenCount     ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        model: modelName,
      }
    } catch (err) {
      if (err.message?.includes('429')) {
        console.warn(`[gemini] ${modelName} — 429, пробуем следующую`)
        lastError = err
        continue
      }
      throw err
    }
  }

  throw lastError ?? new Error('All Gemini models exhausted')
}
