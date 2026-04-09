import { supabase } from '../lib/supabase.js'
import { trace } from '../lib/debug-trace.js'
import routerHandler from './router.js'

const BATCH_WINDOW_SECONDS = Number(process.env.BATCH_WINDOW_SECONDS ?? 75)
const MAX_PENDING_MESSAGES = Number(process.env.BATCH_MAX_MESSAGES ?? 200)

function groupByDialog(rows) {
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.dialog_id)) map.set(row.dialog_id, [])
    map.get(row.dialog_id).push(row)
  }
  return map
}

function pickRepresentativeMessage(rows) {
  const withAttachments = rows.filter(row =>
    row.has_attachments ||
    (Array.isArray(row.attachment_trans) && row.attachment_trans.length > 0) ||
    (!!row.attachment_trans && !Array.isArray(row.attachment_trans)) ||
    !!row.attachment_types
  )

  return withAttachments.length
    ? withAttachments[withAttachments.length - 1]
    : rows[rows.length - 1]
}

function buildCombinedText(rows) {
  const intro = `Техническая заметка:
- это продолжение уже начатого диалога
- не здоровайся повторно
- не начинай разговор заново
- отвечай сразу по сути последних сообщений пользователя`

  const body = rows.map((row, idx) => {
    const chunks = []
    chunks.push(`Сообщение ${idx + 1}: ${row.text?.trim() || '[без текста]'}`)

    if (row.has_attachments && row.attachment_types) {
      chunks.push(`Тип вложения: ${row.attachment_types}`)
    }

    if (row.attachment_trans) {
      const trans = Array.isArray(row.attachment_trans)
        ? row.attachment_trans.join('\n')
        : String(row.attachment_trans)

      if (trans.trim()) {
        chunks.push(`Описание вложения этого сообщения:\n${trans}`)
      }
    }

    return chunks.join('\n')
  }).join('\n\n')

  return `${intro}\n\n${body}`
}

async function getPendingInboundMessages() {
  const { data, error } = await supabase
    .from('message')
    .select('id, dialog_id, from_id, peer_id, msg_date, text, has_attachments, attachment_types, attachment_trans, is_replied')
    .eq('direction', 'in')
    .eq('is_replied', false)
    .order('msg_date', { ascending: true })
    .limit(MAX_PENDING_MESSAGES)

  if (error) throw error
  return data ?? []
}

async function getUser(vkUserId) {
  const { data, error } = await supabase
    .from('user')
    .select('first_name, sex')
    .eq('vk_user_id', vkUserId)
    .maybeSingle()

  if (error) throw error
  return data ?? { first_name: null, sex: null }
}

async function markMessagesReplied(messageIds) {
  if (!messageIds.length) return

  const { error } = await supabase
    .from('message')
    .update({ is_replied: true })
    .in('id', messageIds)

  if (error) throw error
}

function makeFakeRes() {
  return {
    status() { return this },
    json() { return this },
    send() { return this },
    end() { return this },
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const traceId = `cron-pending-replies-${Date.now()}`
  const now = Date.now()
  const cutoff = now - BATCH_WINDOW_SECONDS * 1000

  try {
    const rows = await getPendingInboundMessages()
    const grouped = groupByDialog(rows)

    const processed = []
    const skipped = []

    for (const [dialogId, items] of grouped.entries()) {
      const latest = items[items.length - 1]
      const latestTs = new Date(latest.msg_date).getTime()

      if (Number.isNaN(latestTs) || latestTs > cutoff) {
        skipped.push({
          dialog_id: dialogId,
          reason: 'window_not_elapsed',
          latest_message_id: latest.id,
          latest_msg_date: latest.msg_date,
          batch_size: items.length,
        })
        continue
      }

      const representative = pickRepresentativeMessage(items)
      const combinedText = buildCombinedText(items)
      const user = await getUser(latest.from_id)

      const fakeReq = {
        method: 'POST',
        body: {
          user_id: latest.from_id,
          text: combinedText,
          first_name: user?.first_name ?? null,
          sex: user?.sex ?? null,
          incoming_message_id: representative.id,
          trace_id: `${traceId}-dialog-${dialogId}`,
          event_id: `batched-${dialogId}-${latest.id}`,
        },
      }

      await trace(traceId, 'cron.pending_replies_dispatch', {
        dialog_id: dialogId,
        latest_message_id: latest.id,
        representative_message_id: representative.id,
        batch_size: items.length,
        message_ids: items.map(x => x.id),
      })

      await routerHandler(fakeReq, makeFakeRes())

      const otherIds = items
        .filter(x => x.id !== representative.id)
        .map(x => x.id)

      await markMessagesReplied(otherIds)

      processed.push({
        dialog_id: dialogId,
        latest_message_id: latest.id,
        representative_message_id: representative.id,
        batch_size: items.length,
        other_marked_replied: otherIds,
      })
    }

    await trace(traceId, 'cron.pending_replies_done', {
      processed_count: processed.length,
      skipped_count: skipped.length,
      processed,
      skipped,
    })

    return res.status(200).json({
      ok: true,
      processed,
      skipped,
    })
  } catch (err) {
    await trace(traceId, 'cron.pending_replies_failed', {
      error: err.message,
    }, 'error')

    return res.status(500).json({ ok: false, error: err.message })
  }
}
