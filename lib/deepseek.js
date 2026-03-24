const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

const MODELS = ['deepseek-chat']

// systemPrompt - строка или null
// userContext  - строка с именем/полом или ''
// history      - массив { role, content } предыдущих сообщений (может быть [])
// userMessage  - текущее сообщение юзера
export async function callDeepSeek(systemPrompt, userContext = '', history = [], userMessage) {
  let lastError

  for (const modelName of MODELS) {
    try {
      const messages = []

      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
      if (history.length > 0) messages.push(...history)

      const content = userContext ? `${userContext}\n\n${userMessage}` : userMessage
      messages.push({ role: 'user', content })

      const res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({ model: modelName, messages }),
      })

      if (res.status === 429) {
        console.warn(`[deepseek] ${modelName} — 429, пробуем следующую`)
        lastError = new Error('429')
        continue
      }

      if (!res.ok) throw new Error(`DeepSeek error ${res.status}: ${await res.text()}`)

      const json = await res.json()
      console.log(`[deepseek] используем модель: ${modelName}`)

      return {
        reply:        json.choices[0].message.content,
        inputTokens:  json.usage?.prompt_tokens     ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        model:        modelName,
      }
    } catch (err) {
      if (err.message?.includes('429')) { lastError = err; continue }
      throw err
    }
  }

  throw lastError ?? new Error('All DeepSeek models exhausted')
}
