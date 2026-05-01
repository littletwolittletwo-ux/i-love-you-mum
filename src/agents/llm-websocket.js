/**
 * Retell custom-LLM WebSocket server.
 *
 * Retell connects to wss://YOUR_HOST/llm-websocket/:call_id once per call.
 * It sends:
 *   - call_details            (initial)
 *   - update_only             (transcript update during user speech)
 *   - response_required       (user has stopped, agent must respond)
 *   - reminder_required       (silence — prompt the agent to break it)
 *   - ping_pong               (keepalive)
 *
 * We send back:
 *   - response                (streamed tokens for a given response_id)
 *   - config                  (initial config, optional)
 *
 * Spec: https://docs.retellai.com/api-references/llm-websocket
 */

const WebSocket = require('ws');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');
const dualLLM = require('./dual-llm');

function attach(server, { path = '/llm-websocket' } = {}) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith(path)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const callId = req.url.split('/').pop().split('?')[0];
      handleConnection(ws, callId);
    });
  });

  console.log(`[llm-ws] WebSocket server attached at ${path}/:call_id`);
}

async function handleConnection(ws, callId) {
  console.log(`[llm-ws] connection opened: callId=${callId}`);

  // 1) Send initial config — we want transcript updates so we can pre-generate
  ws.send(JSON.stringify({
    response_type: 'config',
    config: {
      auto_reconnect: true,
      call_details: true,
    },
    response_id: 1,
  }));

  // System prompt is loaded once per call from the call's client
  let systemPromptLoaded = false;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error('[llm-ws] bad JSON:', e.message);
      return;
    }

    try {
      switch (msg.interaction_type) {
        case 'call_details':
          // Bootstrap the system prompt from Supabase based on metadata
          await bootstrapSession(callId, msg);
          systemPromptLoaded = true;
          break;

        case 'update_only':
          if (!systemPromptLoaded) return;
          // User is mid-utterance — fire pre-generations
          dualLLM.predictResponses(callId, msg.transcript || []);
          break;

        case 'response_required':
        case 'reminder_required': {
          if (!systemPromptLoaded) {
            // Edge case: response needed before call_details arrived
            await bootstrapSession(callId, msg);
            systemPromptLoaded = true;
          }
          await respondToTurn(ws, callId, msg);
          break;
        }

        case 'ping_pong':
          ws.send(JSON.stringify({
            response_type: 'ping_pong',
            timestamp: msg.timestamp,
          }));
          break;

        default:
          // ignored
          break;
      }
    } catch (err) {
      console.error(`[llm-ws] handler error (${msg.interaction_type}):`, err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[llm-ws] connection closed: callId=${callId}`);
    dualLLM.clearSession(callId);
  });

  ws.on('error', (err) => {
    console.error(`[llm-ws] socket error: ${err.message}`);
  });
}

/**
 * Look up the call in Supabase, find the client + prospect, build the system
 * prompt, and load it into the dual-LLM session.
 */
async function bootstrapSession(callId, callDetailsMsg) {
  // Retell sends our call metadata back to us. We set this when initiating the call.
  const meta = callDetailsMsg?.call?.metadata || callDetailsMsg?.metadata || {};
  let { client_id: clientId, prospect_id: prospectId } = meta;

  // Fall back to looking the call up by retell_call_id if metadata isn't there.
  if (!clientId || !prospectId) {
    const { data: callRow } = await supabase
      .from('calls')
      .select('client_id, prospect_id')
      .eq('retell_call_id', callId)
      .maybeSingle();
    if (callRow) {
      clientId = clientId || callRow.client_id;
      prospectId = prospectId || callRow.prospect_id;
    }
  }

  if (!clientId) {
    console.warn(`[llm-ws] could not resolve clientId for call ${callId} — using empty system prompt`);
    dualLLM.setSystemPrompt(callId, 'You are a helpful sales agent.');
    return;
  }

  const systemPrompt = await buildSystemPrompt(clientId, prospectId || null);
  dualLLM.setSystemPrompt(callId, systemPrompt);
  console.log(`[llm-ws] system prompt loaded for call ${callId}: ${systemPrompt.length} chars`);
}

/**
 * Stream a response back to Retell for a given response_id.
 */
async function respondToTurn(ws, callId, msg) {
  const responseId = msg.response_id;
  const transcript = msg.transcript || [];

  const onToken = (token) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      response_type: 'response',
      response_id: responseId,
      content: token,
      content_complete: false,
      end_call: false,
    }));
  };

  try {
    await dualLLM.streamFinalResponse({
      callId,
      transcriptArray: transcript,
      onToken,
    });
  } catch (err) {
    console.error('[llm-ws] streamFinalResponse failed:', err.message);
    onToken("Sorry, can you say that again?");
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      response_type: 'response',
      response_id: responseId,
      content: '',
      content_complete: true,
      end_call: false,
    }));
  }
}

module.exports = { attach };
