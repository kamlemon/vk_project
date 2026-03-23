import { createClient } from "@supabase/supabase-js";

const CONFIRMATION_CODE = "4d476332";
const VK_SECRET = "kP7sY9q3Wm2Zf8R1tL4vB6nC0xD5gH7jK9pM2rT8";

// Инициализируем Supabase-клиент один раз
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("Supabase env vars are missing");
}

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).send("Bad Request");
    }
  }

  const { type, secret, object, group_id, event_id, v } = body || {};

  // проверка секретного ключа
  if (secret && secret !== VK_SECRET) {
    return res.status(403).send("forbidden");
  }

  // подтверждение сервера
  if (type === "confirmation") {
    res.status(200).setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(CONFIRMATION_CODE);
  }

  console.log("VK EVENT:", JSON.stringify(body, null, 2));

  if (type === "message_new") {
    const msg = object?.message;
    const fromId = msg?.from_id;
    const text = msg?.text ?? "";
    const peerId = msg?.peer_id;
    const msgDate = msg?.date;
    const vkMessageId = msg?.id;
    const convMsgId = msg?.conversation_message_id;
    const attachments = msg?.attachments ?? [];

    // типы вложений
    const attachmentTypes = attachments.map((a) => a.type).join(",");

    // фото (ищем type === 'photo' и внутри sizes type === 'base')
    let photoOwnerId = null;
    let photoId = null;
    let photoAccessKey = null;
    let photoUrl = null;
    let photoWidth = null;
    let photoHeight = null;

    const photoAttachment = attachments.find((a) => a.type === "photo");
    if (photoAttachment && photoAttachment.photo) {
      const p = photoAttachment.photo;
      photoOwnerId = p.owner_id ?? null;
      photoId = p.id ?? null;
      photoAccessKey = p.access_key ?? null;

      const baseSize =
        (p.sizes || []).find((s) => s.type === "base") || p.orig_photo;

      if (baseSize) {
        photoUrl = baseSize.url ?? null;
        photoWidth = baseSize.width ?? null;
        photoHeight = baseSize.height ?? null;
      }
    }

    // аудио-сообщение
    let audioOwnerId = null;
    let audioId = null;
    let audioAccessKey = null;
    let audioDuration = null;
    let audioLinkMp3 = null;
    let audioLinkOgg = null;

    const audioAttachment = attachments.find(
      (a) => a.type === "audio_message"
    );
    if (audioAttachment && audioAttachment.audio_message) {
      const a = audioAttachment.audio_message;
      audioOwnerId = a.owner_id ?? null;
      audioId = a.id ?? null;
      audioAccessKey = a.access_key ?? null;
      audioDuration = a.duration ?? null;
      audioLinkMp3 = a.link_mp3 ?? null;
      audioLinkOgg = a.link_ogg ?? null;
    }

    const hasAttachments = attachments.length > 0;

    // формируем запись для таблицы message
    const row = {
      vk_message_id: vkMessageId,
      conversation_message_id: convMsgId,
      event_id,
      group_id,
      vk_version: v,

      from_id: fromId,
      peer_id: peerId,
      msg_date: msgDate,

      text,
      has_attachments: hasAttachments,
      attachment_types: attachmentTypes || null,

      photo_owner_id: photoOwnerId,
      photo_id: photoId,
      photo_access_key: photoAccessKey,
      photo_url: photoUrl,
      photo_width: photoWidth,
      photo_height: photoHeight,

      audio_owner_id: audioOwnerId,
      audio_id: audioId,
      audio_access_key: audioAccessKey,
      audio_duration: audioDuration,
      audio_link_mp3: audioLinkMp3,
      audio_link_ogg: audioLinkOgg,

      raw_json: body,
    };

    console.log("NORMALIZED MESSAGE ROW:", row);

    if (supabase) {
      const { data, error } = await supabase
        .from("message")
        .insert([row]); // [row] — вставка одной записи

      if (error) {
        console.error("Supabase insert error:", error);
      } else {
        console.log("Supabase insert ok, id(s):", data?.map((d) => d.id));
      }
    } else {
      console.warn("Supabase client not initialized, row not saved");
    }
  }

  res.status(200).setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send("ok");
}
