/**
 * Transcript buffer — stores real-time transcript chunks keyed by bot_id.
 * Uses Redis if REDIS_URL is set, otherwise falls back to in-memory Map.
 */

let redis = null;
const memoryStore = new Map();

function initRedis() {
  if (redis) return redis;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  try {
    const Redis = require('ioredis');
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    redis.on('error', (err) => {
      console.warn('[transcript-buffer] Redis error, falling back to memory:', err.message);
      redis = null;
    });
    redis.connect().catch(() => {
      console.warn('[transcript-buffer] Redis connect failed, using memory.');
      redis = null;
    });
    return redis;
  } catch (err) {
    console.warn('[transcript-buffer] Redis unavailable:', err.message);
    return null;
  }
}

async function appendChunk(botId, chunk) {
  const r = initRedis();
  const entry = JSON.stringify(chunk);

  if (r) {
    try {
      await r.rpush(`transcript:${botId}`, entry);
      await r.expire(`transcript:${botId}`, 7200); // 2 hour TTL
      return;
    } catch (err) {
      // Fall through to memory
    }
  }

  // In-memory fallback
  if (!memoryStore.has(botId)) {
    memoryStore.set(botId, []);
  }
  memoryStore.get(botId).push(chunk);
}

async function getTranscript(botId) {
  const r = initRedis();

  if (r) {
    try {
      const entries = await r.lrange(`transcript:${botId}`, 0, -1);
      return entries.map(e => JSON.parse(e));
    } catch (err) {
      // Fall through
    }
  }

  return memoryStore.get(botId) || [];
}

async function clearTranscript(botId) {
  const r = initRedis();

  if (r) {
    try {
      await r.del(`transcript:${botId}`);
    } catch (err) {
      // Fall through
    }
  }

  memoryStore.delete(botId);
}

module.exports = { appendChunk, getTranscript, clearTranscript };
