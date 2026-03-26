import { supabase } from './supabase.js'

const ENABLED = process.env.DEBUG_TRACE_ENABLED === 'true'

export async function trace(traceId, step, payload = null, level = 'info') {
  const row = {
    trace_id: traceId,
    step,
    level,
    payload,
  }

  console.log(`[TRACE][${level.toUpperCase()}][${traceId}][${step}]`, payload ?? '')

  if (!ENABLED) return

  try {
    await supabase.from('debug_trace').insert(row)
  } catch (e) {
    console.error('[debug-trace] failed:', e.message)
  }
}
