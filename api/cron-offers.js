import { supabase } from '../lib/supabase.js'
import { sendMessage } from '../lib/vk.js'
import { trace } from '../lib/debug-trace.js'
import { callDeepSeek } from '../lib/deepseek.js'

async function getStaticPrompt(promptId) {
  const { data, error } = await supabase
    .from('prompt')
    .select('prompt_content')
    .eq('prompt_id', promptId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error
  return data?.prompt_content ?? null
}

async function getMessagesAfterFree(dialogId, freeDoneAt) {
  const { data, error } = await supabase
    .from('message')
    .select('id, direction, text, attachment_trans, dt_create, is_replied')
    .eq('dialog_id', dialogId)
    .gt('dt_create', freeDoneAt)
    .order('dt_create', { ascending: true })

  if (error) throw error
  return data ?? []
}

function normalizeMessageContent(m) {
  const text = (m.text ?? '').trim()

  let trans = ''
  if (Array.isArray(m.attachment_trans)) {
    trans = m.attachment_trans.join('\n\n').trim()
  } else if (typeof m.attachment_trans === 'string') {
    trans = m.attachment_trans.trim()
  }

  if (text && trans) return `${text}\n\n[вложение]\n${trans}`
  if (text) return text
  if (trans) return `[вложение]\n${trans}`
  return ''
}

function buildHistory(messages) {
  return messages
    .map(m => {
      const content = normalizeMessageContent(m)
      if (!content) return null

      return {
        role: m.direction === 'out' ? 'assistant' : 'user',
        content,
      }
    })
    .filter(Boolean)
}

async function saveReply({ dialogId, userId, reply, usedModel = 'static' }) {
  const { error } = await supabase.from('message').insert({
    dialog_id: dialogId,
    from_id: userId,
    peer_id: userId,
    direction: 'out',
    text: reply,
    msg_date: new Date().toISOString(),
    reply_to_id: null,
    raw_json: { source: 'cron-offers', model: usedModel },
  })

  if (error) throw error
}

async function markIncomingAfterFreeReplied(dialogId, freeDoneAt) {
  const { error } = await supabase
    .from('message')
    .update({ is_replied: true })
    .eq('dialog_id', dialogId)
    .eq('direction', 'in')
    .gt('dt_create', freeDoneAt)

  if (error) throw error
}

async function buildWarmReply(history) {
  const prompt = `Ты — Анна, таролог, хиромант и астролог.
Клиент уже получил бесплатную диагностику.
После неё он написал ещё сообщения, и тебе нужно коротко, тепло и по-человечески ответить на них перед следующим сообщением с услугами.

Правила:
- ответ короткий, 1-2 абзаца
- покажи, что ты услышала клиента
- не перечисляй услуги
- не продавай в лоб
- не задавай больше одного вопроса
- не используй списки
- стиль живой, спокойный, уверенный`

  const userText = `Последние сообщения после бесплатной диагностики:\n\n${history
    .filter(x => x.role === 'user')
    .map(x => x.content)
    .join('\n\n---\n\n')}`

  const result = await callDeepSeek(prompt, '', history, userText)
  return result
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const traceId = `cron-offers-${Date.now()}`
  const now = new Date()

  try {
    const staticOffer = await getStaticPrompt(3)

    if (!staticOffer) {
      await trace(traceId, 'cron.offers_prompt_missing', { prompt_id: 3 }, 'error')
      return res.status(500).json({ ok: false, error: 'prompt_3_not_found' })
    }

    const { data: dialogs, error } = await supabase
      .from('dialog')
      .select('id, vk_user_id, status_id, free_done_at, prompt_3_scheduled_at, offer_sent_at, message_count, user_message_count')
      .eq('status_id', 4)
      .is('offer_sent_at', null)
      .not('prompt_3_scheduled_at', 'is', null)
      .limit(100)

    if (error) throw error

    const sent = []
    const skipped = []

    for (const dialog of dialogs ?? []) {
      const scheduledAt = new Date(dialog.prompt_3_scheduled_at)

      if (now < scheduledAt) {
        skipped.push({
          dialog_id: dialog.id,
          reason: 'waiting_prompt_3_timeout',
          prompt_3_scheduled_at: dialog.prompt_3_scheduled_at,
        })
        continue
      }

      const freeDoneAt = dialog.free_done_at ?? dialog.prompt_3_scheduled_at
      const messagesAfterFree = await getMessagesAfterFree(dialog.id, freeDoneAt)
      const history = buildHistory(messagesAfterFree)

      let warmReply = null
      let warmReplyModel = null

      if (history.some(x => x.role === 'user')) {
        const warm = await buildWarmReply(history)
        warmReply = (warm.reply ?? '').trim()
        warmReplyModel = warm.model ?? 'deepseek-chat'
      }

      if (warmReply) {
        await saveReply({
          dialogId: dialog.id,
          userId: dialog.vk_user_id,
          reply: warmReply,
          usedModel: warmReplyModel,
        })

        await sendMessage(dialog.vk_user_id, warmReply)

        await trace(traceId, 'cron.offer_warm_reply_sent', {
          dialog_id: dialog.id,
          user_id: dialog.vk_user_id,
          model: warmReplyModel,
          text_preview: warmReply.slice(0, 300),
        })
      }

      await saveReply({
        dialogId: dialog.id,
        userId: dialog.vk_user_id,
        reply: staticOffer,
        usedModel: 'static_prompt_3',
      })

      await sendMessage(dialog.vk_user_id, staticOffer)

      await markIncomingAfterFreeReplied(dialog.id, freeDoneAt)

      const botMessagesAdded = warmReply ? 2 : 1

      const { error: updErr } = await supabase
        .from('dialog')
        .update({
          status_id: 5,
          offer_sent_at: now.toISOString(),
          last_message_at: now.toISOString(),
          last_message_by: 'bot',
          message_count: (dialog.message_count ?? 0) + botMessagesAdded,
        })
        .eq('id', dialog.id)

      if (updErr) throw updErr

      sent.push({
        dialog_id: dialog.id,
        user_id: dialog.vk_user_id,
        warm_reply_sent: Boolean(warmReply),
        offer_sent: true,
      })
    }

    await trace(traceId, 'cron.offers_done', {
      sent,
      skipped,
    })

    return res.status(200).json({
      ok: true,
      sent,
      skipped,
    })
  } catch (err) {
    await trace(traceId, 'cron.offers_failed', {
      error: err.message,
    }, 'error')

    return res.status(500).json({
      ok: false,
      error: err.message,
    })
  }
}
