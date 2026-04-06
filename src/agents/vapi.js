const axios = require('axios');
const env = require('../../config/env');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');

const VAPI_API_BASE = 'https://api.vapi.ai';

const vapiHeaders = {
  'Authorization': `Bearer ${env.VAPI_API_KEY}`,
  'Content-Type': 'application/json',
};

async function createVapiAgent(clientId) {
  console.log(`[vapi] Creating Vapi agent (setter) for client ${clientId}...`);

  const { data: client, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (error || !client) throw new Error(`Client not found: ${clientId}`);

  const fullPrompt = await buildSystemPrompt(clientId, null);

  const setterOverride = `${fullPrompt}

SETTER ROLE:
Your primary goal in this conversation is NOT to close. It's to:
1. Build genuine rapport
2. Understand their situation deeply
3. Qualify whether they're a good fit
4. If they are, naturally guide them toward booking a deeper conversation

Be warm. Be curious. Be real. Don't pitch. Don't sell. Just have a genuine conversation and see if there's a fit.`;

  const payload = {
    name: `${client.agent_name} - Setter`,
    model: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      messages: [
        {
          role: 'system',
          content: setterOverride,
        },
      ],
    },
    voice: {
      provider: '11labs',
      voiceId: client.elevenlabs_voice_id || env.ELEVENLABS_VOICE_ID,
      model: 'eleven_turbo_v2_5',
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
    },
  };

  try {
    const response = await axios.post(`${VAPI_API_BASE}/assistant`, payload, {
      headers: vapiHeaders,
    });

    const agentId = response.data.id;
    console.log(`[vapi] Agent created: ${agentId}`);

    await supabase
      .from('clients')
      .update({ vapi_agent_id: agentId })
      .eq('id', clientId);

    return response.data;
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[vapi] Failed to create agent:', JSON.stringify(errMsg));
    throw new Error(`Vapi agent creation failed: ${JSON.stringify(errMsg)}`);
  }
}

module.exports = { createVapiAgent };
