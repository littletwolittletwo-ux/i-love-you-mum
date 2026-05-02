/**
 * Dual-LLM brain for low-latency voice calls.
 *
 * Architecture:
 *   - As the user speaks, partial transcript updates arrive from Retell
 *   - We fire Grok-4.1-Fast AND Claude Sonnet 4.6 in parallel on the partial
 *   - Both models stream their predicted response into separate buffers
 *   - When the user stops speaking (response_required), we count their words:
 *       <= WORD_THRESHOLD  -> ship Grok's response (fast lane)
 *       >  WORD_THRESHOLD  -> ship Sonnet's response (smart lane, had time to think)
 *   - If the prediction is stale (user said something very different), we fall
 *     back to a fresh in-line stream from the chosen model.
 *
 * Net effect: short utterances get a ~250ms response, long utterances get a
 * Sonnet response that started thinking 3-10 seconds ago, so it's almost
 * instant by the time the user actually stops talking.
 */

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const env = require('../../config/env');

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const FAST_MODEL = 'grok-4.1-fast';        // ~150-250ms TTFT, non-reasoning
const SMART_MODEL = 'claude-sonnet-4-6';   // ~500-900ms TTFT
const WORD_THRESHOLD = 8;                  // <= goes to fast lane, > goes to smart lane
const MIN_PREDICT_WORDS = 4;               // don't waste tokens predicting on tiny snippets
const RE_PREDICT_DELTA = 4;                // re-predict if user added this many new words
const STALE_OVERLAP_THRESHOLD = 0.5;       // below this word overlap ratio → prediction is stale

// callId -> session state
const sessions = new Map();

function getSession(callId) {
  if (!sessions.has(callId)) {
    sessions.set(callId, {
      callId,
      systemPrompt: '',
      pending: null, // { fast, smart, fastBuf, smartBuf, transcriptKey, predictedWords, abortController }
    });
  }
  return sessions.get(callId);
}

function clearSession(callId) {
  const s = sessions.get(callId);
  if (s?.pending?.abortController) {
    try { s.pending.abortController.abort(); } catch (_) {}
  }
  sessions.delete(callId);
}

function setSystemPrompt(callId, systemPrompt) {
  const s = getSession(callId);
  s.systemPrompt = systemPrompt;
}

// ------------- helpers -------------

function lastUserTurn(transcriptArray) {
  for (let i = transcriptArray.length - 1; i >= 0; i--) {
    if (transcriptArray[i].role === 'user') return transcriptArray[i].content || '';
  }
  return '';
}

function wordCount(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

function getWords(s) {
  return (s || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Compute word overlap ratio between two strings.
 * Returns 0..1 — the fraction of predicted words that appear in the final transcript.
 */
function wordOverlap(predicted, actual) {
  const pWords = getWords(predicted);
  const aWords = new Set(getWords(actual));
  if (pWords.length === 0) return 0;
  let hits = 0;
  for (const w of pWords) {
    if (aWords.has(w)) hits++;
  }
  return hits / pWords.length;
}

function buildMessages(transcriptArray) {
  return transcriptArray
    .filter(t => t.content && t.content.trim())
    .map(t => ({
      role: t.role === 'agent' ? 'assistant' : 'user',
      content: t.content,
    }));
}

// ------------- streaming primitives -------------

/**
 * Stream from xAI Grok using their OpenAI-compatible /v1/chat/completions.
 * Pushes tokens to `buffer` as they arrive. Returns when stream ends.
 * Honours AbortSignal so callers can cancel mid-flight.
 */
async function streamGrok({ systemPrompt, messages, buffer, signal }) {
  if (!env.XAI_API_KEY) {
    buffer.error = new Error('XAI_API_KEY not set — Grok fast-lane unavailable');
    buffer.done = true;
    return;
  }

  const res = await axios.post(
    'https://api.x.ai/v1/chat/completions',
    {
      model: FAST_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true,
      temperature: 0.8,
      max_tokens: 200,
    },
    {
      headers: {
        Authorization: `Bearer ${env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      responseType: 'stream',
      signal,
    },
  );

  return new Promise((resolve, reject) => {
    let leftover = '';
    res.data.on('data', (chunk) => {
      const text = leftover + chunk.toString('utf8');
      const lines = text.split('\n');
      leftover = lines.pop(); // last fragment may be partial
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return resolve();
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) buffer.tokens.push(delta);
        } catch (_) { /* skip */ }
      }
    });
    res.data.on('end', () => { buffer.done = true; resolve(); });
    res.data.on('error', (e) => { buffer.error = e; reject(e); });
  });
}

/**
 * Stream from Claude Sonnet 4.6 via the Anthropic SDK.
 */
async function streamSonnet({ systemPrompt, messages, buffer, signal }) {
  const stream = anthropic.messages.stream(
    {
      model: SMART_MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages,
    },
    { signal },
  );

  stream.on('text', (text) => buffer.tokens.push(text));
  await stream.finalMessage();
  buffer.done = true;
}

function makeBuffer() {
  return { tokens: [], done: false, error: null };
}

// ------------- pre-generation -------------

/**
 * Called on every Retell `update_only` event. If the user has said enough new
 * words since our last prediction, fire fresh Grok + Sonnet predictions.
 */
function predictResponses(callId, transcriptArray) {
  const session = getSession(callId);
  const lastUser = lastUserTurn(transcriptArray);
  const wc = wordCount(lastUser);
  if (wc < MIN_PREDICT_WORDS) return;

  // De-dup: if we're already predicting on roughly this transcript, leave it.
  const transcriptKey = lastUser.slice(0, 200);
  if (session.pending) {
    const prevWords = session.pending.predictedWords || 0;
    if (Math.abs(wc - prevWords) < RE_PREDICT_DELTA) return;
    // User added enough new words — cancel old predictions and re-predict
    try { session.pending.abortController.abort(); } catch (_) {}
  }

  console.log(`[dual-llm] predicting on ${wc} words`);

  const abortController = new AbortController();
  const messages = buildMessages(transcriptArray);
  const predictPrompt = session.systemPrompt +
    '\n\nNOTE: The user may still be mid-thought. Respond as if they have just paused. Keep it concise (under 25 words).';

  const fastBuf = makeBuffer();
  const smartBuf = makeBuffer();

  const fast = streamGrok({
    systemPrompt: predictPrompt, messages, buffer: fastBuf, signal: abortController.signal,
  }).catch((e) => {
    if (e.name !== 'AbortError' && e.name !== 'CanceledError') {
      console.error('[dual-llm] grok predict error:', e.message);
      fastBuf.error = e;
    }
  });

  const smart = streamSonnet({
    systemPrompt: predictPrompt, messages, buffer: smartBuf, signal: abortController.signal,
  }).catch((e) => {
    if (e.name !== 'AbortError' && e.name !== 'APIUserAbortError') {
      console.error('[dual-llm] sonnet predict error:', e.message);
      smartBuf.error = e;
    }
  });

  session.pending = {
    fast, smart, fastBuf, smartBuf, transcriptKey, abortController,
    predictedWords: wc,
    startedAt: Date.now(),
  };
}

// ------------- final response selection -------------

/**
 * Called on Retell `response_required`. Decides which model to use, then
 * streams that model's tokens back via the `onToken` callback.
 *
 * Returns when the chosen model's stream completes.
 */
async function streamFinalResponse({ callId, transcriptArray, onToken }) {
  const session = getSession(callId);
  const lastUser = lastUserTurn(transcriptArray);
  const wc = wordCount(lastUser);
  const useFast = wc <= WORD_THRESHOLD;
  const lane = useFast ? 'GROK' : 'SONNET';
  const startedAt = Date.now();

  console.log(`[dual-llm] response_required: ${wc} words → ${lane}`);

  const pending = session.pending;

  // Use the prediction if it exists, the buffer has no error, and the
  // transcript hasn't diverged too far from what we predicted on.
  let canUsePrediction = false;
  if (pending && !(useFast ? pending.fastBuf.error : pending.smartBuf.error)) {
    const overlap = wordOverlap(pending.transcriptKey, lastUser.slice(0, 200));
    if (overlap >= STALE_OVERLAP_THRESHOLD) {
      canUsePrediction = true;
    } else {
      console.log(`[dual-llm] prediction stale (overlap=${(overlap * 100).toFixed(0)}%) — falling back to fresh`);
    }
  }

  if (canUsePrediction) {
    const buffer = useFast ? pending.fastBuf : pending.smartBuf;

    // Flush whatever's already been streamed
    let i = 0;
    const flush = () => {
      while (i < buffer.tokens.length) onToken(buffer.tokens[i++]);
    };
    flush();

    // Wait for any remaining tokens to arrive
    while (!buffer.done && !buffer.error) {
      await new Promise(r => setTimeout(r, 25));
      flush();
    }
    flush();
    session.pending = null;
    console.log(`[dual-llm] ${lane} done in ${Date.now() - startedAt}ms (cached)`);
    return;
  }

  // Cold path — no usable prediction. Cancel any pending and stream fresh.
  if (pending) {
    try { pending.abortController.abort(); } catch (_) {}
    session.pending = null;
  }

  const messages = buildMessages(transcriptArray);
  const buffer = makeBuffer();
  let i = 0;
  const flushLoop = setInterval(() => {
    while (i < buffer.tokens.length) onToken(buffer.tokens[i++]);
  }, 20);

  try {
    if (useFast) {
      await streamGrok({ systemPrompt: session.systemPrompt, messages, buffer, signal: undefined });
      // If Grok returned an error (e.g. no API key), fall back to Sonnet
      if (buffer.error && buffer.tokens.length === 0) {
        console.warn(`[dual-llm] Grok failed (${buffer.error.message}) — falling back to SONNET`);
        buffer.error = null;
        buffer.done = false;
        await streamSonnet({ systemPrompt: session.systemPrompt, messages, buffer, signal: undefined });
      }
    } else {
      await streamSonnet({ systemPrompt: session.systemPrompt, messages, buffer, signal: undefined });
    }
  } finally {
    clearInterval(flushLoop);
    while (i < buffer.tokens.length) onToken(buffer.tokens[i++]);
  }
  console.log(`[dual-llm] ${lane} done in ${Date.now() - startedAt}ms (fresh)`);
}

module.exports = {
  setSystemPrompt,
  predictResponses,
  streamFinalResponse,
  clearSession,
  // exposed for tests / metrics:
  WORD_THRESHOLD,
  FAST_MODEL,
  SMART_MODEL,
};
