import { supabase } from '../lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { data: dialogs, error: dialogsError } = await supabase
    .from('dialog')
    .select('id, vk_user_id, status_id, product_id, product_step, next_action_at, cycle_started_at, cycle_completed_at, last_message_at, last_message_by, message_count')
    .order('last_message_at', { ascending: false })
    .limit(20)

  if (dialogsError) {
    return res.status(500).json({ ok: false, stage: 'dialogs', error: dialogsError.message })
  }

  const { data: messages, error: messagesError } = await supabase
    .from('message')
    .select('dialog_id, direction, text, msg_date')
    .order('msg_date', { ascending: false })
    .limit(20)

  if (messagesError) {
    return res.status(500).json({ ok: false, stage: 'messages', error: messagesError.message })
  }

  return res.status(200).json({
    ok: true,
    dialogs,
    messages,
  })
}
