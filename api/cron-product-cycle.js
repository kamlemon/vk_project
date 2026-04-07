import { supabase } from '../lib/supabase.js'
import { sendMessage } from '../lib/vk.js'
import { trace } from '../lib/debug-trace.js'

const PAID_PRODUCT_ID = 2
const PRODUCT_CYCLE_DELAY_MINUTES = Number(process.env.PRODUCT_CYCLE_DELAY_MINUTES ?? 5)

function plusMinutesIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function getStepMessage({ firstName = 'Клиент', step }) {
  if (step === 1) {
    return `${firstName}, продолжаю работу.

Этап 2. Открытие финансового канала — запущен.

Сейчас иду по центральной части жизненной линии и снимаю напряжение, которое мешает деньгам идти свободнее. На этом этапе лучше ничего специально не делать — просто быть в спокойном состоянии и не спорить мысленно с процессом.

Ещё немного времени, и я вернусь с финальным закреплением.`
  }

  return `${firstName}, завершаю работу.

Финальный этап. Закрепление практики — завершён.

Я зафиксировала результат по финансовому каналу и закрыла цикл практики. Дальше просто понаблюдай за тем, как в ближайшие дни начнут проявляться новые движения: предложения, возвраты, идеи, ощущение большей лёгкости в деньгах.

Если захочешь потом описать, что изменилось по ощущениям или по факту, можешь написать мне сюда.`
}

async function getDialogsForCycle() {
  const { data, error } = await supabase
    .from('dialog')
    .select('id, vk_user_id, status_id, product_id, product_step, next_action_at, cycle_started_at, cycle_completed_at, message_count')
    .eq('status_id', 6)
    .is('cycle_completed_at', null)
    .not('next_action_at', 'is', null)
    .limit(100)

  if (error) throw error
  return data ?? []
}

async function getFirstName(vkUserId) {
  const { data, error } = await supabase
    .from('user')
    .select('first_name')
    .eq('vk_user_id', vkUserId)
    .maybeSingle()

  if (error) throw error
  return data?.first_name ?? 'Клиент'
}

async function saveReply({ dialogId, userId, reply, step }) {
  const { error } = await supabase.from('message').insert({
    dialog_id: dialogId,
    from_id: userId,
    peer_id: userId,
    direction: 'out',
    text: reply,
    msg_date: new Date().toISOString(),
    reply_to_id: null,
    raw_json: {
      source: 'cron-product-cycle',
      product_id: PAID_PRODUCT_ID,
      product_step: step,
    },
  })

  if (error) throw error
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const traceId = `cron-product-cycle-${Date.now()}`
  const now = new Date()

  try {
    const dialogs = await getDialogsForCycle()
    const sent = []
    const skipped = []

    for (const dialog of dialogs) {
      const dueAt = new Date(dialog.next_action_at)
      if (Number.isNaN(dueAt.getTime())) {
        skipped.push({ dialog_id: dialog.id, reason: 'invalid_next_action_at', value: dialog.next_action_at })
        continue
      }

      if (now < dueAt) {
        skipped.push({ dialog_id: dialog.id, reason: 'waiting', next_action_at: dialog.next_action_at })
        continue
      }

      const step = Number(dialog.product_step ?? 1)
      const firstName = await getFirstName(dialog.vk_user_id)
      const reply = getStepMessage({ firstName, step })

      await saveReply({
        dialogId: dialog.id,
        userId: dialog.vk_user_id,
        reply,
        step,
      })

      await sendMessage(dialog.vk_user_id, reply)

      const patch = step === 1
        ? {
            product_step: 2,
            next_action_at: plusMinutesIso(PRODUCT_CYCLE_DELAY_MINUTES),
            last_message_at: now.toISOString(),
            last_message_by: 'bot',
            message_count: (dialog.message_count ?? 0) + 1,
            status_id: 6,
          }
        : {
            product_step: 3,
            next_action_at: null,
            cycle_completed_at: now.toISOString(),
            last_message_at: now.toISOString(),
            last_message_by: 'bot',
            message_count: (dialog.message_count ?? 0) + 1,
            status_id: 7,
          }

      const { error: updErr } = await supabase
        .from('dialog')
        .update(patch)
        .eq('id', dialog.id)

      if (updErr) throw updErr

      await trace(traceId, 'cron.product_cycle_step_sent', {
        dialog_id: dialog.id,
        user_id: dialog.vk_user_id,
        previous_step: step,
        new_status_id: patch.status_id,
        new_product_step: patch.product_step,
        next_action_at: patch.next_action_at ?? null,
      })

      sent.push({
        dialog_id: dialog.id,
        user_id: dialog.vk_user_id,
        previous_step: step,
        new_status_id: patch.status_id,
        new_product_step: patch.product_step,
      })
    }

    await trace(traceId, 'cron.product_cycle_done', { sent, skipped })

    return res.status(200).json({ ok: true, sent, skipped })
  } catch (err) {
    await trace(traceId, 'cron.product_cycle_failed', { error: err.message }, 'error')
    return res.status(500).json({ ok: false, error: err.message })
  }
}
