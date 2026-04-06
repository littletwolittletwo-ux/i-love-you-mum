/**
 * Raven Perception Engine — Tavus Raven-1 for perception ONLY.
 * Watches prospect's video feed and fires signals into LLM context.
 * Uses Redis for real-time perception signal buffering (falls back to in-memory Map).
 */

let redis = null;
const memoryStore = new Map();

function initRedis() {
  if (redis) return redis;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  try {
    const Redis = require('ioredis');
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    redis.on('error', () => { redis = null; });
    redis.connect().catch(() => { redis = null; });
    return redis;
  } catch { return null; }
}

/**
 * Init Raven perception for a session.
 * In production: connects to Tavus Raven API and watches prospect video.
 * In current implementation: sets up the signal pipeline.
 */
async function initRavenPerception(sessionId, prospectVideoTrack) {
  console.log(`[raven] Perception active for session: ${sessionId}`);
  const r = initRedis();
  if (r) {
    try { await r.set(`raven:${sessionId}`, JSON.stringify({ active: true, startTime: Date.now() }), 'EX', 7200); } catch {}
  } else {
    memoryStore.set(`raven:${sessionId}`, { active: true, startTime: Date.now() });
  }
  return { sessionId, active: true };
}

// --- Event handlers — format signals for LLM injection ---

function onEmotionDetected({ emotion, intensity, timestamp }) {
  return `[LIVE SIGNAL: prospect appears ${emotion} — intensity ${intensity}/10 at ${timestamp || new Date().toISOString()}]`;
}

function onAttentionShift({ looking_away, duration_ms }) {
  if (duration_ms > 3000) {
    return `[LIVE SIGNAL: prospect looked away for ${(duration_ms / 1000).toFixed(1)}s — re-engage naturally, do not call it out directly]`;
  }
  return null;
}

function onLaughter({ intensity }) {
  return `[LIVE SIGNAL: prospect laughed — genuine connection moment, don't pivot sales, stay in this energy]`;
}

function onHesitation({ duration_ms, pattern }) {
  return `[LIVE SIGNAL: prospect hesitating ${duration_ms}ms — slow down, ask one open question, do not push]`;
}

function onSpeechStart() {
  return `[LIVE SIGNAL: prospect is speaking — stop talking immediately, listen]`;
}

/**
 * Append a perception signal to the session buffer.
 * Keeps last 5 signals. Recency > history.
 */
async function appendPerceptionContext(sessionId, signal) {
  if (!signal) return;
  const key = `perception:${sessionId}`;
  const r = initRedis();

  if (r) {
    try {
      await r.rpush(key, signal);
      await r.ltrim(key, -5, -1); // Keep last 5
      await r.expire(key, 300);
      return;
    } catch {}
  }

  // In-memory fallback
  if (!memoryStore.has(key)) memoryStore.set(key, []);
  const arr = memoryStore.get(key);
  arr.push(signal);
  if (arr.length > 5) arr.splice(0, arr.length - 5);
}

/**
 * Get current perception context for a session.
 */
async function getPerceptionContext(sessionId) {
  const key = `perception:${sessionId}`;
  const r = initRedis();

  if (r) {
    try {
      const entries = await r.lrange(key, 0, -1);
      return entries.join('\n');
    } catch {}
  }

  const arr = memoryStore.get(key) || [];
  return arr.join('\n');
}

/**
 * Close a Raven session and clean up.
 */
async function closeRavenSession(sessionId) {
  console.log(`[raven] Closing session: ${sessionId}`);
  const r = initRedis();
  if (r) {
    try {
      await r.del(`raven:${sessionId}`);
      await r.del(`perception:${sessionId}`);
    } catch {}
  }
  memoryStore.delete(`raven:${sessionId}`);
  memoryStore.delete(`perception:${sessionId}`);
}

module.exports = {
  initRavenPerception,
  onEmotionDetected,
  onAttentionShift,
  onLaughter,
  onHesitation,
  onSpeechStart,
  appendPerceptionContext,
  getPerceptionContext,
  closeRavenSession,
};
