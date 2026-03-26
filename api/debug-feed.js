import { supabase } from '../lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const limit = Math.min(Number(req.query?.limit || 300), 1000)
  const sinceId = Number(req.query?.since_id || 0)
  const traceId = req.query?.trace_id || null

  let q = supabase
    .from('debug_trace')
    .select('*')
    .order('id', { ascending: true })
    .limit(limit)

  if (sinceId > 0) q = q.gt('id', sinceId)
  if (traceId) q = q.eq('trace_id', traceId)

  const { data, error } = await q

  if (error) {
    return res.status(500).json({ error: error.message })
  }

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ rows: data ?? [] })
}
