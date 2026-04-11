import { supabase } from '../lib/supabase.js'
import { callDeepSeek } from '../lib/deepseek.js'
import { sendMessage } from '../lib/vk.js'
import { log } from '../lib/logger.js'
import { trace } from '../lib/debug-trace.js'
import { initPaymentUrl } from '../lib/getplatinum.js'

const DIAGNOSIS_MARKER = '[ДИАГНОСТИКА_ВЫПОЛНЕНА]'
const PAYMENT_LINK_TRIGGER_RE = /(давай ссылку|хочу ссылку|хочу оплатить|готов оплатить|оплатить|оплачиваю|беру)/i
const TEST_PAYMENT_AMOUNT = 1000
const PAID_PRODUCT_ID = 2
const PRODUCT_CYCLE_REPLY_GRACE_MINUTES = Number(process.env.PRODUCT_CYCLE_REPLY_GRACE_MINUTES ?? 3)

function maybePushNextActionAt(dialog) {
  if (!dialog?.next_action_at || dialog?.cycle_completed_at) return {}

  const currentNextActionAt = new Date(dialog.next_action_at)
  if (Number.isNaN(currentNextActionAt.getTime())) return {}

  const minNextActionAt = new Date(Date.now() + PRODUCT_CYCLE_REPLY_GRACE_MINUTES * 60 * 1000)
  if (currentNextActionAt >= minNextActionAt) return {}

  return { next_action_at: minNextActionAt.toISOString() }
}



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

function buildPalmPhotoGuard(incomingMessage) {
  const attachmentTypes = String(incomingMessage?.attachment_types ?? '')
  if (!attachmentTypes.includes('photo')) return ''

  return `

Дополнительные правила для фото ладони:
- Если в "Описание вложения от системы" есть verdict: not_palm, значит это не ладонь или ладонь не видна со стороны линий. В таком случае не делай диагностику, не выдумывай линии и не ставь ${DIAGNOSIS_MARKER}. Коротко скажи, что на фото не ладонь, и попроси прислать фото раскрытой ладони целиком.
- Если в "Описание вложения от системы" есть verdict: unclear, значит ладонь видна недостаточно хорошо. В таком случае не делай полный анализ и не ставь ${DIAGNOSIS_MARKER}. Скажи, что качество или ракурс слабые, коротко перечисли, что всё же удалось разобрать по описанию, и попроси более чёткое фото.
- Делай полноценный анализ ладони только если в описании есть verdict: palm и видимые линии.
- Не придумывай линии и детали, которых нет в описании.`
}

function buildNoRepeatGreetingGuard(history) {
  const hasAssistantHistory = Array.isArray(history) && history.some(item => item.role === 'assistant')

  if (!hasAssistantHistory) return ''

  return `

Правило продолжения диалога:
- Диалог уже начат, поэтому не здоровайся повторно.
- Не пиши "привет", "приветствую", "рада тебя видеть" и подобные фразы.
- Сразу отвечай по сути последнего вопроса пользователя.`
}

function hasCompletedPaidCycle(dialog) {
  return Boolean(dialog?.cycle_completed_at)
}

function buildPostProductSalesGuard(dialog) {
  if (!hasCompletedPaidCycle(dialog)) return ''

  return `

Контекст продажи:
- Клиент уже завершил предыдущую платную практику.
- Нельзя продавать ему этот же продукт повторно как следующий шаг по умолчанию.
- Твоя задача теперь — мягкий cross-sell: помоги выбрать следующее направление из вариантов: деньги, отношения, реализация, состояние.
- Если клиент уже назвал направление, предложи следующий релевантный продукт или формат работы под этот запрос.
- Не отправляй ссылку на оплату сразу после первого же запроса на ссылку. Сначала уточни направление или подтверди, какой следующий продукт ему подходит.
- Не описывай это как повтор прошлой практики.`
}

function buildPaymentLinkMarkerGuard() {
  return `

Техническое правило оплаты:
- Если клиент явно просит прислать ссылку на оплату, готов платить, хочет оплатить или подтверждает покупку уже выбранной практики, добавь В САМОМ КОНЦЕ ответа отдельной строкой маркер СТРОГО в таком виде:
[SEND_PAYMENT_LINK]
offer_name: <краткое название выбранной практики>

- Используй маркер только если уже понятно, какую именно практику клиент хочет купить.
- Никогда не пиши фейковые конструкции вроде "[ссылка будет здесь]" или "[ссылка на оплату]".
- Никогда не вставляй саму ссылку текстом — ссылку отправит система.
- Не пиши числовую сумму оплаты в тексте ответа. Сумму и ссылку отправит система сама.
- Если практика ещё не выбрана, сначала уточни, что именно клиент хочет купить, и не добавляй маркер.`
}

function extractPaymentLinkDecision(reply) {
  const text = String(reply ?? '')

  const markerRegex = /\[\s*send[\s_]*payment[\s_]*link\s*\]/i
  const offerRegex = /^\s*offer_name:\s*(.+)$/im

  const hasMarker = markerRegex.test(text)
  const offerMatch = text.match(offerRegex)

  const cleaned = text
    .replace(/\[\s*send[\s_]*payment[\s_]*link\s*\]/gi, '')
    .replace(/^\s*offer_name:\s*.+$/gim, '')
    .replace(/\[ссылка.*?\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    shouldSend: hasMarker || Boolean(offerMatch),
    offerName: offerMatch?.[1]?.trim() || null,
    cleanedReply: cleaned,
  }
}

function formatRubFromMinor(amountMinor) {
  const rub = Number(amountMinor ?? 0) / 100
  if (Number.isInteger(rub)) return `${rub} ₽`
  return `${rub.toFixed(2).replace('.', ',')} ₽`
}

function isReadyToStartMessage(text) {
  const t = String(text ?? '').toLowerCase()
  return /\b(готов|готова|готов начать|готова начать|давай начн[её]м|можно начинать|начинаем|поехали)\b/.test(t)
}

function parseJsonMaybe(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

async function getLatestPaidOfferMeta(dialogId) {
  const { data, error } = await supabase
    .from('payment')
    .select('raw_callback, raw_init, created_at')
    .eq('dialog_id', dialogId)
    .eq('status', 'paid')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  if (!data) return { offerName: null }

  const callback = parseJsonMaybe(data.raw_callback)
  const init = parseJsonMaybe(data.raw_init)

  return {
    offerName:
      callback?.customParams?.offerName
      ?? init?.customParams?.offerName
      ?? null,
  }
}

function buildGenericPaidPrompt(offerName) {
  return `Ты — Анна, таролог, хиромант и астролог. Человек оплатил практику "${offerName || 'выбранная практика'}", и ты сопровождаешь его в процессе.

Тебе доступна вся история переписки.

Правила:
- Не подменяй название практики на другую.
- Не говори про финансовый поток, если клиент купил не финансовую практику.
- Поддерживай человека спокойно и по делу.
- Если клиент спрашивает, когда старт, а работа ещё не начата, мягко напомни, что старт будет после его подтверждения готовности.
- Не обещай автоматический следующий шаг, если цикл ещё не запущен.`
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
  const history = await getHistory(dialogId)
  const fullPrompt =
    buildFullPrompt(prompt, productDescription) +
    buildPalmPhotoGuard(incomingMessage) +
    buildNoRepeatGreetingGuard(history)
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
      system_prompt: fullPrompt,
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


function isPaymentLinkRequest(text) {
  return PAYMENT_LINK_TRIGGER_RE.test((text ?? '').trim())
}

async function handleStatus5PostProductQualification({ dialog, userId, firstName, incomingMessageId, traceId }) {
  const dialogId = dialog.id
  const name = (firstName ?? 'Клиент').trim() || 'Клиент'
  const reply = `${name}, прошлую практику мы уже завершили. Чтобы я не отправила тебе тот же шаг повторно, давай сначала уточним, что сейчас для тебя важнее всего: деньги, отношения, реализация или внутреннее состояние. Напиши одно направление — и я подберу следующий продукт под твой запрос.`

  await saveReply({
    dialogId,
    userId,
    reply,
    usedModel: 'system-cross-sell',
    replyToId: incomingMessageId,
  })

  await markReplied(incomingMessageId)

  await updateDialog(dialogId, {
    status_id: 5,
    message_count: (dialog.message_count ?? 0) + 1,
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
  })

  await maybeSendMessage({
    userId,
    text: reply,
    traceId,
    statusId: 5,
    extra: { prompt_id: 'post_product_cross_sell_gate' },
  })
}

async function handleStatus5PaymentLink({ dialog, userId, firstName, incomingMessageId, traceId, offerName = null, prefaceText = null }) {
  const dialogId = dialog.id
  const amount = TEST_PAYMENT_AMOUNT
  const amountLabel = formatRubFromMinor(amount)
  const offerLabel = (offerName ?? '').trim() || 'выбранной практики'
  const email = process.env.GETPLATINUM_TEST_EMAIL ?? null
  const phone = process.env.GETPLATINUM_TEST_PHONE ?? null
  const notificationUrl = process.env.GETPLATINUM_NOTIFICATION_URL ?? null
  const successUrl = process.env.GETPLATINUM_SUCCESS_URL ?? null
  const failUrl = process.env.GETPLATINUM_FAIL_URL ?? null
  const name = (firstName ?? 'Клиент').trim() || 'Клиент'

  try {
    if (!email && !phone) {
      throw new Error('GETPLATINUM_TEST_EMAIL or GETPLATINUM_TEST_PHONE is required')
    }

    if (!notificationUrl || !successUrl || !failUrl) {
      throw new Error('GetPlatinum notification/success/fail URLs are not configured')
    }

    const dealId = `vk-${dialogId}-${Date.now()}`
    await trace(traceId, 'router.getplatinum_payment_payload_preview', {
      dialog_id: dialogId,
      deal_id: dealId,
      amount,
      currency: 'RUB',
      client_id: `vk-${userId}`,
      email,
      phone,
      notification_url: notificationUrl,
      success_url: successUrl,
      fail_url: failUrl,
      position_prefix: 9,
      position_prefix_type: typeof 9,
      vat: 'none',
    })

    const init = await initPaymentUrl({
      dealId,
      amount,
      currency: 'RUB',
      title: `Тестовая оплата: ${offerLabel}`,
      clientId: `vk-${userId}`,
      email,
      phone,
      name,
      notificationUrl,
      successUrl,
      failUrl,
      customParams: {
        dialogId,
        vkUserId: userId,
        productId: PAID_PRODUCT_ID,
        offerName: offerLabel,
        source: 'vk_bot',
      },
      positionPrefix: 9,
      vat: 'none',
    })

    await trace(traceId, 'router.getplatinum_payment_link_created', {
      dialog_id: dialogId,
      deal_id: dealId,
      amount,
      form_url: init.formUrl,
    })

    const { error: paymentErr } = await supabase
      .from('payment')
      .insert({
        dialog_id: dialogId,
        vk_user_id: userId,
        deal_id: dealId,
        amount,
        currency: 'RUB',
        status: 'created',
        provider: 'getplatinum',
        form_url: init.formUrl,
        raw_init: init,
      })

    if (paymentErr) throw paymentErr

    await trace(traceId, 'router.payment_saved', {
      dialog_id: dialogId,
      deal_id: dealId,
    })

    const reply = `${name}, вот ссылка на тестовую оплату ${amountLabel} для практики «${offerLabel}»:
${init.formUrl}

Как только оплата пройдёт, я увижу подтверждение и напишу тебе дальше.`

    await saveReply({
      dialogId,
      userId,
      reply,
      usedModel: 'getplatinum-link',
      replyToId: incomingMessageId,
    })

    await markReplied(incomingMessageId)

    await updateDialog(dialogId, {
      status_id: 5,
      message_count: (dialog.message_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
      last_message_by: 'bot',
    })

    await maybeSendMessage({
      userId,
      text: reply,
      traceId,
      statusId: 5,
      extra: {
        prompt_id: 'getplatinum_link',
        deal_id: dealId,
      },
    })

  } catch (err) {
    await trace(traceId, 'router.getplatinum_payment_link_failed', {
      dialog_id: dialogId,
      error: err.message,
    }, 'error')

    const fallback = 'Не смогла сейчас сформировать ссылку на оплату. Это технический момент. Попробуй ещё раз через минуту.'

    await saveReply({
      dialogId,
      userId,
      reply: fallback,
      usedModel: 'system',
      replyToId: incomingMessageId,
    })

    await markReplied(incomingMessageId)

    await updateDialog(dialogId, {
      status_id: 5,
      message_count: (dialog.message_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
      last_message_by: 'bot',
    })

    await maybeSendMessage({
      userId,
      text: fallback,
      traceId,
      statusId: 5,
      extra: {
        prompt_id: 'getplatinum_link_error',
      },
    })
  }
}

// ── STATUS 5 — Продажа продукта ──────────────────────────────────────────────

async function handleStatus5({ dialog, userId, text, userContext, incomingMessageId, traceId, firstName }) {
  const dialogId = dialog.id

  const incomingMessage = await getIncomingMessage(incomingMessageId)
  const prompt = await getPrompt(4)
  const fullPrompt =
    (prompt ?? '') +
    buildPostProductSalesGuard(dialog) +
    buildPaymentLinkMarkerGuard()
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
    await callLLM({ prompt: fullPrompt, userContext, history, text: llmText, source: 'status-5' })

  await trace(traceId, 'router.deepseek_response', {
    reply,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model: usedModel,
  })

  const paymentDecision = extractPaymentLinkDecision(reply)
  const shouldSendLink =
    paymentDecision.shouldSend ||
    (isPaymentLinkRequest(text) && !hasCompletedPaidCycle(dialog))

  if (shouldSendLink) {
    return await handleStatus5PaymentLink({
      dialog,
      userId,
      firstName,
      incomingMessageId,
      traceId,
      offerName: paymentDecision.offerName,
      prefaceText: paymentDecision.cleanedReply || 'Отправляю ссылку на оплату.',
    })
  }

  await saveReply({ dialogId, userId, reply: paymentDecision.cleanedReply || reply, usedModel, replyToId: incomingMessageId })
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
  const paidOfferMeta = await getLatestPaidOfferMeta(dialogId)
  const offerName = paidOfferMeta.offerName ?? null

  if (!dialog.cycle_started_at) {
    const ready = isReadyToStartMessage(text)

    const reply = ready
      ? `${userContext.includes('Имя клиента:') ? '' : ''}${offerName ? `Отлично, начинаю практику «${offerName}».` : 'Отлично, начинаю работу.'} Первый этап уже запущен. Следующий шаг пришлю сюда автоматически.`
      : `${offerName ? `Вижу оплату за практику «${offerName}», спасибо большое.` : 'Вижу оплату, спасибо большое.'} Когда будешь готов начать, просто напиши мне сюда: «готов начать».`

    await saveReply({ dialogId, userId, reply, usedModel: 'system-status-6', replyToId: incomingMessageId })
    await markReplied(incomingMessageId)

    await updateDialog(dialogId, {
      message_count: (dialog.message_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
      last_message_by: 'bot',
      status_id: 6,
      product_step: ready ? 1 : 0,
      cycle_started_at: ready ? new Date().toISOString() : null,
      next_action_at: ready ? plusMinutesIso(PRODUCT_CYCLE_REPLY_GRACE_MINUTES + 2) : null,
    })

    await maybeSendMessage({
      userId,
      text: reply,
      traceId,
      statusId: 6,
      extra: { prompt_id: ready ? 'status6_manual_start' : 'status6_wait_ready', offer_name: offerName },
    })
    return
  }

  const prompt = await getPrompt(5)
  const basePrompt =
    offerName && offerName !== 'Настройка финансового изобилия'
      ? buildGenericPaidPrompt(offerName)
      : prompt

  const orchestrationGuard = dialog.next_action_at && !dialog.cycle_completed_at
    ? `

Системное правило: автоэтап уже запланирован системой. Ты можешь поддержать человека и объяснить текущий процесс, но не обещай точное время, не придумывай новые этапы и не говори, что сама напишешь раньше запланированного шага.`
    : `

Системное правило: не обещай, что сама напишешь позже, если следующий автошаг не запланирован системой.`

  const fullPrompt = (basePrompt ?? '') + orchestrationGuard
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

  const nextActionPatch = maybePushNextActionAt(dialog)

  await updateDialog(dialogId, {
    message_count: (dialog.message_count ?? 0) + 1,
    last_message_at: new Date().toISOString(),
    last_message_by: 'bot',
    status_id: 6,
    ...nextActionPatch,
  })

  await maybeSendMessage({
    userId,
    text: reply,
    traceId,
    statusId: 6,
    extra: { prompt_id: 5, offer_name: offerName },
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
    status_id: 7,
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
      firstName: first_name,
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
