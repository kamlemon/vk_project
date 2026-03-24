import { supabase } from '../lib/supabase.js';
import { callGemini } from '../lib/gemini.js';
import { sendMessage } from '../lib/vk.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  res.status(200).send('ok');

  const { user_id, text } = req.body;

  if (!user_id || !text) {
    console.error('[new-user] Missing user_id or text');
    return;
  }

  try {
    const { error: insertUserError } = await supabase
      .from('user')
      .insert({ user_id, is_paid: false, consultation_done: false })
      .onConflict('user_id')
      .ignore();

    if (insertUserError) {
      console.error('[new-user] insertUser error:', insertUserError.message);
    }

    const { data: docRow } = await supabase
      .from('document')
      .select('content')
      .eq('type', 'system_prompt')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!docRow) {
      console.warn('[new-user] No system_prompt document found — Gemini without system prompt');
    }

    const systemPrompt = docRow?.content ?? null;

    const { reply, inputTokens, outputTokens } = await callGemini(systemPrompt, text);

    const { error: insertReplyError } = await supabase
      .from('message')
      .insert({ user_id, role: 'assistant', content: reply });

    if (insertReplyError) {
      console.error('[new-user] insertReply error:', insertReplyError.message);
    }

    const { error: insertTokensError } = await supabase
      .from('token_usage')
      .insert({ user_id, input_tokens: inputTokens, output_tokens: outputTokens });

    if (insertTokensError) {
      console.error('[new-user] insertTokens error:', insertTokensError.message);
    }

    await sendMessage(user_id, reply);

  } catch (err) {
    console.error('[new-user] Unhandled error:', err.message);
  }
}
