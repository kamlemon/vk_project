import { supabase } from '../lib/supabase.js'
import { sendMessage } from '../lib/vk.js'
import { trace } from '../lib/debug-trace.js'

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

async function saveReply({ dialogId, userId, reply }) {
  const { error } = await supabase.from('message').insert({
    dialog_id: dialogId,
    from_id: userId,
    peer_id: userId,
    direction: 'out',
    text: reply,
    msg_date: new Date().toISOString(),
    reply_to_id: null,
    raw_json: { source: 'cron-offers', model: 'static_prompt_3' },
  })

  if (error) throw error
}

async function hasIncomingAfter(dialogId, afterIso) {
  const { count, error } = await supabase
    .from('message')
    .select('id', { count: 'exact', head: true })
    .eq('dialog_id', dialogId)
    .eq('direction', 'in')
    .gt('dt_create', afterIso)

  if (error) throw error
  return (count ?? 0) > 0
}

export default async function handler(req, res) {
  const traceId = `cron-offers-${Date.now()}`

  try {
    const now = new Date()
    const staticText = await getStaticPrompt(3)

    if (!staticText) {
      await trace(traceId, 'cron.offers_prompt_missing', { prompt_id: 3 }, 'error')
      return res.status(500).json({ ok: false, error: 'prompt_3_not_found' })
    }

    const { data: dialogs, error } = await supabase
      .from('dialog')
      .select('id, vk_user_id, status_id, free_done_at, prompt_3_scheduled_at, offer_sent_at')
      .eq('status_id', 4)
      .is('offer_sent_at', null)
      .limit(100)

    if (error) throw error

    const sent = []
    const skipped = []

    for (const dialog of dialogs ?? []) {
      const freeDoneAt = dialog.free_done_at ? new Date(dialog.free_done_at) : null
      const scheduledAt = dialog.prompt_3_scheduled_at ? new Date(dialog.prompt_3_scheduled_at) : null

      let shouldSend = false
      let reason = null

      if (freeDoneAt && now >= new Date(freeDoneAt.getTime() + 12 * 60 * 60 * 1000)) {
        shouldSend = true
        reason = '12h_silence_fallback'
      } else if (scheduledAt && now >= scheduledAt) {
        const incomingAfterFree = freeDoneAt
          ? await hasIncomingAfter(dialog.id, dialog.free_done_at)
          : false

        if (incomingAfterFree) {
          shouldSend = true
          reason = 'user_message_after_free_and_timeout_passed'
        }
      }

      if (!shouldSend) {
        skipped.push({ dialog_id: dialog.id })
        continue
      }

      await saveReply({
        dialogId: dialog.id,
        userId: dialog.vk_user_id,
        reply: staticText,
      })

      await sendMessage(dialog.vk_user_id, staticText)

      const { error: updErr } = await supabase
        .from('dialog')
        .update({
          status_id: 5,
          offer_sent_at: now.toISOString(),
          last_message_at: now.toISOString(),
          last_message_by: 'bot',
        })
        .eq('id', dialog.id)

      if (updErr) throw updErr

      sent.push({ dialog_id: dialog.id, reason })
    }

    await trace(traceId, 'cron.offers_done', {
      sent,
      skipped_count: skipped.length,
    })

    return res.status(200).json({
      ok: true,
      sent,
      skipped_count: skipped.length,
    })
  } catch (err) {
    await trace(traceId, 'cron.offers_failed', { error: err.message }, 'error')
    return res.status(500).json({ ok: false, error: err.message })
  }
}
