import { supabase } from '../lib/supabase.js'
import { callGeminiMultimodal } from '../lib/gemini.js'
import { trace } from '../lib/debug-trace.js'

// ── 1. fetchVkUser ───────────────────────────────────────────────────────────

async function fetchVkUser(vkUserId) {
  const url = new URL('https://api.vk.com/method/users.get')
  url.searchParams.set('user_ids',     vkUserId)
  url.searchParams.set('fields',       'sex,city,photo_200,last_seen')
  url.searchParams.set('access_token', process.env.VK_GROUP_TOKEN)
  url.searchParams.set('v',            '5.199')

  const res  = await fetch(url.toString())
  const json = await res.json()

  if (json.error) {
    throw new Error(`VK API error ${json.error.error_code}: ${json.error.error_msg}`)
  }

  const u = json.response[0]
  return {
    vk_user_id: u.id,
    first_name: u.first_name,
    last_name:  u.last_name,
    sex:        u.sex ?? null,
    city:       u.city?.title ?? null,
    photo_200:  u.photo_200 ?? null,
    last_seen:  u.last_seen?.time
                  ? new Date(u.last_seen.time * 1000).toISOString()
                  : null,
    raw_json:   u,
  }
}

// ── 2. ensureUserExists ──────────────────────────────────────────────────────

async function ensureUserExists(vkUserId) {
  const { data: existing, error: selErr } = await supabase
    .from('user')
    .select('*')
    .eq('vk_user_id', vkUserId)
    .maybeSingle()

  if (selErr) throw selErr
  if (existing) return existing

  let userData
  try {
    userData = await fetchVkUser(vkUserId)
  } catch (vkError) {
    console.error('[ensureUserExists] fetchVkUser failed:', vkError.message)
    userData = {
      vk_user_id: vkUserId,
      first_name: 'Unknown',
      last_name:  '',
      raw_json:   { error: vkError.message },
    }
  }

  const { data: inserted, error: insErr } = await supabase
    .from('user')
    .insert(userData)
    .select()
    .single()

  if (insErr) throw insErr
  return inserted
}

// ── 3. ensureDialogExists ────────────────────────────────────────────────────

async function ensureDialogExists(vkUserId, peerId) {
  const { data: existing, error: selErr } = await supabase
    .from('dialog')
    .select('*')
    .eq('vk_user_id', vkUserId)
    .not('status_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (selErr) throw selErr
  if (existing) return existing

  const { data: inserted, error: insErr } = await supabase
    .from('dialog')
    .insert({ vk_user_id: vkUserId, peer_id: peerId, status_id: 1 })
    .select()
    .single()

  if (insErr) throw insErr
  return inserted
}

// ── 4. parseAttachments ──────────────────────────────────────────────────────

function parseAttachments(attachments) {
  const result = {
    has_attachments:  false,
    attachment_types: null,
    attachment_url:   [],
    // для транскрибации — храним внутренне, в БД не пишем отдельными полями
    _voice_ogg: null,
    _photo_url: null,
    _doc_url:   null,
    _doc_ext:   null,
  }

  if (!attachments || attachments.length === 0) return result

  result.has_attachments  = true
  const types             = [...new Set(attachments.map(a => a.type))]
  result.attachment_types = types.join(',')

  for (const att of attachments) {
    switch (att.type) {
      case 'photo': {
        const photo = att.photo
        const best  = (photo.sizes ?? []).reduce(
          (max, s) => (s.width > (max?.width ?? 0) ? s : max), null
        )
        if (best?.url) {
          result.attachment_url.push(best.url)
          result._photo_url = result._photo_url ?? best.url
        }
        break
      }
      case 'audio_message': {
        const vm = att.audio_message
        if (vm.link_ogg) {
          result.attachment_url.push(vm.link_ogg)
          result._voice_ogg = result._voice_ogg ?? vm.link_ogg
        }
        break
      }
      case 'doc': {
        const doc = att.doc
        if (doc.url) {
          result.attachment_url.push(doc.url)
          result._doc_url = result._doc_url ?? doc.url
          result._doc_ext = result._doc_ext ?? doc.ext
        }
        break
      }
      case 'audio': {
        const audio = att.audio
        if (audio.url) result.attachment_url.push(audio.url)
        break
      }
      default:
        break
    }
  }

  return result
}

// ── 5. transcribeAttachment ──────────────────────────────────────────────────

async function transcribeAttachment(parsed) {
  const empty = { transcriptions: null }

  if (!parsed.has_attachments) return empty

  const types = parsed.attachment_types?.split(',') ?? []

  try {
    let parts = null

    if (types.includes('audio_message') && parsed._voice_ogg) {
      const buf    = await (await fetch(parsed._voice_ogg)).arrayBuffer()
      const base64 = Buffer.from(buf).toString('base64')
      parts = [
        { inline_data: { mime_type: 'audio/ogg', data: base64 } },
        { text: 'Транскрибируй это голосовое сообщение. Верни только текст, без пояснений.' },
      ]
    } else if (types.includes('photo') && parsed._photo_url) {
      const buf    = await (await fetch(parsed._photo_url)).arrayBuffer()
      const base64 = Buffer.from(buf).toString('base64')
      parts = [
        { inline_data: { mime_type: 'image/jpeg', data: base64 } },
        { text: `Проверь, подходит ли это изображение для анализа ладони. Ответь строго на русском в формате:
verdict: palm | not_palm | unclear
quality: good | medium | poor
visible_palm: yes | no
visible_lines: yes | partly | no
summary: ...
details: ...

Правила:
- palm — если хорошо видна раскрытая ладонь со стороны линий.
- not_palm — если на фото не ладонь, не та сторона руки или другой объект.
- unclear — если ладонь есть, но качество, свет, ракурс или кадр мешают читать линии.
- Не выдумывай детали, которых не видно.
- Если verdict=unclear, напиши, что всё же удалось разобрать.
- Если verdict=palm, отдельно укажи, какие основные линии различимы: жизни, сердца, ума, судьбы.` },
      ]
    } else if (types.includes('doc') && parsed._doc_url) {
      const mimeMap = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/msword', txt: 'text/plain' }
      const mime    = mimeMap[parsed._doc_ext?.toLowerCase()] ?? 'application/octet-stream'
      const buf     = await (await fetch(parsed._doc_url)).arrayBuffer()
      const base64  = Buffer.from(buf).toString('base64')
      parts = [
        { inline_data: { mime_type: mime, data: base64 } },
        { text: 'Опиши содержимое этого документа. Отвечай на русском языке.' },
      ]
    } else {
      return empty
    }

    const result = await callGeminiMultimodal(parts)
    return {
      transcriptions: result.text ? [result.text] : null,
    }

  } catch (err) {
    console.error('[transcribeAttachment] failed:', err.message)
    return empty
  }
}

// ── 6. saveMessageFromVk ─────────────────────────────────────────────────────

async function saveMessageFromVk(body, traceId) {
  const msg = body?.object?.message
  if (!msg) throw new Error('No message object in body')

  await trace(traceId, 'vk.webhook_received', {
    event_id: body?.event_id ?? null,
    group_id: body?.group_id ?? null,
    type: body?.type ?? null,
    message: body?.object?.message ?? null,
  })

  const { id: vk_message_id, from_id, peer_id, date, text, attachments = [] } = msg
  const event_id = body.event_id ?? null
  const group_id = body.group_id ?? null

  // Дедупликация
  if (event_id) {
    const { error: dedupErr } = await supabase
      .from('processed_events')
      .insert({ event_id })
    if (dedupErr) {
      console.log('[vk] дубликат event_id, пропускаем:', event_id)
      await trace(traceId, 'vk.processed_event_duplicate', { event_id }, 'warn')
      return null
    }
    await trace(traceId, 'vk.processed_event_saved', { event_id })
  }

  // Пользователь и диалог
  await ensureUserExists(from_id)
  await trace(traceId, 'vk.user_ensured', { vk_user_id: from_id })
  const dialog   = await ensureDialogExists(from_id, peer_id)
  const dialogId = dialog.id

  await trace(traceId, 'vk.dialog_ensured', {
    vk_user_id: from_id,
    peer_id,
    dialog_id: dialogId,
    status_id: dialog.status_id,
  })

  // Вложения
  const parsed         = parseAttachments(attachments)
  await trace(traceId, 'vk.attachments_parsed', parsed)
  const { transcriptions } = await transcribeAttachment(parsed)

  await trace(traceId, 'vk.attachment_transcribed', {
    has_transcriptions: Boolean(transcriptions),
    transcriptions,
  })

  // INSERT message — только поля новой схемы
  const { data: savedMessage, error: msgErr } = await supabase
    .from('message')
    .insert({
      dialog_id:        dialogId,
      vk_message_id,
      event_id,
      group_id,
      from_id,
      peer_id,
      msg_date:         date ? new Date(date * 1000).toISOString() : null,
      direction:        'in',
      text,
      has_attachments:  parsed.has_attachments,
      attachment_types: parsed.attachment_types,
      attachment_url:   parsed.attachment_url.length > 0 ? parsed.attachment_url : null,
      attachment_trans: transcriptions,
      raw_json:         body,
    })
    .select()
    .single()

  if (msgErr) throw msgErr

  await trace(traceId, 'vk.message_saved', {
    message_id: savedMessage?.id ?? null,
    dialog_id: savedMessage?.dialog_id ?? null,
    vk_message_id: savedMessage?.vk_message_id ?? null,
    text: savedMessage?.text ?? null,
    has_attachments: savedMessage?.has_attachments ?? null,
    attachment_types: savedMessage?.attachment_types ?? null,
    attachment_trans: savedMessage?.attachment_trans ?? null,
  })

  // Обновляем счётчик и last_message_by в dialog
  await supabase
    .from('dialog')
    .update({
      message_count:   (dialog.message_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
      last_message_by: 'user',
    })
    .eq('id', dialogId)

  return savedMessage
}

// ── 7. Handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body

  if (body.secret !== process.env.VK_CALLBACK_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' })
  }

  if (body.type === 'confirmation') {
    return res.status(200).send(process.env.VK_CONFIRMATION_CODE)
  }

  if (body.type === 'message_new') {
    const msg        = body?.object?.message
    const vk_user_id = msg?.from_id
    const traceId    = `vk-${body?.event_id ?? Date.now()}`

    let savedMessage = null

    try {
      savedMessage = await saveMessageFromVk(body, traceId)
    } catch (err) {
      console.error('[handler] saveMessageFromVk failed:', err.message)
    }

    if (!msg || !savedMessage) {
      return res.status(200).send('ok')
    }

    try {
      await trace(traceId, 'vk.reply_queued', {
        dialog_id: savedMessage?.dialog_id ?? null,
        incoming_message_id: savedMessage?.id ?? null,
        vk_user_id,
        queue_window_seconds: Number(process.env.BATCH_WINDOW_SECONDS ?? 75),
      })
    } catch (e) {
      console.error('[handler] queue trace error:', e.message)
    }
  }

  return res.status(200).send('ok')
}
