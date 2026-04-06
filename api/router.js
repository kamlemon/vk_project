import { supabase } from '../lib/supabase.js'
import { callDeepSeek } from '../lib/deepseek.js'
import { sendMessage } from '../lib/vk.js'
import { log } from '../lib/logger.js'
import { trace } from '../lib/debug-trace.js'

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


async function getProduct(productId) {
  const { data } = await supabase
    .from('product')
    .select('description')
    .eq('product_id', productId)
    .maybeSingle()

  if (!data) await log('router', `Продукт ${productId} не найден`, null, 'warn')
  return data?.description ?? null
}

function buildFullPrompt(prompt, productDescription = null) {
  return [
    prompt ?? '',
    productDescription ? `Описание продукта:\n${productDescription}` : '',
  ].filter(Boolean).join('\n\n')
}


async function getStaticPrompt(promptId) {
  const { data } = await supabase
    .from('prompt')
    .select('prompt_content')
    .eq('prompt_id', promptId)
    .eq('is_active', true)
    .maybeSingle()

  return data?.prompt_content ?? null
}

async function maybeSendMessage({ userId, text, traceId, statusId, extra = {} }) {
  await trace(traceId ?? `send-${userId}-${Date.now()}`, 'router.send_attempt', {
    user_id: userId,
    status_id: statusId,
    text_preview: text ? text.slice(0, 200) : '',
    ...extra,
  })

  if (process.env.DEBUG_NO_SEND === 'true') {
    await trace(traceId ?? `send-${userId}-${Date.now()}`, 'router.send_skipped', {
      reason: 'DEBUG_NO_SEND=true',
      user_id: userId,
      status_id: statusId,
      ...extra,
    })
    return null
  }

  try {
    const result = await sendMessage(userId, text)

    await trace(traceId ?? `send-${userId}-${Date.now()}`, 'router.send_success', {
      user_id: userId,
      status_id: statusId,
      result,
      ...extra,
    })

    return result
  } catch (err) {
    await trace(traceId ?? `send-${userId}-${Date.now()}`, 'router.send_failed', {
      user_id: userId,
      status_id: statusId,
      error: err.message,
      ...extra,
    }, 'error')
    throw err
  }
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
  const { data, error } = await supabase
    .from('dialog')
    .update(fields)
    .eq('id', dialogId)
    .select('id, status_id, free_service_done, free_done_at, prompt_3_scheduled_at, offer_sent_at, last_message_at, last_message_by, message_count, user_message_count')
    .single()

  if (error) {
    await trace(`dialog-${dialogId}-${Date.now()}`, 'router.update_dialog_failed', {
      dialog_id: dialogId,
      fields,
      error: error.message,
    }, 'error')

    throw new Error(`updateDialog failed: ${error.message}`)
  }

  await trace(`dialog-${dialogId}-${Date.now()}`, 'router.update_dialog_success', {
    dialog_id: dialogId,
    fields,
    persisted: data,
  })

  return data
}


// ── Пометить входящее как обработанное ──────────────────────────────────────

async function markReplied(messageId) {
  if (!messageId) return
  await supabase
    .from('message')
    .update({ is_replied: true })
    .eq('id', messageId)
}


async function getIncomingMessage(messageId) {
  if (!messageId) return null

  const { data, error } = await supabase
    .from('message')
    .select('*')
    .eq('id', messageId)
    .maybeSingle()

  if (error) {
    await log('router', 'Ошибка загрузки incoming message', { error: error.message, messageId }, 'error')
    return null
  }

  return data
}

function buildLLMUserText(text, incomingMessage) {
  const trans = Array.isArray(incomingMessage?.attachment_trans)
    ? incomingMessage.attachment_trans.join('\n\n')
    : (incomingMessage?.attachment_trans ?? '')

  return [
    'Системные данные:',
    `has_attachment: ${Boolean(incomingMessage?.has_attachments)}`,
    `attachment_types: ${incomingMessage?.attachment_types ?? ''}`,
    `has_attachment_trans: ${Boolean(trans)}`,
    '',
    'Текст пользователя:',
    text ?? '',
    '',
    trans ? `Описание вложения от системы:\n${trans}` : 'Описание вложения от системы: отсутствует',
  ].join('\n')
}

async function handleDebugPreview({ dialog, userId, text, userContext, incomingMessageId, traceId }) {
  const incomingMessage = await getIncomingMessage(incomingMessageId)

  await trace(traceId, 'router.incoming_message_loaded', incomingMessage)

  let promptId = 1
  if (dialog.status_id === 3 || dialog.status_id === 4) promptId = 2
  if (dialog.status_id === 5) promptId = 4
  if (dialog.status_id === 6) promptId = 5
  if (dialog.status_id === 7) promptId = 6

  const prompt = await getPrompt(promptId)
  const productDescription = promptId === 1 ? await getProduct(1) : null
  const fullPrompt = buildFullPrompt(prompt, productDescription)
  const history = await getHistory(dialog.id, dialog.status_id === 3 || dialog.status_id === 4 ? 30 : 20)
  const llmText = buildLLMUserText(text, incomingMessage)

  await trace(traceId, 'router.deepseek_payload', {
    dialog_id: dialog.id,
    status_id: dialog.status_id,
    prompt_id: promptId,
    system_prompt: fullPrompt,
    user_context: userContext,
    history,
    user_message: llmText,
  })

  const result = await callDeepSeek(fullPrompt, userContext, history, llmText)

  await trace(traceId, 'router.deepseek_response', {
    reply: result.reply,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    model: result.model,
  })

  await trace(traceId, 'router.send_skipped', {
    reason: 'DEBUG_NO_SEND=true',
    user_id: userId,
  })
}

async function isAlreadyReplied(messageId) {
  if (!messageId) return false

  const { data, error } = await supabase
    .from('message')
    .select('is_replied')
    .eq('id', messageId)
    .maybeSingle()

  if (error) {
    await log('router', 'Ошибка проверки is_replied', { error: error.message, messageId }, 'error')
    return false
  }

  return Boolean(data?.is_replied)
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

async function handleStatus12({ dialog, userId, text, userContext, incomingMessageId, traceId }) {
  const dialogId = dialog.id
  const incomingMessage = await getIncomingMessage(incomingMessageId)
  const projectedUserMsgCount = (dialog.user_message_count ?? 0) + 1

  // Если дошли до 30 сообщений и free ещё не оказана -> переводим в status 3
  if (!dialog.free_service_done && projectedUserMsgCount >= 30) {
    return await handleStatus3({
      dialog: {
        ...dialog,
        status_id: 3,
        user_message_count: projectedUserMsgCount,
      },
      userId,
      text,
      userContext,
      incomingMessageId,
      traceId,
      firstEntryToStatus3: true,
    })
  }

  const prompt = await getPrompt(1)
  const productDescription = await getProduct(1)
  const fullPrompt = buildFullPrompt(prompt, productDescription)
  const history = await getHistory(dialogId)
  const llmText = buildLLMUserText(text, incomingMessage)

  await trace(traceId, 'router.deepseek_payload', {
    dialog_id: dialog.id,
    status_id: dialog.status_id,
    prompt_id: 1,
    system_prompt: fullPrompt,
    user_context: userContext,
    history,
    user_message: llmText,
  })

  const { reply: rawReply, inputTokens, outputTokens, model: usedModel } =
    await callLLM({ prompt: fullPrompt, userContext, history, text: llmText, source: 'status-1-2' })

  await trace(traceId, 'router.deepseek_response', {
    reply: rawReply,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model: usedModel,
  })

  const diagnosisDone = rawReply.includes(DIAGNOSIS_MARKER)
  const reply = rawReply.replace(DIAGNOSIS_MARKER, '').trim()

  await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
  await trace(traceId, 'router.post_llm_saveReply_done', {
    dialog_id: dialogId,
    incoming_message_id: incomingMessageId,
    used_model: usedModel,
  })

  await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
  await trace(traceId, 'router.post_llm_saveTokens_done', {
    dialog_id: dialogId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    used_model: usedModel,
  })

  await markReplied(incomingMessageId)
  await trace(traceId, 'router.post_llm_markReplied_done', {
    incoming_message_id: incomingMessageId,
  })

  const updateFields = {
    message_count: (dialog.message_count ?? 0) + 1,
    user_message_count: projectedUserMsgCount,
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
    status_id: 2,
  }

  if (diagnosisDone) {
    const freeDoneAt = new Date().toISOString()
    updateFields.free_service_done = true
    updateFields.free_done_at = freeDoneAt
    updateFields.status_id = 4
    updateFields.prompt_3_scheduled_at = new Date(Date.now() + 12 * 60 * 1000).toISOString()
  }

  await updateDialog(dialogId, updateFields)
  await trace(traceId, 'router.post_llm_updateDialog_done', {
    dialog_id: dialogId,
    update_fields: updateFields,
  })

  await maybeSendMessage({
    userId,
    text: reply,
    traceId,
    statusId: updateFields.status_id,
    extra: { prompt_id: 1 },
  })
}

// ── STATUS 3 — бесплатная услуга не оказана ───────────────────────────────

async function handleStatus3({
  dialog,
  userId,
  text,
  userContext,
  incomingMessageId,
  traceId,
  firstEntryToStatus3 = false,
}) {
  const dialogId = dialog.id
  const incomingMessage = await getIncomingMessage(incomingMessageId)

  // Первый вход в status 3 -> отрабатываем prompt 2 и ставим таймер на prompt 3
  if (firstEntryToStatus3 || !dialog.prompt_3_scheduled_at) {
    const prompt = await getPrompt(2)
    const history = await getHistory(dialogId)
    const llmText = buildLLMUserText(text, incomingMessage)

    await trace(traceId, 'router.deepseek_payload', {
      dialog_id: dialog.id,
      status_id: 3,
      prompt_id: 2,
      system_prompt: prompt,
      user_context: userContext,
      history,
      user_message: llmText,
    })

    const { reply, inputTokens, outputTokens, model: usedModel } =
      await callLLM({ prompt, userContext, history, text: llmText, source: 'status-3' })

    await trace(traceId, 'router.deepseek_response', {
      reply,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      model: usedModel,
    })

    await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
    await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
    await markReplied(incomingMessageId)

    await updateDialog(dialogId, {
      status_id: 3,
      message_count: (dialog.message_count ?? 0) + 1,
      user_message_count: dialog.user_message_count ?? 30,
      last_message_at: new Date().toISOString(),
      last_message_by: 'bot',
      prompt_3_scheduled_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })

    await maybeSendMessage({
      userId,
      text: reply,
      traceId,
      statusId: 3,
      extra: { prompt_id: 2 },
    })
    return
  }

  // Если таймер ещё не истёк -> молчим
  const scheduledAt = new Date(dialog.prompt_3_scheduled_at)
  const now = new Date()

  if (now < scheduledAt) {
    await trace(traceId, 'router.ignored_by_status', {
      dialog_id: dialogId,
      status_id: 3,
      reason: 'waiting_prompt_3_timeout',
      prompt_3_scheduled_at: dialog.prompt_3_scheduled_at,
    })
    await markReplied(incomingMessageId)
    return
  }

  // Если 10 минут прошли -> отправляем статичный prompt 3 и переводим в status 5
  const staticText = await getStaticPrompt(3)
  if (!staticText) {
    await log('status-3', 'Не найден static prompt 3', { dialogId }, 'error')
    return
  }

  await saveReply({
    dialogId,
    userId,
    reply: staticText,
    usedModel: 'static',
    replyToId: null,
  })

  await updateDialog(dialogId, {
    status_id: 5,
    offer_sent_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
  })

  await markReplied(incomingMessageId)

  await maybeSendMessage({
    userId,
    text: staticText,
    traceId,
    statusId: 3,
    extra: { prompt_id: 3, static: true },
  })
}

// ── STATUS 4 — бесплатная услуга оказана ─────────────────────────────────────

async function handleStatus4({ dialog, userId, incomingMessageId, traceId }) {
  const dialogId = dialog.id
  const scheduledAt = dialog.prompt_3_scheduled_at ? new Date(dialog.prompt_3_scheduled_at) : null
  const now = new Date()

  if (!scheduledAt || now < scheduledAt) {
    await trace(traceId, 'router.ignored_by_status', {
      dialog_id: dialogId,
      status_id: 4,
      free_service_done: dialog.free_service_done,
      reason: 'waiting_prompt_3_timeout',
      prompt_3_scheduled_at: dialog.prompt_3_scheduled_at,
    })
    await markReplied(incomingMessageId)
    return
  }

  const staticText = await getStaticPrompt(3)
  if (!staticText) {
    await log('status-4', 'Не найден static prompt 3', { dialogId }, 'error')
    return
  }

  await saveReply({
    dialogId,
    userId,
    reply: staticText,
    usedModel: 'static',
    replyToId: null,
  })

  await updateDialog(dialogId, {
    status_id: 5,
    offer_sent_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
  })

  await markReplied(incomingMessageId)

  await maybeSendMessage({
    userId,
    text: staticText,
    traceId,
    statusId: 4,
    extra: { prompt_id: 3, static: true },
  })
}

// ── STATUS 5 — Продажа продукта ──────────────────────────────────────────────

async function handleStatus5({ dialog, userId, text, userContext, incomingMessageId, traceId }) {
  const dialogId = dialog.id
  const incomingMessage = await getIncomingMessage(incomingMessageId)
  const prompt = await getPrompt(4)
  const history = await getHistory(dialogId)
  const llmText = buildLLMUserText(text, incomingMessage)

  await trace(traceId, 'router.deepseek_payload', {
    dialog_id: dialog.id,
    status_id: 5,
    prompt_id: 4,
    system_prompt: prompt,
    user_context: userContext,
    history,
    user_message: llmText,
  })

  const { reply, inputTokens, outputTokens, model: usedModel } =
    await callLLM({ prompt, userContext, history, text: llmText, source: 'status-5' })

  await trace(traceId, 'router.deepseek_response', {
    reply,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model: usedModel,
  })

  await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
  await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
  await markReplied(incomingMessageId)

  await updateDialog(dialogId, {
    message_count: (dialog.message_count ?? 0) + 1,
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
    status_id: 5,
  })

  await maybeSendMessage({
    userId,
    text: reply,
    traceId,
    statusId: 5,
    extra: { prompt_id: 4 },
  })
}

// ── STATUS 6 — Ведение по продукту ───────────────────────────────────────────

async function handleStatus6({ dialog, userId, text, userContext, incomingMessageId, traceId }) {
  const dialogId = dialog.id
  const incomingMessage = await getIncomingMessage(incomingMessageId)

  const prompt = await getPrompt(5)

  const { data: product } = await supabase
    .from('product')
    .select('name, description')
    .eq('product_id', dialog.product_id ?? 1)
    .maybeSingle()

  const productContext = product
    ? `

Продукт:
${product.name}

${product.description}`
    : ''

  const fullPrompt = (prompt ?? '') + productContext
  const history = await getHistory(dialogId)
  const llmText = buildLLMUserText(text, incomingMessage)

  await trace(traceId, 'router.deepseek_payload', {
    dialog_id: dialog.id,
    status_id: 6,
    prompt_id: 5,
    system_prompt: fullPrompt,
    user_context: userContext,
    history,
    user_message: llmText,
  })

  const { reply, inputTokens, outputTokens, model: usedModel } =
    await callLLM({ prompt: fullPrompt, userContext, history, text: llmText, source: 'status-6' })

  await trace(traceId, 'router.deepseek_response', {
    reply,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model: usedModel,
  })

  await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
  await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
  await markReplied(incomingMessageId)

  await updateDialog(dialogId, {
    message_count: (dialog.message_count ?? 0) + 1,
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
    status_id: 6,
  })

  await maybeSendMessage({
    userId,
    text: reply,
    traceId,
    statusId: 6,
    extra: { prompt_id: 5, product_id: dialog.product_id ?? 1 },
  })
}


// ── STATUS 7 — Завершение ────────────────────────────────────────────────────

async function handleStatus7({ dialog, userId, text, userContext, incomingMessageId, traceId }) {
  const dialogId = dialog.id
  const incomingMessage = await getIncomingMessage(incomingMessageId)
  const prompt = await getPrompt(6)
  const history = await getHistory(dialogId, 50)
  const llmText = buildLLMUserText(text, incomingMessage)

  await trace(traceId, 'router.deepseek_payload', {
    dialog_id: dialog.id,
    status_id: 7,
    prompt_id: 6,
    system_prompt: prompt,
    user_context: userContext,
    history,
    user_message: llmText,
  })

  const { reply, inputTokens, outputTokens, model: usedModel } =
    await callLLM({ prompt, userContext, history, text: llmText, source: 'status-7' })

  await trace(traceId, 'router.deepseek_response', {
    reply,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model: usedModel,
  })

  await saveReply({ dialogId, userId, reply, usedModel, replyToId: incomingMessageId })
  await saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel })
  await markReplied(incomingMessageId)

  await updateDialog(dialogId, {
    message_count: (dialog.message_count ?? 0) + 1,
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
    status_id: 3,
  })

  await maybeSendMessage({
    userId,
    text: reply,
    traceId,
    statusId: 7,
    extra: { prompt_id: 6 },
  })
}


// ── Главный handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  // Сразу отвечаем VK — не ждём обработки
  res.status(200).send('ok')

  const { user_id, text, first_name, sex, incoming_message_id, trace_id } = req.body
  if (!user_id) return

  try {
    await trace(trace_id, 'router.request_received', req.body)

    if (incoming_message_id && await isAlreadyReplied(incoming_message_id)) {
      await log('router', 'Сообщение уже обработано — пропускаем', { incoming_message_id })
      return
    }

    await log('router', 'Входящее сообщение', { user_id, text })

    const dialog = await getDialog(user_id)

    await trace(trace_id, 'router.dialog_loaded', {
      dialog_id: dialog?.id ?? null,
      status_id: dialog?.status_id ?? null,
      user_message_count: dialog?.user_message_count ?? null,
    })

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


    const ctx = {
      dialog,
      userId: user_id,
      text,
      userContext,
      incomingMessageId: incoming_message_id,
      traceId: trace_id,
    }

    const statusId = dialog.status_id

    if (statusId === 1 || statusId === 2) { await handleStatus12(ctx); return }
    if (statusId === 3)                   { await handleStatus3(ctx);  return }
    if (statusId === 4)                   { await handleStatus4(ctx);  return }
    if (statusId === 5)                   { await handleStatus5(ctx);  return }
    if (statusId === 6)                   { await handleStatus6(ctx);  return }
    if (statusId === 7)                   { await handleStatus7(ctx);  return }

    await trace(trace_id, 'router.ignored_by_status', {
      dialog_id: dialog.id,
      status_id: statusId,
      free_service_done: dialog.free_service_done,
      reason: 'status_not_in_flow',
    })

  } catch (err) {
    await log('router', 'ОШИБКА', { error: err.message }, 'error')
  }
}
