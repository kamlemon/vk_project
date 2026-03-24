import { supabase } from './supabase.js'

export async function log(source, message, payload = null, level = 'info') {
  console.log(`[${level.toUpperCase()}][${source}] ${message}`, payload ?? '')
  try {
    await supabase.from('log').insert({ level, source, message, payload })
  } catch (e) {
    console.error('[logger] failed to write log:', e.message)
  }
}
