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
    await log('new-user', 'Начало обработки нового юзера', { user_id, text })

    const { data: docRow } = await supabase
      .from('document')
      .select('content')
      .eq('type', 'system_prompt')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!docRow) await log('new-user', 'system_prompt не найден', null, 'warn')
    else await log('new-user', 'system_prompt загружен', { length: docRow.content.length })

    const sexLabel    = sex === 1 ? 'женщина' : sex === 2 ? 'мужчина' : 'неизвестно'
    const userContext = first_name ? `Имя клиента: ${first_name}. Пол: ${sexLabel}.` : ''
    const userMessage = userContext ? `${userContext}\n\n${text}` : text

    const { reply, inputTokens, outputTokens, model: usedModel } =
      await callDeepSeek(docRow?.content ?? null, '', [], userMessage)

    await log('new-user', 'DeepSeek ответил', { reply, inputTokens, outputTokens, model: usedModel })

    const { data: dialog } = await supabase
      .from('dialog')
      .select('id, message_count')
      .eq('vk_user_id', user_id)
      .eq('status_id', 1)
      .maybeSingle()

    const dialog_id = dialog?.id ?? null

    await supabase.from('message').insert({
      dialog_id,
      from_id:   user_id,
      peer_id:   user_id,
      direction: 'out',
      text:      reply,
      msg_date:  new Date().toISOString(),
      raw_json:  { source: 'new-user', model: usedModel },
    })

    await supabase.from('token_usage').insert({
      vk_user_id:        user_id,
      dialog_id,
      prompt_tokens:     inputTokens,
      candidates_tokens: outputTokens,
      total_tokens:      inputTokens + outputTokens,
      model_version:     usedModel,
    })

    if (dialog_id) {
      await supabase
        .from('dialog')
        .update({
          message_count:   (dialog.message_count ?? 0) + 1,
          last_message_at: new Date().toISOString(),
          last_message_by: 'bot',
        })
        .eq('id', dialog_id)
    }

    await sendMessage(user_id, reply)
    await log('new-user', 'Ответ отправлен в VK', { user_id })

  } catch (err) {
    await log('new-user', 'ОШИБКА', { error: err.message }, 'error')
  }
}
