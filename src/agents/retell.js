const axios = require('axios');
const env = require('../../config/env');
const { RETELL_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');

const FISH_AUDIO_PROVIDER_VOICE_ID = '662c531048e24e5ba3fe2b28092ded46';
const SARAH_CLIENT_ID = '9d3cd726-c57b-470d-9b18-24361a119496';

const retellHeaders = {
  'Authorization': `Bearer ${env.RETELL_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * Build the wss:// URL for the custom-LLM WebSocket handler.
 * Handles http→ws and https→wss replacement.
 */
function getWebSocketUrl() {
  const base = env.BASE_URL || process.env.BASE_URL || '';
  return `${base.replace(/^http/, 'ws')}/llm-websocket`;
}

/**
 * Register a Fish Audio voice with Retell so it can be used in agents.
 * Returns the Retell-assigned voice_id for the Fish Audio voice.
 */
async function registerFishVoice() {
  console.log(`[retell] Registering Fish Audio voice (provider_voice_id=${FISH_AUDIO_PROVIDER_VOICE_ID})...`);

  try {
    const res = await axios.post(`${RETELL_API_BASE}/add-community-voice`, {
      voice_provider: 'fish_audio',
      provider_voice_id: FISH_AUDIO_PROVIDER_VOICE_ID,
    }, {
      headers: retellHeaders,
    });

    const voiceId = res.data.voice_id;
    console.log(`[retell] Fish Audio voice registered: ${voiceId}`);
    return voiceId;
  } catch (err) {
    // If voice already exists, Retell may return a conflict — try to extract the existing voice_id
    if (err.response?.status === 409 || err.response?.data?.voice_id) {
      const existingId = err.response?.data?.voice_id;
      if (existingId) {
        console.log(`[retell] Fish Audio voice already registered: ${existingId}`);
        return existingId;
      }
    }
    const errMsg = err.response?.data || err.message;
    console.error('[retell] Fish Audio voice registration failed:', JSON.stringify(errMsg));
    throw new Error(`Fish Audio voice registration failed: ${JSON.stringify(errMsg)}`);
  }
}

/**
 * Register the Fish Audio voice and update a client's record with it.
 * Stores the Retell voice_id in the elevenlabs_voice_id column (legacy name).
 */
async function registerFishVoiceForClient(clientId) {
  const voiceId = await registerFishVoice();

  await supabase
    .from('clients')
    .update({ elevenlabs_voice_id: voiceId })
    .eq('id', clientId);

  console.log(`[retell] Client ${clientId} updated with Fish voice_id: ${voiceId}`);
  return voiceId;
}

/**
 * Get the voice_id for a client. If they have one stored (elevenlabs_voice_id column),
 * use it. Otherwise register Fish Audio and save it.
 */
async function resolveVoiceId(client) {
  if (client.elevenlabs_voice_id) {
    console.log(`[retell] Using stored voice_id: ${client.elevenlabs_voice_id}`);
    return client.elevenlabs_voice_id;
  }

  // Register Fish Audio voice and save to client
  console.log(`[retell] No voice_id stored for client ${client.id} — registering Fish Audio voice`);
  return registerFishVoiceForClient(client.id);
}

/**
 * Create a Retell Agent for a client with custom-LLM response engine
 * and Fish Audio voice.
 */
async function createRetellAgent(clientId) {
  console.log(`[retell] Creating Retell agent for client ${clientId}...`);

  const { data: client, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (error || !client) throw new Error(`Client not found: ${clientId}`);

  // Duplicate guard: if client already has a Retell agent, verify it exists before creating a new one
  if (client.retell_agent_id) {
    try {
      const existing = await axios.get(`${RETELL_API_BASE}/get-agent/${client.retell_agent_id}`, {
        headers: retellHeaders,
      });

      // Verify the existing agent has the correct config; update if needed
      const agent = existing.data;
      const wsUrl = getWebSocketUrl();
      const needsUpdate =
        agent.response_engine?.type !== 'custom-llm' ||
        agent.response_engine?.llm_websocket_url !== wsUrl;

      if (needsUpdate) {
        console.log(`[retell] Agent ${client.retell_agent_id} exists but config is stale — updating`);
        const voiceId = await resolveVoiceId(client);
        await updateRetellAgent(client.retell_agent_id, voiceId);
      } else {
        console.log(`[retell] Agent already exists and config is correct: ${client.retell_agent_id}`);
      }

      return { agent_id: client.retell_agent_id, ...existing.data };
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`[retell] Existing agent ${client.retell_agent_id} not found on Retell — creating new one`);
      } else {
        console.warn(`[retell] Could not verify existing agent: ${err.message} — creating new one`);
      }
    }
  }

  // Resolve the Fish Audio voice_id (register if needed)
  const voiceId = await resolveVoiceId(client);

  const wsUrl = getWebSocketUrl();
  console.log(`[retell] WebSocket URL: ${wsUrl}`);

  // Create Agent with custom-llm response engine pointing to our dual-LLM WebSocket
  const agentPayload = {
    agent_name: client.agent_name || `Agent-${clientId.slice(0, 8)}`,
    response_engine: {
      type: 'custom-llm',
      llm_websocket_url: wsUrl,
    },
    voice_id: voiceId,
    language: 'en-US',
    voice_model: 'eleven_turbo_v2',   // streaming-optimised TTS model
    voice_speed: 1.05,                // slightly faster for natural sales cadence
    voice_temperature: 1.0,
    responsiveness: 1.0,              // max responsiveness — ship audio ASAP
    interruption_sensitivity: 0.8,
    ambient_sound: 'coffee-shop',     // subtle background ambience for realism
    enable_backchannel: true,
    backchannel_frequency: 0.8,
    backchannel_words: ['yeah', 'right', 'totally', 'mm', 'uh huh', 'for sure', 'exactly'],
  };

  try {
    const agentRes = await axios.post(`${RETELL_API_BASE}/create-agent`, agentPayload, {
      headers: retellHeaders,
    });

    const agentId = agentRes.data.agent_id;
    console.log(`[retell] Agent created: ${agentId} (voice: ${voiceId}, engine: custom-llm)`);

    // Save agent ID
    await supabase
      .from('clients')
      .update({ retell_agent_id: agentId })
      .eq('id', clientId);

    return { agent_id: agentId, ...agentRes.data };
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[retell] Agent creation failed:', JSON.stringify(errMsg));
    throw new Error(`Retell agent creation failed: ${JSON.stringify(errMsg)}`);
  }
}

/**
 * Update an existing Retell agent with correct config.
 */
async function updateRetellAgent(agentId, voiceId) {
  const wsUrl = getWebSocketUrl();

  const updatePayload = {
    response_engine: {
      type: 'custom-llm',
      llm_websocket_url: wsUrl,
    },
    voice_id: voiceId,
  };

  try {
    const res = await axios.patch(`${RETELL_API_BASE}/update-agent/${agentId}`, updatePayload, {
      headers: retellHeaders,
    });
    console.log(`[retell] Agent ${agentId} updated (voice: ${voiceId}, engine: custom-llm, ws: ${wsUrl})`);
    return res.data;
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error(`[retell] Agent update failed for ${agentId}:`, JSON.stringify(errMsg));
    throw new Error(`Retell agent update failed: ${JSON.stringify(errMsg)}`);
  }
}

/**
 * No-op: custom-llm builds the system prompt fresh at call time via the
 * WebSocket handler, so there's no Retell-managed LLM to update.
 */
async function updateAgentForProspect(clientId, prospectId) {
  return { skipped: true, reason: 'custom-llm builds prompt at call time' };
}

/**
 * Initiate an outbound phone call via Retell.
 * Updates agent prompt with fresh memory, then places the call.
 */
async function initiateOutboundCall(prospectId, clientId, phoneNumber) {
  console.log(`[retell] Initiating outbound call to ${phoneNumber} for prospect ${prospectId}...`);

  const { data: prospect, error: pErr } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', prospectId)
    .single();

  if (pErr || !prospect) throw new Error(`Prospect not found: ${prospectId}`);

  const { data: client, error: cErr } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (cErr || !client) throw new Error(`Client not found: ${clientId}`);
  if (!client.retell_agent_id) throw new Error('No Retell agent configured for this client');

  const retellPhone = env.RETELL_PHONE_NUMBER || process.env.RETELL_PHONE_NUMBER;
  if (!retellPhone) {
    throw new Error('RETELL_PHONE_NUMBER not configured. Go to app.retellai.com → Phone Numbers → Buy a number → then set RETELL_PHONE_NUMBER in your environment variables.');
  }

  // Update agent with fresh prospect memory
  await updateAgentForProspect(clientId, prospectId);

  // Place the call via Retell v2
  let retellCall;
  try {
    const callRes = await axios.post(`${RETELL_API_BASE}/v2/create-phone-call`, {
      from_number: retellPhone,
      to_number: phoneNumber,
      agent_id: client.retell_agent_id,
      metadata: {
        prospect_id: prospectId,
        client_id: clientId,
      },
    }, {
      headers: retellHeaders,
    });
    retellCall = callRes.data;
    console.log(`[retell] Call initiated: ${retellCall.call_id}`);
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[retell] Outbound call failed:', JSON.stringify(errMsg));
    throw new Error(`Retell outbound call failed: ${JSON.stringify(errMsg)}`);
  }

  // Create call record in Supabase
  const { data: callRecord, error: callErr } = await supabase
    .from('calls')
    .insert({
      prospect_id: prospectId,
      client_id: clientId,
      retell_call_id: retellCall.call_id,
      call_type: 'phone',
      status: 'active',
    })
    .select()
    .single();

  if (callErr) {
    console.error('[retell] Failed to save call record:', callErr.message);
  }

  return {
    call_id: callRecord?.id || null,
    retell_call_id: retellCall.call_id,
    status: 'initiated',
    call: callRecord,
  };
}

/**
 * Get call status from Retell API.
 */
async function getRetellCallStatus(retellCallId) {
  try {
    const res = await axios.get(`${RETELL_API_BASE}/v2/get-call/${retellCallId}`, {
      headers: retellHeaders,
    });
    return res.data;
  } catch (err) {
    console.error('[retell] Failed to get call status:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  createRetellAgent,
  updateRetellAgent,
  updateAgentForProspect,
  initiateOutboundCall,
  getRetellCallStatus,
  registerFishVoice,
  registerFishVoiceForClient,
  FISH_AUDIO_PROVIDER_VOICE_ID,
  SARAH_CLIENT_ID,
};
