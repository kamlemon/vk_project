import { createClient } from '@supabase/supabase-js'
import { HttpsProxyAgent } from 'https-proxy-agent'

// ── Инициализация ────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

const proxyAgent = new HttpsProxyAgent(process.env.PROXY_URL)

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`

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
      vk_user_id:   vkUserId,
      first_name:   'Unknown',
      last_name:    '',
      funnel_stage: 'new',
      raw_json:     { error: vkError.message },
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
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  if (selErr) throw selErr
  if (existing) return existing

  const { data: inserted, error: insErr } = await supabase
    .from('dialog')
    .insert({ vk_user_id: vkUserId, peer_id: peerId, status: 'active' })
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
    // photo
    photo_owner_id:   null,
    photo_id:         null,
    photo_access_key: null,
    photo_url:        null,
    photo_width:      null,
    photo_height:     null,
    // audio
    audio_owner_id:   null,
    audio_id:         null,
    audio_access_key: null,
    audio_duration:   null,
    audio_link_mp3:   null,
    audio_link_ogg:   null,
    // doc
    doc_owner_id:     null,
    doc_id:           null,
    doc_access_key:   null,
    doc_url:          null,
    doc_title:        null,
    doc_ext:          null,
    // voice (audio_message)
    voice_owner_id:   null,
    voice_id:         null,
    voice_access_key: null,
    voice_duration:   null,
    voice_link_ogg:   null,
  }

  if (!attachments || attachments.length === 0) return result

  result.has_attachments  = true
  const types             = [...new Set(attachments.map(a => a.type))]
  result.attachment_types = types.join(',')

  for (const att of attachments) {
    switch (att.type) {

      case 'photo': {
        if (result.photo_id !== null) break
        const photo = att.photo
        const best  = (photo.sizes ?? []).reduce(
          (max, s) => (s.width > (max?.width ?? 0) ? s : max),
          null
        )
        result.photo_owner_id   = photo.owner_id
        result.photo_id         = photo.id
        result.photo_access_key = photo.access_key ?? null
        result.photo_url        = best?.url ?? null
        result.photo_width      = best?.width ?? null
        result.photo_height     = best?.height ?? null
        break
      }

      case 'audio': {
        if (result.audio_id !== null) break
        const audio             = att.audio
        result.audio_owner_id   = audio.owner_id
        result.audio_id         = audio.id
        result.audio_access_key = audio.access_key ?? null
        result.audio_duration   = audio.duration ?? null
        result.audio_link_mp3   = audio.url ?? null
        result.audio_link_ogg   = audio.url_ogg ?? null
        break
      }

      case 'doc': {
        if (result.doc_id !== null) break
        const doc             = att.doc
        result.doc_owner_id   = doc.owner_id
        result.doc_id         = doc.id
        result.doc_access_key = doc.access_key ?? null
        result.doc_url        = doc.url ?? null
        result.doc_title      = doc.title ?? null
        result.doc_ext        = doc.ext ?? null
        break
      }

      case 'audio_message': {
        if (result.voice_id !== null) break
        const vm                = att.audio_message
        result.voice_owner_id   = vm.owner_id
        result.voice_id         = vm.id
        result.voice_access_key = vm.access_key ?? null
        result.voice_duration   = vm.duration ?? null
        result.voice_link_ogg   = vm.link_ogg ?? null
        break
      }

      default:
        break
    }
  }

  return result
}

// ── 5. transcribeAttachment ──────────────────────────────────────────────────

async function transcribeAttachment(attachmentFields, attachmentTypes) {
  const empty = { transcription: null, gemini_response_id: null, usageMetadata: null }

  if (!attachmentTypes) return empty

  const types = attachmentTypes.split(',')

  try {
    let parts = null

    if (types.includes('audio_message') && attachmentFields.voice_link_ogg) {
      const audioRes    = await fetch(attachmentFields.voice_link_ogg)
      const audioBuffer = await audioRes.arrayBuffer()
      const base64      = Buffer.from(audioBuffer).toString('base64')
      parts = [
        { inline_data: { mime_type: 'audio/ogg', data: base64 } },
        { text: 'Транскрибируй это голосовое сообщение. Верни только текст, без пояснений.' },
      ]
    } else if (types.includes('photo') && attachmentFields.photo_url) {
      const imgRes    = await fetch(attachmentFields.photo_url)
      const imgBuffer = await imgRes.arrayBuffer()
      const base64    = Buffer.from(imgBuffer).toString('base64')
      parts = [
        { inline_data: { mime_type: 'image/jpeg', data: base64 } },
        { text: 'Опиши детально что изображено на фото. Отвечай на русском языке.' },
      ]
    } else if (types.includes('doc') && attachmentFields.doc_url) {
      const mimeMap = {
        pdf:  'application/pdf',
        doc:  'application/msword',
        docx: 'application/msword',
        txt:  'text/plain',
      }
      const mime   = mimeMap[attachmentFields.doc_ext?.toLowerCase()] ?? 'application/octet-stream'
      const docRes = await fetch(attachmentFields.doc_url)
      const docBuf = await docRes.arrayBuffer()
      const base64 = Buffer.from(docBuf).toString('base64')
      parts = [
        { inline_data: { mime_type: mime, data: base64 } },
        { text: 'Опиши содержимое этого документа. Отвечай на русском языке.' },
      ]
    } else {
      // audio-музыка или неизвестный тип — транскрибация не нужна
      return empty
    }

    const geminiRes = await fetch(GEMINI_URL, {
      method:  'POST',
      agent:   proxyAgent,
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contents: [{ parts }] }),
    })

    const geminiJson = await geminiRes.json()

    if (!geminiRes.ok) {
      console.error('[transcribeAttachment] Gemini error:', JSON.stringify(geminiJson))
      return empty
    }

    const transcription      = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text ?? null
    const gemini_response_id = geminiJson.responseId ?? null
    const usageMetadata      = geminiJson.usageMetadata ?? null

    return { transcription, gemini_response_id, usageMetadata }

  } catch (err) {
    console.error('[transcribeAttachment] failed:', err.message)
    return empty
  }
}

// ── 6. saveTokenUsage ────────────────────────────────────────────────────────

async function saveTokenUsage(usageMetadata, responseId, dialogId, vkUserId) {
  try {
    const { error } = await supabase
      .from('token_usage')
      .insert({
        prompt_tokens:     usageMetadata.promptTokenCount,
        candidates_tokens: usageMetadata.candidatesTokenCount,
        thoughts_tokens:   usageMetadata.thoughtsTokenCount ?? 0,
        total_tokens:      usageMetadata.totalTokenCount,
        model_version:     'gemini-2.5-flash',
        response_id:       responseId,
        dialog_id:         dialogId,
        vk_user_id:        vkUserId,
      })

    if (error) console.error('[saveTokenUsage] insert error:', error.message)
  } catch (err) {
    console.error('[saveTokenUsage] failed:', err.message)
  }
}

// ── 7. saveMessageFromVk ─────────────────────────────────────────────────────

async function saveMessageFromVk(body) {
  // 1. Достаём message
  const msg = body?.object?.message
  if (!msg) throw new Error('No message object in body')

  // 2. Поля
  const {
    id:                      vk_message_id,
    conversation_message_id,
    from_id,
    peer_id,
    date,
    text,
    attachments = [],
  } = msg

  const event_id   = body.event_id ?? null
  const group_id   = body.group_id ?? null
  const vk_version = body.v        ?? null

  // 3. Пользователь
  await ensureUserExists(from_id)

  // 4. Диалог
  const dialog   = await ensureDialogExists(from_id, peer_id)
  const dialogId = dialog.id

  // 5. Вложения
  const attachmentFields = parseAttachments(attachments)

  // 6. Транскрибация
  const { transcription, gemini_response_id, usageMetadata } =
    await transcribeAttachment(attachmentFields, attachmentFields.attachment_types)

  // 7. Токены
  if (gemini_response_id && usageMetadata) {
    await saveTokenUsage(usageMetadata, gemini_response_id, dialogId, from_id)
  }

  // 8. INSERT message
  const { data: savedMessage, error: msgErr } = await supabase
    .from('message')
    .insert({
      vk_message_id,
      conversation_message_id,
      event_id,
      group_id,
      vk_version,
      from_id,
      peer_id,
      msg_date:          date,
      text,
      has_attachments:   attachmentFields.has_attachments,
      attachment_types:  attachmentFields.attachment_types,
      // photo
      photo_owner_id:    attachmentFields.photo_owner_id,
      photo_id:          attachmentFields.photo_id,
      photo_access_key:  attachmentFields.photo_access_key,
      photo_url:         attachmentFields.photo_url,
      photo_width:       attachmentFields.photo_width,
      photo_height:      attachmentFields.photo_height,
      // audio
      audio_owner_id:    attachmentFields.audio_owner_id,
      audio_id:          attachmentFields.audio_id,
      audio_access_key:  attachmentFields.audio_access_key,
      audio_duration:    attachmentFields.audio_duration,
      audio_link_mp3:    attachmentFields.audio_link_mp3,
      audio_link_ogg:    attachmentFields.audio_link_ogg,
      // doc
            doc_owner_id:      attachmentFields.doc_owner_id,
      doc_id:            attachmentFields.doc_id,
      doc_access_key:    attachmentFields.doc_access_key,
      doc_url:           attachmentFields.doc_url,
      doc_title:         attachmentFields.doc_title,
      doc_ext:           attachmentFields.doc_ext,
      // voice
      voice_owner_id:    attachmentFields.voice_owner_id,
      voice_id:          attachmentFields.voice_id,
      voice_access_key:  attachmentFields.voice_access_key,
      voice_duration:    attachmentFields.voice_duration,
      voice_link_ogg:    attachmentFields.voice_link_ogg,
      // мета
      direction:         'in',
      dialog_id:         dialogId,
      is_transcribed:    transcription !== null,
      transcription,
      gemini_response_id,
      raw_json:          body,
    })
    .select()
    .single()

  if (msgErr) throw msgErr

  // 9. UPDATE dialog — счётчик и время последнего сообщения
  const { error: dlgErr } = await supabase
    .rpc('increment_message_count', { dialog_id: dialogId })

  if (dlgErr) console.error('[saveMessageFromVk] dialog update error:', dlgErr.message)

  // 10. Возвращаем сохранённое сообщение
  return savedMessage
}

// ── 8. Handler (export default) ─────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body

  // Проверка секрета
  if (body.secret !== process.env.VK_CALLBACK_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' })
  }

  // Подтверждение сервера
  if (body.type === 'confirmation') {
    return res.status(200).send(process.env.VK_CONFIRMATION_CODE)
  }

  // Входящее сообщение
  if (body.type === 'message_new') {
    const msg = body?.object?.message
    const vk_user_id = msg?.from_id

    // Запоминаем флаг ДО того как ensureUserExists создаст запись
    const { data: existingUser } = await supabase
      .from('user')
      .select('vk_user_id')
      .eq('vk_user_id', vk_user_id)
      .maybeSingle()

    const isNewUser = !existingUser

    try {
      await saveMessageFromVk(body)
    } catch (err) {
      console.error('[handler] saveMessageFromVk failed:', err.message)
    }

    if (msg) {
      const text = msg.text ?? ''
      const baseUrl = process.env.VERCEL_PROJECT_URL
        ? `https://${process.env.VERCEL_PROJECT_URL}`
        : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000'

      const endpoint = isNewUser ? 'new-user' : 'old-user'

      // Импортируем и вызываем напрямую
      if (endpoint === 'new-user') {
        try {
          const m = await import('../api/new-user.js')
          const { data: userRow } = await supabase.from('user').select('first_name, sex').eq('vk_user_id', vk_user_id).maybeSingle()
          const fakeReq = { method: 'POST', body: { user_id: vk_user_id, text, first_name: userRow?.first_name || null, sex: userRow?.sex || null } }
          const fakeRes = { status: () => ({ end: () => {}, send: () => {} }), send: () => {} }
          await m.default(fakeReq, fakeRes)
        } catch(e) {
          console.error('[handler] new-user error:', e.message)
        }
      } else {
        try {
          const m = await import('../api/old-user.js')
          const { data: userRow } = await supabase.from('user').select('first_name, sex').eq('vk_user_id', vk_user_id).maybeSingle()
          const fakeReq = { method: 'POST', body: { user_id: vk_user_id, text, first_name: userRow?.first_name || null, sex: userRow?.sex || null } }
          const fakeRes = { status: () => ({ end: () => {}, send: () => {} }), send: () => {} }
          await m.default(fakeReq, fakeRes)
        } catch(e) {
          console.error('[handler] old-user error:', e.message)
        }
      }
    }
  }

  return res.status(200).send('ok')
}
      
