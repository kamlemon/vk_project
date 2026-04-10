import { supabase } from '../lib/supabase.js'
import { trace } from '../lib/debug-trace.js'
import { sendMessage } from '../lib/vk.js'

async function getPrompt3() {
  const { data, error } = await supabase
    .from('prompt')
    .select('prompt_content')
    .eq('prompt_id', 3)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  if (error) throw error
  if (!data?.prompt_content) throw new Error('Active prompt_id=3 not found')

  return data.prompt_content
}

async function getDueDialogs(nowIso) {
  const { data, error } = await supabase
    .from('dialog')
    .select('id, vk_user_id, status_id, message_count, prompt_3_scheduled_at, offer_sent_at')
    .in('status_id', [3, 4])
    .is('offer_sent_at', null)
    .not('prompt_3_scheduled_at', 'is', null)
    .lte('prompt_3_scheduled_at', nowIso)
    .order('prompt_3_scheduled_at', { ascending: true })
    .limit(100)

  if (error) throw error
  return data ?? []
}

async function saveOfferMessage(dialog, text, nowIso) {
  const { error } = await supabase
    .from('message')
    .insert({
      dialog_id: dialog.id,
      from_id: dialog.vk_user_id,
      peer_id: dialog.vk_user_id,
      direction: 'out',
      text,
      msg_date: nowIso,
      reply_to_id: null,
      raw_json: {
        source: 'cron-offers',
        prompt_id: 3,
      },
    })

  if (error) throw error
}

async function updateDialogAfterOffer(dialog, nowIso) {
  const { error } = await supabase
    .from('dialog')
    .update({
      status_id: 5,
      offer_sent_at: nowIso,
      last_message_at: nowIso,
      last_message_by: 'bot',
      message_count: (dialog.message_count ?? 0) + 1,
    })
    .eq('id', dialog.id)

  if (error) throw error
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const traceId = `cron-offers-${Date.now()}`
  const nowIso = new Date().toISOString()

  try {
    const prompt3 = await getPrompt3()
    const dialogs = await getDueDialogs(nowIso)
    const sent = []

    for (const dialog of dialogs) {
      await saveOfferMessage(dialog, prompt3, nowIso)
      await sendMessage(dialog.vk_user_id, prompt3)
      await updateDialogAfterOffer(dialog, nowIso)

      sent.push({
        dialog_id: dialog.id,
        vk_user_id: dialog.vk_user_id,
        previous_status_id: dialog.status_id,
        new_status_id: 5,
      })
    }

    return res.status(200).json({ ok: true, sent })
  } catch (err) {
    await trace(traceId, 'cron.offers_failed', { error: err.message }, 'error')
    return res.status(500).json({ ok: false, error: err.message })
  }
}
