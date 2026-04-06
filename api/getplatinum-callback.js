import { supabase } from '../lib/supabase.js'
import { trace } from '../lib/debug-trace.js'
import { verifyGetPlatinumChecksum } from '../lib/getplatinum.js'
import { sendMessage } from '../lib/vk.js'

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

  if (notificationType === 1 && isSuccess) {
    const { error: dialogUpdErr } = await supabase
      .from('dialog')
      .update({
        status_id: 6,
        last_message_at: now,
        last_message_by: 'bot',
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
    })

    const reply = 'Оплату вижу — всё прошло успешно. Перевожу тебя в этап работы по продукту. Следующим сообщением напишу, как всё будет дальше.'

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
