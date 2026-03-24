import { supabase } from '../lib/supabase.js'
import { callGemini } from '../lib/gemini.js'
import { sendMessage } from '../lib/vk.js'
import { log } from '../lib/logger.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  res.status(200).send('ok')

  const { user_id, text } = req.body
  if (!user_id || !text) return

  try {
    await log('new-user', 'Начало обработки нового юзера', { user_id, text })

    await log('new-user', 'Юзер уже создан в vk.js', { user_id })

    const { data: docRow } = await supabase
      .from('document')
      .select('content')
      .eq('type', 'system_prompt')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!docRow) await log('new-user', 'system_prompt не найден, идём без него', null, 'warn')
    else await log('new-user', 'system_prompt загружен', { length: docRow.content.length })

    const { reply, inputTokens, outputTokens } = await callGemini(docRow?.content ?? null, text)

    await log('new-user', 'Gemini ответил', { reply, inputTokens, outputTokens })

    await supabase.from('message')
      .insert({ user_id, role: 'assistant', content: reply })

    await supabase.from('token_usage')
      .insert({ user_id, input_tokens: inputTokens, output_tokens: outputTokens })

    await sendMessage(user_id, reply)

    await log('new-user', 'Ответ отправлен в VK', { user_id })

  } catch (err) {
    await log('new-user', 'ОШИБКА', { error: err.message }, 'error')
  }
}
