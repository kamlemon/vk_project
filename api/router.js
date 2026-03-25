import { supabase } from '../lib/supabase.js'
import { callDeepSeek } from '../lib/deepseek.js'
import { sendMessage } from '../lib/vk.js'
import { log } from '../lib/logger.js'

const DIAGNOSIS_MARKER = '[ДИАГНОСТИКА_ВЫПОЛНЕНА]'

// ── Загрузка промпта из БД ───────────────────────────────────────────────────

async function getPrompt(promptId) {
  const { data } = await supabase
    .from('prompt')
    .select('prompt_content')
    .eq('prompt_id', promptId)
    .eq('is_active', true)
    .maybeSingle()

  if (!data) await log('router', `Промпт ${promptId} не найден`, null, 'warn')
  return data?.prompt_content ?? null
}

// ── Загрузка истории диалога ─────────────────────────────────────────────────

async function getHistory(dialogId, limit = 20) {
  const { data } = await supabase
    .from('message')
    .select('text, direction')
    .eq('dialog_id', dialogId)
    .order('dt_create', { ascending: false })
    .limit(limit)

  if (!data) return []
  return data.reverse().map(m => ({
    role:    m.direction === 'out' ? 'assistant' : 'user',
    content: m.text ?? '',
  }))
}

// ── Загрузка активного диалога ───────────────────────────────────────────────

async function getDialog(userId) {
  const { data } = await supabase
    .from('dialog')
    .select('*')
    .eq('vk_user_id', userId)
    .not('status_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data
}

// ── Сохранение ответа бота ───────────────────────────────────────────────────

async function saveReply({ dialogId, userId, reply, usedModel, replyToId, llmInput, llmOutput }) {
  await supabase.from('message').insert({
    dialog_id:   dialogId,
    from_id:     userId,
    peer_id:     userId,
    direction:   'out',
    text:        reply,
    msg_date:    new Date().toISOString(),
    reply_to_id: replyToId ?? null,
    raw_json:    { source: 'router', model: usedModel },
  })
}

// ── Сохранение токенов ───────────────────────────────────────────────────────

async function saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel }) {
  await supabase.from('token_usage').insert({
    vk_user_id:        userId,
    dialog_id:         dialogId,
    prompt_tokens:     inputTokens,
    candidates_tokens: outputTokens,
    total_tokens:      inputTokens + outputTokens,
    model_version:     usedModel,
  })
}

// ── Обновление диалога ───────────────────────────────────────────────────────

async function updateDialog(dialogId, fields) {
  const { error } = await supabase
    .from('dialog')
    .update(fields)
    .eq('id', dialogId)

  if (error) await log('router', 'Ошибка обновления диалога', { error: error.message }, 'error')
}

// ── Пометить входящее как обработанное ──────────────────────────────────────

async function markReplied(messageId) {
  if (!messageId) return
  await supabase
    .from('message')
    .update({ is_replied: true })
    .eq('id', messageId)
}

// ── Вызов DeepSeek с логированием ввода/вывода ───────────────────────────────

async function callLLM({ prompt, userContext, history, text, source }) {
  await log(source, 'LLM запрос', {
    system_prompt_length: prompt?.length ?? 0,
    user_context:         userContext,
    history_count:        history.length,
    user_message:         text,
  })

  const result = await callDeepSeek(prompt, userContext, history, text)

  await log(source, 'LLM ответ', {
    raw_reply:     result.reply,
    input_tokens:  result.inputTokens,
    output_tokens: result.outputTokens,
    model:         result.model,
  })

  return result
}


// ── STATUS 1, 2 — Знакомство + бесплатная диагностика ───────────────────────

async function handleStatus12({ dialog, userId, text, userContext, incomingMessageId }) {
  const dialogId = dialog.id
  const prompt   = await getPrompt(1)
  const history  = await getHistory(dialogId)

  const { reply: rawReply, inputTokens, outputTokens, model: usedModel } =
    await callLLM({ prompt, userContext, history, text, source: 'status-1-2' })

  // Проверяем метку диагностики
  const diagnosisDone = rawReply.includes(DIAGNOSIS_MARKER)
  const reply         = rawReply.replace(DIAGNOSIS_MARKER, '').trim()

  await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
  await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
  await markReplied(incomingMessageId)

  const newUserMsgCount = (dialog.user_message_count ?? 0) + 1

  const updateFields = {
    message_count:      (dialog.message_count ?? 0) + 1,
    user_message_count: newUserMsgCount,
    last_message_at:    new Date().toISOString(),
    last_message_by:    'bot',
  }

  if (diagnosisDone) {
    updateFields.free_service_done = true
    await log('status-1-2', 'Диагностика выполнена → free_service_done = true', { dialogId })
  }

  if (newUserMsgCount >= 30) {
    updateFields.status_id = diagnosisDone || dialog.free_service_done ? 4 : 3
    await log('status-1-2', `30 сообщений → status_id = ${updateFields.status_id}`, { dialogId })
  }

  await updateDialog(dialogId, updateFields)
  await sendMessage(userId, reply)
  await log('status-1-2', 'Ответ отправлен', { userId })
}

// ── STATUS 3, 4 — Анализ + переход к услугам ────────────────────────────────

async function handleStatus34({ dialog, userId, text, userContext, incomingMessageId }) {
  const dialogId = dialog.id

  // Если prompt_3 уже запланирован — проверяем время
  if (dialog.prompt_3_scheduled_at) {
    const scheduledAt = new Date(dialog.prompt_3_scheduled_at)
    const now         = new Date()

    if (now >= scheduledAt) {
      // Время вышло — отправляем статичный текст услуг
      const staticText = await getPrompt(3)

      if (staticText) {
        await sendMessage(userId, staticText)
        await saveReply({
          dialogId,
          userId,
          reply:    staticText,
          usedModel: 'static',
          replyToId: null,
        })
        await updateDialog(dialogId, {
          status_id:       5,
          last_message_at: new Date().toISOString(),
          last_message_by: 'bot',
        })
        await log('status-3-4', 'Статичный текст услуг отправлен → status_id = 5', { dialogId })
      }

      // На сообщение юзера не отвечаем — только отправили статику
      await markReplied(incomingMessageId)
      return
    }

    // 10 минут ещё не вышло — молчим
    await log('status-3-4', 'Ждём 10 минут — молчим', { dialogId, scheduledAt })
    await markReplied(incomingMessageId)
    return
  }

  // prompt_3 ещё не запланирован — отвечаем через нейронку (prompt_id = 2)
  const prompt  = await getPrompt(2)
  const history = await getHistory(dialogId, 30)

  const { reply, inputTokens, outputTokens, model: usedModel } =
    await callLLM({ prompt, userContext, history, text, source: 'status-3-4' })

  await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
  await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
  await markReplied(incomingMessageId)

  // Планируем отправку статики через 10 минут
  const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  await updateDialog(dialogId, {
    message_count:         (dialog.message_count ?? 0) + 1,
    last_message_at:       new Date().toISOString(),
    last_message_by:       'bot',
    prompt_3_scheduled_at: scheduledAt,
  })

  await log('status-3-4', 'prompt_3 запланирован', { scheduledAt })
  await sendMessage(userId, reply)
  await log('status-3-4', 'Ответ отправлен', { userId })
}


// ── STATUS 5 — Продажа продукта ──────────────────────────────────────────────

async function handleStatus5({ dialog, userId, text, userContext, incomingMessageId }) {
  const dialogId = dialog.id
  const prompt   = await getPrompt(4)
  const history  = await getHistory(dialogId)

  const { reply, inputTokens, outputTokens, model: usedModel } =
    await callLLM({ prompt, userContext, history, text, source: 'status-5' })

  await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
  await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
  await markReplied(incomingMessageId)
  await updateDialog(dialogId, {
    message_count:   (dialog.message_count ?? 0) + 1,
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
  })

  await sendMessage(userId, reply)
  await log('status-5', 'Ответ отправлен', { userId })
}

// ── STATUS 6 — Ведение по продукту ───────────────────────────────────────────

async function handleStatus6({ dialog, userId, text, userContext, incomingMessageId }) {
  const dialogId = dialog.id

  // Берём промпт + описание продукта
  const prompt = await getPrompt(5)

  const { data: product } = await supabase
    .from('product')
    .select('name, description')
    .eq('product_id', 2)
    .maybeSingle()

  const productContext = product
    ? `\n\nПродукт с которым ведётся работа:\n${product.name}\n\n${product.description}`
    : ''

  const fullPrompt = (prompt ?? '') + productContext
  const history    = await getHistory(dialogId)

  const { reply, inputTokens, outputTokens, model: usedModel } =
    await callLLM({ prompt: fullPrompt, userContext, history, text, source: 'status-6' })

  await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
  await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
  await markReplied(incomingMessageId)
  await updateDialog(dialogId, {
    message_count:   (dialog.message_count ?? 0) + 1,
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
  })

  await sendMessage(userId, reply)
  await log('status-6', 'Ответ отправлен', { userId })
}

// ── STATUS 7 — Завершение ────────────────────────────────────────────────────

async function handleStatus7({ dialog, userId, text, userContext, incomingMessageId }) {
  const dialogId = dialog.id
  const prompt   = await getPrompt(6)
  const history  = await getHistory(dialogId, 50)

  const { reply, inputTokens, outputTokens, model: usedModel } =
    await callLLM({ prompt, userContext, history, text, source: 'status-7' })

  await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
  await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
  await markReplied(incomingMessageId)
  await updateDialog(dialogId, {
    message_count:   (dialog.message_count ?? 0) + 1,
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
    status_id:       3,
  })

  await log('status-7', 'Завершение → status_id = 3', { dialogId })
  await sendMessage(userId, reply)
  await log('status-7', 'Ответ отправлен', { userId })
}

// ── Главный handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  // Сразу отвечаем VK — не ждём обработки
  res.status(200).send('ok')

  const { user_id, text, first_name, sex, incoming_message_id } = req.body
  if (!user_id) return

  try {
    // Дедупликация на уровне роутера
    const incomingEventId = req.body?.event_id ?? null
    if (incomingEventId) {
      const { error: dedupErr } = await supabase
        .from('processed_events')
        .insert({ event_id: incomingEventId })
      if (dedupErr) {
        await log('router', 'Дубликат event_id — пропускаем', { event_id: incomingEventId })
        return
      }
    }

    await log('router', 'Входящее сообщение', { user_id, text })

    const dialog = await getDialog(user_id)

    if (!dialog) {
      await log('router', 'Диалог не найден', { user_id }, 'error')
      return
    }

    await log('router', 'Диалог загружен', {
      dialog_id:          dialog.id,
      status_id:          dialog.status_id,
      user_message_count: dialog.user_message_count,
    })

    const sexLabel    = sex === 1 ? 'женщина' : sex === 2 ? 'мужчина' : 'неизвестно'
    const userContext = first_name ? `Имя клиента: ${first_name}. Пол: ${sexLabel}.` : ''

    const ctx = { dialog, userId: user_id, text, userContext, incomingMessageId: incoming_message_id }

    const statusId = dialog.status_id

    if (statusId === 1 || statusId === 2) { await handleStatus12(ctx); return }
    if (statusId === 3 || statusId === 4) { await handleStatus34(ctx); return }
    if (statusId === 5)                   { await handleStatus5(ctx);  return }
    if (statusId === 6)                   { await handleStatus6(ctx);  return }
    if (statusId === 7)                   { await handleStatus7(ctx);  return }

    await log('router', 'Неизвестный status_id', { statusId }, 'warn')

  } catch (err) {
    await log('router', 'ОШИБКА', { error: err.message }, 'error')
  }
}
