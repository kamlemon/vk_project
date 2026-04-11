import { supabase } from '../lib/supabase.js'
import { sendMessage } from '../lib/vk.js'
import { callDeepSeek } from '../lib/deepseek.js'
import { trace } from '../lib/debug-trace.js'

const DELIVERY_GAP_MINUTES = Number(process.env.TAROT_DELIVERY_GAP_MINUTES ?? 1)
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL ?? 'https://vkproject-gamma.vercel.app').replace(/\/$/, '')

function plusMinutesIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeText(text) {
  return String(text ?? '')
    .replace(/[—–]/g, '-')
    .replace(/\u00A0/g, ' ')
    .trim()
}

function getPositionLabel(cardsCount, step) {
  if (cardsCount === 3) {
    return ['что сейчас происходит', 'что важно учесть', 'к чему ведёт'][step - 1] ?? 'позиция расклада'
  }

  return ['что сейчас происходит', 'корень ситуации', 'что скрыто', 'как будет развиваться', 'итог'][step - 1] ?? 'позиция расклада'
}

function getCardCode(reading, step) {
  return reading[`card_${step}_code`] ?? null
}

function getCardReversed(reading, step) {
  return Boolean(reading[`card_${step}_reversed`])
}

function buildCardImageUrl(fileName) {
  if (!fileName) return null
  return `${PUBLIC_BASE_URL}/tarot/rws/${fileName}`
}

async function getReadyDialogs() {
  const { data, error } = await supabase
    .from('dialog')
    .select('id, vk_user_id, status_id, current_reading_id, next_action_at, message_count, selected_topic, selected_product_id')
    .eq('status_id', 6)
    .not('current_reading_id', 'is', null)

  if (error) throw error

  const now = Date.now()

  return (data ?? []).filter(dialog => {
    if (!dialog.next_action_at) return true
    const ts = new Date(dialog.next_action_at).getTime()
    if (Number.isNaN(ts)) return true
    return ts <= now
  })
}

async function getReading(readingId) {
  const { data, error } = await supabase
    .from('tarot_reading')
    .select('*')
    .eq('id', readingId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getCardsByCodes(cardCodes) {
  const cleanCodes = [...new Set(cardCodes.filter(Boolean))]
  if (!cleanCodes.length) return {}

  const { data, error } = await supabase
    .from('tarot_card')
    .select('card_code, russian_name, english_name, file_name, meaning_upright, meaning_reversed')
    .in('card_code', cleanCodes)

  if (error) throw error

  return Object.fromEntries((data ?? []).map(card => [card.card_code, card]))
}

async function getHistory(dialogId, limit = 12) {
  const { data } = await supabase
    .from('message')
    .select('text, direction')
    .eq('dialog_id', dialogId)
    .order('dt_create', { ascending: false })
    .limit(limit)

  if (!data) return []

  return data.reverse().map(item => ({
    role: item.direction === 'out' ? 'assistant' : 'user',
    content: item.text ?? '',
  }))
}

async function saveReply({ dialogId, userId, reply, usedModel = 'tarot-cron' }) {
  await supabase.from('message').insert({
    dialog_id: dialogId,
    from_id: userId,
    peer_id: userId,
    direction: 'out',
    text: normalizeText(reply),
    msg_date: nowIso(),
    raw_json: { source: 'cron-tarot-readings', model: usedModel },
  })
}

async function saveTokens({ userId, dialogId, inputTokens, outputTokens, usedModel }) {
  if (!inputTokens && !outputTokens) return

  await supabase.from('token_usage').insert({
    vk_user_id: userId,
    dialog_id: dialogId,
    prompt_tokens: inputTokens ?? 0,
    candidates_tokens: outputTokens ?? 0,
    total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    model_version: usedModel,
  })
}

async function updateDialog(dialogId, fields) {
  const { error } = await supabase
    .from('dialog')
    .update(fields)
    .eq('id', dialogId)

  if (error) throw error
}

async function updateReading(readingId, fields) {
  const { error } = await supabase
    .from('tarot_reading')
    .update(fields)
    .eq('id', readingId)

  if (error) throw error
}

function buildIntroMessage(reading) {
  const topic = reading.topic ? ` по теме «${reading.topic}»` : ''
  const cardsLabel = reading.cards_count === 3 ? '3 карты' : '5 карт'

  return normalizeText(`Оплату вижу, спасибо.

Начинаю расклад на ${cardsLabel}${topic}. Буду присылать карты по одной, чтобы всё было удобно читать и сразу разбирать по смыслу.`)
}

function buildCardFallback({ reading, card, step }) {
  const positionLabel = getPositionLabel(reading.cards_count, step)
  const reversed = getCardReversed(reading, step)
  const cardName = card?.russian_name ?? card?.english_name ?? 'Неизвестная карта'
  const orientation = reversed ? 'перевернутое положение' : 'прямое положение'
  const meaning = reversed ? card?.meaning_reversed : card?.meaning_upright
  const topic = reading.topic ? ` по теме «${reading.topic}»` : ''
  const imageUrl = buildCardImageUrl(card?.file_name)

  return normalizeText(`Карта ${step}/${reading.cards_count} - ${cardName} (${orientation}).

В позиции «${positionLabel}»${topic} она обычно показывает: ${meaning ?? 'смысл карты сейчас проявлен неочевидно, но общий вектор читается как важный поворот и необходимость внимательнее посмотреть на детали.'}

${imageUrl ? `Карта: ${imageUrl}` : ''}`)
}

function buildSummaryFallback({ reading, cards }) {
  const topic = reading.topic ? `по теме «${reading.topic}»` : 'по твоему запросу'
  const names = cards.map(card => card?.russian_name ?? card?.english_name).filter(Boolean).join(', ')

  return normalizeText(`Если собрать расклад целиком, то ${topic} сейчас показывает такой рисунок: ${names}.

Здесь не про резкий разворот, а скорее про понимание, что именно уже назрело, что требует внимания и куда ситуация тянется дальше. Главное сейчас - не спешить с выводами, а смотреть на общий смысл карт вместе.`)
}

async function buildCardMessage({ reading, card, step, history }) {
  const reversed = getCardReversed(reading, step)
  const cardName = card?.russian_name ?? card?.english_name ?? 'Неизвестная карта'
  const orientation = reversed ? 'перевернутое положение' : 'прямое положение'
  const positionLabel = getPositionLabel(reading.cards_count, step)
  const baseMeaning = reversed ? card?.meaning_reversed : card?.meaning_upright
  const imageUrl = buildCardImageUrl(card?.file_name)

  const prompt = `Ты - Анна, таролог. Сейчас ты выдаешь клиенту одну карту из уже оплаченного расклада.

Пиши:
- спокойно
- по-человечески
- без пафоса
- без слишком длинных вступлений
- без списков
- без длинного тире, используй обычный знак "-"
- 2-4 коротких абзаца максимум

Что нужно сделать:
- назвать карту и её положение
- коротко объяснить смысл карты именно в этой позиции расклада
- связать с темой клиента
- не обещать магических чудес
- не писать сухо
- не использовать фразы типа "как ИИ" и подобное`

  const llmText = `Тема расклада: ${reading.topic ?? 'общий вопрос'}
Вопрос клиента: ${reading.question_text ?? reading.topic ?? 'не уточнен'}
Формат: ${reading.cards_count} карт
Позиция карты: ${step} из ${reading.cards_count}
Смысл позиции: ${positionLabel}
Карта: ${cardName}
Положение: ${orientation}
Базовое значение: ${baseMeaning ?? 'не указано'}

Сделай короткий живой разбор одной карты для клиента.`

  try {
    const result = await callDeepSeek(prompt, '', history, llmText)
    const reply = normalizeText(`${result.reply}

${imageUrl ? `Карта: ${imageUrl}` : ''}`)

    return {
      reply,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
    }
  } catch {
    return {
      reply: buildCardFallback({ reading, card, step }),
      inputTokens: 0,
      outputTokens: 0,
      model: 'fallback',
    }
  }
}

async function buildSummaryMessage({ reading, cards, history }) {
  const prompt = `Ты - Анна, таролог. Сейчас ты завершаешь уже оплаченный расклад.

Пиши:
- спокойно
- по-человечески
- без пафоса
- без эзотерической театральности
- без списков
- без длинного тире, используй обычный знак "-"
- 2-4 коротких абзаца максимум

Что нужно сделать:
- собрать все карты в единый смысл
- дать человеку понятный общий вывод
- мягко закончить расклад
- не продавать новый продукт в этом сообщении`

  const cardsText = cards.map((card, idx) => {
    const reversed = getCardReversed(reading, idx + 1)
    return `Карта ${idx + 1}: ${card?.russian_name ?? card?.english_name ?? 'неизвестно'} (${reversed ? 'перевернутая' : 'прямая'}), базовое значение: ${reversed ? card?.meaning_reversed : card?.meaning_upright}`
  }).join('\n')

  const llmText = `Тема расклада: ${reading.topic ?? 'общий вопрос'}
Вопрос клиента: ${reading.question_text ?? reading.topic ?? 'не уточнен'}
Формат: ${reading.cards_count} карт

Карты:
${cardsText}

Сделай итоговый живой вывод по раскладу.`

  try {
    const result = await callDeepSeek(prompt, '', history, llmText)
    return {
      reply: normalizeText(result.reply),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
    }
  } catch {
    return {
      reply: buildSummaryFallback({ reading, cards }),
      inputTokens: 0,
      outputTokens: 0,
      model: 'fallback',
    }
  }
}

async function processDialog(dialog, baseTraceId) {
  const traceId = `${baseTraceId}-dialog-${dialog.id}`
  const reading = await getReading(dialog.current_reading_id)

  if (!reading) {
    await updateDialog(dialog.id, {
      current_reading_id: null,
      next_action_at: null,
    })

    return { dialog_id: dialog.id, skipped: true, reason: 'reading_not_found' }
  }

  const step = Number(reading.delivery_step ?? 0)
  const cardsCount = Number(reading.cards_count ?? 0)
  const cardCodes = [1, 2, 3, 4, 5].map(i => reading[`card_${i}_code`]).filter(Boolean)
  const cardMap = await getCardsByCodes(cardCodes)
  const history = await getHistory(dialog.id, 14)

  let reply = null
  let inputTokens = 0
  let outputTokens = 0
  let usedModel = 'tarot-cron'

  if (step === 0) {
    reply = buildIntroMessage(reading)
    usedModel = 'static-intro'
  } else if (step >= 1 && step <= cardsCount) {
    const cardCode = getCardCode(reading, step)
    const card = cardMap[cardCode]

    const built = await buildCardMessage({
      reading,
      card,
      step,
      history,
    })

    reply = built.reply
    inputTokens = built.inputTokens
    outputTokens = built.outputTokens
    usedModel = built.model
  } else if (step === cardsCount + 1) {
    const orderedCards = [1, 2, 3, 4, 5]
      .slice(0, cardsCount)
      .map(i => cardMap[reading[`card_${i}_code`]])
      .filter(Boolean)

    const built = await buildSummaryMessage({
      reading,
      cards: orderedCards,
      history,
    })

    reply = built.reply
    inputTokens = built.inputTokens
    outputTokens = built.outputTokens
    usedModel = built.model
  } else {
    return { dialog_id: dialog.id, skipped: true, reason: 'already_completed' }
  }

  await trace(traceId, 'cron.tarot_reading_send_attempt', {
    dialog_id: dialog.id,
    reading_id: reading.id,
    delivery_step: step,
    text_preview: reply.slice(0, 200),
  })

  const result = await sendMessage(dialog.vk_user_id, reply)

  await trace(traceId, 'cron.tarot_reading_send_success', {
    dialog_id: dialog.id,
    reading_id: reading.id,
    delivery_step: step,
    result,
  })

  await saveReply({
    dialogId: dialog.id,
    userId: dialog.vk_user_id,
    reply,
    usedModel,
  })

  await saveTokens({
    userId: dialog.vk_user_id,
    dialogId: dialog.id,
    inputTokens,
    outputTokens,
    usedModel,
  })

  const messageCount = Number(dialog.message_count ?? 0) + 1

  if (step === cardsCount + 1) {
    await updateReading(reading.id, {
      delivery_step: step + 1,
    })

    await updateDialog(dialog.id, {
      status_id: 7,
      current_reading_id: null,
      next_action_at: null,
      cycle_completed_at: nowIso(),
      last_message_at: nowIso(),
      last_message_by: 'bot',
      message_count: messageCount,
    })

    return {
      dialog_id: dialog.id,
      reading_id: reading.id,
      sent_step: step,
      done: true,
    }
  }

  await updateReading(reading.id, {
    delivery_step: step + 1,
  })

  await updateDialog(dialog.id, {
    status_id: 6,
    next_action_at: plusMinutesIso(DELIVERY_GAP_MINUTES),
    last_message_at: nowIso(),
    last_message_by: 'bot',
    message_count: messageCount,
  })

  return {
    dialog_id: dialog.id,
    reading_id: reading.id,
    sent_step: step,
    done: false,
  }
}

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }

  const traceId = `cron-tarot-readings-${Date.now()}`

  try {
    const dialogs = await getReadyDialogs()
    const sent = []
    const skipped = []

    for (const dialog of dialogs) {
      try {
        const result = await processDialog(dialog, traceId)
        if (result?.skipped) skipped.push(result)
        else sent.push(result)
      } catch (err) {
        skipped.push({
          dialog_id: dialog.id,
          reason: err.message,
        })

        await trace(`${traceId}-dialog-${dialog.id}`, 'cron.tarot_reading_failed', {
          dialog_id: dialog.id,
          error: err.message,
        }, 'error')
      }
    }

    return res.status(200).json({
      ok: true,
      sent,
      skipped,
    })
  } catch (err) {
    await trace(traceId, 'cron.tarot_readings_failed', {
      error: err.message,
    }, 'error')

    return res.status(500).json({
      ok: false,
      error: err.message,
    })
  }
}
