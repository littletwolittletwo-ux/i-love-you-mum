#!/usr/bin/env node

/**
 * Register the Fish Audio voice with Retell and update Sarah's client record.
 *
 * Usage:
 *   node scripts/register-fish-voice.js
 *   node scripts/register-fish-voice.js <client-id>
 *
 * Defaults to SARAH_CLIENT_ID if no client-id is provided.
 */

require('dotenv').config();

const {
  registerFishVoiceForClient,
  registerFishVoice,
  SARAH_CLIENT_ID,
  FISH_AUDIO_PROVIDER_VOICE_ID,
} = require('../src/agents/retell');

async function main() {
  const clientId = process.argv[2] || SARAH_CLIENT_ID;

  console.log('=== Fish Audio Voice Registration ===');
  console.log(`Fish Audio model: ${FISH_AUDIO_PROVIDER_VOICE_ID}`);
  console.log(`Target client:    ${clientId}`);
  console.log('');

  try {
    const voiceId = await registerFishVoiceForClient(clientId);
    console.log('');
    console.log('=== SUCCESS ===');
    console.log(`Retell voice_id: ${voiceId}`);
    console.log(`Saved to client ${clientId} (elevenlabs_voice_id column)`);
    process.exit(0);
  } catch (err) {
    console.error('');
    console.error('=== FAILED ===');
    console.error(err.message);
    process.exit(1);
  }
}

main();
