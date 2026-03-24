import { supabase } from '../lib/supabase.js'
import { callDeepSeek } from '../lib/deepseek.js'
import { sendMessage } from '../lib/vk.js'
import { log } from '../lib/logger.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  res.status(200).send('ok')

  const { user_id, text, first_name, sex } = req.body
  if (!user_id || !text) return

  try {
    await log('old-user', 'Начало обработки повторного юзера', { user_id, text })

    // Загружаем промпт для воронки, fallback на system_prompt
    const { data: docRow } = await supabase
      .from('document')
      .select('content')
      .eq('type', 'system_prompt_funnel')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    let prompt = docRow?.content ?? null

    if (!prompt) {
      await log('old-user', 'system_prompt_funnel не найден, берём system_prompt', null, 'warn')
      const { data: fallback } = await supabase
        .from('document')
        .select('content')
        .eq('type', 'system_prompt')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      prompt = fallback?.content ?? null
    } else {
      await log('old-user', 'system_prompt_funnel загружен', { length: docRow.content.length })
    }

    // Получаем историю диалога (последние 10 сообщений)
    const { data: dialog } = await supabase
      .from('dialog')
      .select('id')
      .eq('vk_user_id', user_id)
      .eq('status', 'active')
      .maybeSingle()

    const dialog_id = dialog?.id ?? null

    let history = []
    if (dialog_id) {
      const { data: messages } = await supabase
        .from('message')
        .select('text, direction')
        .eq('dialog_id', dialog_id)
        .order('created_at', { ascending: false })
        .limit(10)

      if (messages) {
        history = messages.reverse().map(m => ({
          role: m.direction === 'out' ? 'assistant' : 'user',
          content: m.text,
        }))
      }
    }

    await log('old-user', 'История загружена', { count: history.length })

    const sexLabel = sex === 1 ? 'женщина' : sex === 2 ? 'мужчина' : 'неизвестно'
    const userContext = first_name ? `Имя клиента: ${first_name}. Пол: ${sexLabel}.` : ''

    const { reply, inputTokens, outputTokens, model: usedModel } = await callDeepSeek(
      prompt,
      userContext,
      history,
      text
    )

    await log('old-user', 'DeepSeek ответил', { reply, inputTokens, outputTokens, model: usedModel })

    // Сохраняем ответ
    await supabase.from('message').insert({
      from_id: user_id,
      peer_id: user_id,
      text: reply,
      direction: 'out',
      dialog_id,
      is_transcribed: false,
      sent_at: new Date().toISOString(),
    })

    // Сохраняем токены
    await supabase.from('token_usage').insert({
      vk_user_id: user_id,
      dialog_id,
      prompt_tokens: inputTokens,
      candidates_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      model_version: usedModel,
    })

    await sendMessage(user_id, reply)
    await log('old-user', 'Ответ отправлен в VK', { user_id })

  } catch (err) {
    await log('old-user', 'ОШИБКА', { error: err.message }, 'error')
  }
}
