import { supabase } from '../lib/supabase.js'
import { trace } from '../lib/debug-trace.js'
import { verifyGetPlatinumChecksum } from '../lib/getplatinum.js'
import { sendMessage } from '../lib/vk.js'

const PAID_PRODUCT_ID = 2


function plusMinutesIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function cardsCountByProductId(productId) {
  if (Number(productId) === 2) return 3
  if (Number(productId) === 3) return 5
  return null
}

function shuffleArray(items) {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function randomReversed() {
  return Math.random() < 0.3
}

async function ensureTarotReading({ dialogId, vkUserId, productId, topic = null, questionText = null }) {
  const cardsCount = cardsCountByProductId(productId)
  if (!cardsCount) return null

  const { data: dialogRow } = await supabase
    .from('dialog')
    .select('current_reading_id')
    .eq('id', dialogId)
    .maybeSingle()

  if (dialogRow?.current_reading_id) {
    const { data: existing } = await supabase
      .from('tarot_reading')
      .select('*')
      .eq('id', dialogRow.current_reading_id)
      .maybeSingle()

    if (existing) return existing
  }

  const { data: cards, error: cardsError } = await supabase
    .from('tarot_card')
    .select('card_code')
    .eq('deck_code', 'RWS')
    .eq('is_available', true)

  if (cardsError) throw cardsError
  if (!cards || cards.length < cardsCount) {
    throw new Error(`Not enough tarot cards for reading: need ${cardsCount}, got ${cards?.length ?? 0}`)
  }

  const picked = shuffleArray(cards).slice(0, cardsCount)
  const reversedFlags = picked.map(() => randomReversed())

  const payload = {
    dialog_id: dialogId,
    vk_user_id: vkUserId,
    product_id: Number(productId),
    topic: topic ?? null,
    question_text: questionText ?? topic ?? null,
    cards_count: cardsCount,
    card_1_code: picked[0]?.card_code ?? null,
    card_1_reversed: reversedFlags[0] ?? false,
    card_2_code: picked[1]?.card_code ?? null,
    card_2_reversed: reversedFlags[1] ?? false,
    card_3_code: picked[2]?.card_code ?? null,
    card_3_reversed: reversedFlags[2] ?? false,
    card_4_code: picked[3]?.card_code ?? null,
    card_4_reversed: reversedFlags[3] ?? false,
    card_5_code: picked[4]?.card_code ?? null,
    card_5_reversed: reversedFlags[4] ?? false,
    cards_signature: picked.map((card, idx) => `${card.card_code}:${reversedFlags[idx] ? 'r' : 'u'}`).join('|'),
    delivery_step: 0,
  }

  const { data: inserted, error: insertError } = await supabase
    .from('tarot_reading')
    .insert(payload)
    .select('*')
    .single()

  if (insertError) throw insertError
  return inserted
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = req.body ?? {}
  const traceId = `getplatinum-${body?.dealId ?? 'unknown'}-${Date.now()}`
  const now = new Date().toISOString()

  await trace(traceId, 'getplatinum.callback_received', body)

  const checksumOk = verifyGetPlatinumChecksum(body)
  await trace(traceId, 'getplatinum.callback_checksum_checked', {
    deal_id: body?.dealId ?? null,
    checksum_ok: checksumOk,
    notification_type: body?.notificationType ?? null,
    is_success: body?.isSuccess ?? null,
  })

  if (!checksumOk) {
    await trace(traceId, 'getplatinum.callback_invalid_checksum', {
      deal_id: body?.dealId ?? null,
    }, 'error')
    return res.status(200).json({ ok: false, reason: 'invalid_checksum' })
  }

  const dealId = body?.dealId ?? null
  if (!dealId) {
    await trace(traceId, 'getplatinum.callback_missing_deal_id', {}, 'error')
    return res.status(200).json({ ok: false, reason: 'missing_deal_id' })
  }

  const { data: payment, error: paymentSelErr } = await supabase
    .from('payment')
    .select('*')
    .eq('deal_id', dealId)
    .maybeSingle()

  if (paymentSelErr) {
    await trace(traceId, 'getplatinum.payment_select_failed', {
      deal_id: dealId,
      error: paymentSelErr.message,
    }, 'error')
    return res.status(200).json({ ok: false, reason: 'payment_select_failed' })
  }

  if (!payment) {
    await trace(traceId, 'getplatinum.payment_not_found', {
      deal_id: dealId,
    }, 'warn')
    return res.status(200).json({ ok: false, reason: 'payment_not_found' })
  }

  const notificationType = Number(body?.notificationType ?? 0)
  const isSuccess = Boolean(body?.isSuccess)

  const { error: paymentUpdErr } = await supabase
    .from('payment')
    .update({
      status: isSuccess ? 'paid' : 'failed',
      is_success: isSuccess,
      md_order: body?.paymentData?.mdOrder ?? null,
      payment_system: body?.paymentData?.paymentSystem ?? null,
      raw_callback: body,
      updated_at: now,
    })
    .eq('deal_id', dealId)

  if (paymentUpdErr) {
    await trace(traceId, 'getplatinum.payment_update_failed', {
      deal_id: dealId,
      error: paymentUpdErr.message,
    }, 'error')
    return res.status(200).json({ ok: false, reason: 'payment_update_failed' })
  }

  await trace(traceId, 'getplatinum.payment_updated', {
    deal_id: dealId,
    status: isSuccess ? 'paid' : 'failed',
    notification_type: notificationType,
  })

    let tarotReadingId = null
    let tarotNextActionAt = null

    if ([2, 3].includes(Number(productId))) {
      const { data: dialogMeta, error: dialogMetaError } = await supabase
        .from('dialog')
        .select('selected_topic, current_reading_id')
        .eq('id', payment.dialog_id)
        .maybeSingle()

      if (dialogMetaError) throw dialogMetaError

      const reading = await ensureTarotReading({
        dialogId: payment.dialog_id,
        vkUserId: payment.vk_user_id,
        productId,
        topic: dialogMeta?.selected_topic ?? null,
        questionText: dialogMeta?.selected_topic ?? null,
      })

      tarotReadingId = reading?.id ?? null
      tarotNextActionAt = plusMinutesIso(1)
    }


  if (notificationType === 1 && isSuccess) {
    const productId = Number(body?.customParams?.productId ?? PAID_PRODUCT_ID) || PAID_PRODUCT_ID
    const offerName = body?.customParams?.offerName ?? null

    const { data: dialogBefore, error: dialogSelErr } = await supabase
      .from('dialog')
      .select('id, message_count')
      .eq('id', payment.dialog_id)
      .maybeSingle()

    if (dialogSelErr) {
      await trace(traceId, 'getplatinum.dialog_select_failed', {
        dialog_id: payment.dialog_id,
        error: dialogSelErr.message,
      }, 'error')
      return res.status(200).json({ ok: false, reason: 'dialog_select_failed' })
    }

    const { error: dialogUpdErr } = await supabase
      .from('dialog')
      .update({
        status_id: 6,
        product_id: productId,
        product_step: 0,
        cycle_started_at: null,
        cycle_completed_at: null,
        next_action_at: null,
        last_message_at: now,
        last_message_by: 'bot',
        message_count: (dialogBefore?.message_count ?? 0) + 1,
      })
      .eq('id', payment.dialog_id)

    if (dialogUpdErr) {
      await trace(traceId, 'getplatinum.dialog_update_failed', {
        dialog_id: payment.dialog_id,
        error: dialogUpdErr.message,
      }, 'error')
      return res.status(200).json({ ok: false, reason: 'dialog_update_failed' })
    }

    await trace(traceId, 'getplatinum.dialog_moved_to_status_6', {
      dialog_id: payment.dialog_id,
      vk_user_id: payment.vk_user_id,
      product_id: productId,
      product_step: 0,
      next_action_at: [2, 3].includes(Number(productId)) ? tarotNextActionAt : null,
      current_reading_id: [2, 3].includes(Number(productId)) ? tarotReadingId : null,
      offer_name: offerName,
    })

    const reply = [2, 3].includes(Number(productId))
      ? (offerName
          ? `Оплату за «${offerName}» вижу, спасибо. Я уже перехожу к раскладу и дальше пришлю карты по одной с разбором.`
          : 'Оплату вижу, спасибо. Я уже перехожу к раскладу и дальше пришлю карты по одной с разбором.')
      : (offerName
          ? `Вижу оплату за практику «${offerName}», спасибо большое.`
          : 'Вижу оплату, спасибо большое.')

    const { error: msgErr } = await supabase
      .from('message')
      .insert({
        dialog_id: payment.dialog_id,
        from_id: payment.vk_user_id,
        peer_id: payment.vk_user_id,
        direction: 'out',
        text: reply,
        msg_date: now,
        reply_to_id: null,
        raw_json: {
          source: 'getplatinum-callback',
          deal_id: dealId,
        },
      })

    if (msgErr) {
      await trace(traceId, 'getplatinum.reply_save_failed', {
        dialog_id: payment.dialog_id,
        error: msgErr.message,
      }, 'error')
      return res.status(200).json({ ok: false, reason: 'reply_save_failed' })
    }

    try {
      const result = await sendMessage(payment.vk_user_id, reply)
      await trace(traceId, 'getplatinum.reply_sent', {
        vk_user_id: payment.vk_user_id,
        result,
      })
    } catch (err) {
      await trace(traceId, 'getplatinum.reply_send_failed', {
        vk_user_id: payment.vk_user_id,
        error: err.message,
      }, 'error')
      return res.status(200).json({ ok: false, reason: 'reply_send_failed' })
    }
  }

  return res.status(200).json({ ok: true })
}
