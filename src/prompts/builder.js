const supabase = require('../database/client');
const { buildSoulLayer } = require('./soul');

/**
 * Build the complete system prompt with three layers:
 * 1. Soul — the agent's identity, personality, voice
 * 2. Memory — what we know about the prospect
 * 3. Capabilities — what tools the agent can use
 */
async function buildSystemPrompt(clientId, prospectId) {
  // Fetch client
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (clientErr || !client) {
    throw new Error(`Client not found: ${clientId}`);
  }

  let soul = {};
  try {
    soul = typeof client.soul_document === 'string'
      ? JSON.parse(client.soul_document)
      : client.soul_document || {};
  } catch (e) {
    soul = {};
  }

  // LAYER 1 — SOUL
  const soulLayer = buildSoulLayer(soul, client);

  // LAYER 2 — MEMORY (prospect context)
  let memoryLayer = '';
  if (prospectId) {
    const { data: prospect } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', prospectId)
      .single();

    if (prospect) {
      memoryLayer = buildMemoryLayer(prospect);
    }
  }

  // LAYER 3 — CAPABILITIES
  const capabilitiesLayer = buildCapabilitiesLayer(client, soul);

  // CONTEXT
  const contextLayer = buildContextLayer(client, prospectId);

  let fullPrompt = [soulLayer, memoryLayer, capabilitiesLayer, contextLayer]
    .filter(Boolean)
    .join('\n\n---\n\n');

  // Enhance with training data if available
  try {
    const { buildTrainingEnhancedPrompt } = require('../training/inject');
    fullPrompt = await buildTrainingEnhancedPrompt(fullPrompt);
  } catch (err) {
    // Training data not available — use base prompt
  }

  return fullPrompt;
}

function buildMemoryLayer(prospect) {
  const objections = prospect.objections || { raised: [], resolved: [], unresolved: [] };
  const painPoints = prospect.pain_points || {};
  const personalNotes = prospect.personal_notes || [];
  const buyingSignals = prospect.buying_signals || [];

  return `
ABOUT THE PERSON YOU ARE TALKING TO:
Name: ${prospect.name || 'Unknown'}
${prospect.business_name ? `Their business: ${prospect.business_name}` : ''}
You have spoken ${prospect.call_count || 0} times before.

What you know about their situation:
${Object.entries(painPoints).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- Not much yet — this is your chance to learn.'}

Things they've mentioned personally:
${personalNotes.map(n => `- ${n}`).join('\n') || '- Nothing personal shared yet.'}

Their communication style: ${prospect.communication_style || 'Not assessed yet — pay attention and adapt.'}

Where they are in their journey: ${prospect.funnel_stage || 'lead'}

${prospect.last_contact ? `Last time you spoke: ${new Date(prospect.last_contact).toLocaleDateString()}` : 'This is your first conversation.'}

${prospect.next_action ? `What you said you'd follow up on: ${prospect.next_action}` : ''}

${objections.raised && objections.raised.length > 0 ? `Objections they've raised before: ${objections.raised.join(', ')}` : ''}
${objections.resolved && objections.resolved.length > 0 ? `Objections you've resolved: ${objections.resolved.join(', ')}` : ''}

${buyingSignals.length > 0 ? `Buying signals you've noticed: ${buyingSignals.join(', ')}` : ''}
`;
}

function buildCapabilitiesLayer(client, soul) {
  const sections = [];
  const tools = [];

  if (client.closing_enabled) {
    const objectionHandling = soul.conversation_style?.how_they_handle_objections || 'Direct but empathetic';
    const topObjections = client.top_objections || [];

    sections.push(`
CLOSING CAPABILITY — ACTIVE:
When the conversation reaches a natural point of decision, guide them toward it.
Don't be pushy. Be direct. Be honest. If it's right for them, help them see that.
If it's not right, tell them honestly.

Common objections you'll hear:
${topObjections.map(o => `- "${o}"`).join('\n')}

Your style of handling objections: ${objectionHandling}
`);
    tools.push({
      name: 'send_payment_link',
      description: 'Send a payment link to the prospect when they are ready to move forward',
    });
    tools.push({
      name: 'book_follow_up',
      description: 'Schedule a follow-up call when the timing makes sense',
    });
  }

  if (client.booking_enabled) {
    sections.push(`
BOOKING CAPABILITY — ACTIVE:
You can schedule follow-up calls naturally. Don't force it.
`);
    if (!tools.find(t => t.name === 'book_follow_up')) {
      tools.push({
        name: 'book_follow_up',
        description: 'Schedule a follow-up call',
      });
    }
  }

  if (client.crm_enabled) {
    sections.push(`
CRM CAPABILITY — ACTIVE:
After every conversation, update the records so you remember everything next time.
`);
    tools.push({
      name: 'update_crm',
      description: 'Update prospect records with new information',
    });
  }

  // Always available
  tools.push({
    name: 'pull_prospect_data',
    description: 'Pull up what you know about this person mid-conversation',
  });

  sections.push(`
TOOLS YOU CAN USE:
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}
`);

  return sections.join('\n');
}

function buildContextLayer(client, prospectId) {
  const now = new Date();
  return `
CURRENT CONTEXT:
Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
You work for: ${client.business_name}
${client.offer_name ? `The offer: ${client.offer_name}` : ''}
${client.offer_price ? `Investment: $${client.offer_price}` : ''}
${client.transformation ? `The transformation: ${client.transformation}` : ''}
${client.target_prospect ? `Who you help: ${client.target_prospect}` : ''}
`;
}

module.exports = { buildSystemPrompt };
