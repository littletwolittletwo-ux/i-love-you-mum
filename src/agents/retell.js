const axios = require('axios');
const env = require('../../config/env');
const { RETELL_API_BASE } = require('../../config/constants');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');

const retellHeaders = {
  'Authorization': `Bearer ${env.RETELL_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * Create a Retell LLM + Agent for a client.
 * Retell requires: 1) create LLM with prompt/tools, 2) create agent referencing LLM.
 */
async function createRetellAgent(clientId) {
  console.log(`[retell] Creating Retell agent for client ${clientId}...`);

  const { data: client, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (error || !client) throw new Error(`Client not found: ${clientId}`);

  const systemPrompt = await buildSystemPrompt(clientId, null);

  // Build tools
  const generalTools = [
    {
      type: 'end_call',
      name: 'end_call',
      description: 'End the call when the conversation reaches a natural conclusion.',
    },
  ];

  // Step 1: Create Retell LLM
  const llmPayload = {
    model: 'claude-4.6-sonnet',
    general_prompt: systemPrompt,
    general_tools: generalTools,
    start_speaker: 'agent',
  };

  let llmId;
  try {
    const llmRes = await axios.post(`${RETELL_API_BASE}/create-retell-llm`, llmPayload, {
      headers: retellHeaders,
    });
    llmId = llmRes.data.llm_id;
    console.log(`[retell] LLM created: ${llmId}`);
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[retell] LLM creation failed:', JSON.stringify(errMsg));
    throw new Error(`Retell LLM creation failed: ${JSON.stringify(errMsg)}`);
  }

  // Step 2: Create Agent referencing the LLM
  const agentPayload = {
    agent_name: client.agent_name,
    response_engine: {
      type: 'retell-llm',
      llm_id: llmId,
    },
    voice_id: '11labs-Willa',
    language: 'en-US',
    interruption_sensitivity: 0.8,
  };

  try {
    const agentRes = await axios.post(`${RETELL_API_BASE}/create-agent`, agentPayload, {
      headers: retellHeaders,
    });

    const agentId = agentRes.data.agent_id;
    console.log(`[retell] Agent created: ${agentId}`);

    // Save both IDs
    await supabase
      .from('clients')
      .update({ retell_agent_id: agentId })
      .eq('id', clientId);

    return { agent_id: agentId, llm_id: llmId, ...agentRes.data };
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[retell] Agent creation failed:', JSON.stringify(errMsg));
    throw new Error(`Retell agent creation failed: ${JSON.stringify(errMsg)}`);
  }
}

/**
 * Update the Retell LLM prompt with fresh prospect memory.
 * Called before every call so memory is always current.
 */
async function updateAgentForProspect(clientId, prospectId) {
  console.log(`[retell] Updating agent for prospect ${prospectId}...`);

  const { data: client } = await supabase
    .from('clients')
    .select('retell_agent_id')
    .eq('id', clientId)
    .single();

  if (!client?.retell_agent_id) {
    throw new Error('No Retell agent ID found for client');
  }

  // Get the LLM ID from the agent
  let llmId;
  try {
    const agentRes = await axios.get(`${RETELL_API_BASE}/get-agent/${client.retell_agent_id}`, {
      headers: retellHeaders,
    });
    llmId = agentRes.data.response_engine?.llm_id;
  } catch (err) {
    console.error('[retell] Failed to fetch agent:', err.response?.data || err.message);
    throw new Error('Failed to fetch Retell agent');
  }

  if (!llmId) {
    throw new Error('No LLM ID found on Retell agent');
  }

  const systemPrompt = await buildSystemPrompt(clientId, prospectId);

  try {
    await axios.patch(`${RETELL_API_BASE}/update-retell-llm/${llmId}`, {
      general_prompt: systemPrompt,
    }, {
      headers: retellHeaders,
    });

    console.log(`[retell] LLM ${llmId} updated with prospect memory.`);
    return { llm_id: llmId, prompt_length: systemPrompt.length };
  } catch (err) {
    console.error('[retell] Failed to update LLM:', err.response?.data || err.message);
    throw new Error('Failed to update Retell LLM prompt');
  }
}

module.exports = { createRetellAgent, updateAgentForProspect };
