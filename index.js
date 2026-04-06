const express = require('express');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { runMigrations } = require('./src/database/migrations');
const supabase = require('./src/database/client');
const { verifyConnection } = require('./src/database/client');
const webhooks = require('./src/webhooks/index');
const { generateAndSaveSoul } = require('./src/soul/generator');
const { createRetellAgent, updateAgentForProspect } = require('./src/agents/retell');
const { createVapiAgent } = require('./src/agents/vapi');
const { deployRecallBot } = require('./src/agents/recall');
const { createTavusReplica, createTavusPersona, createTavusConversation, endTavusConversation, getTavusConversationStatus } = require('./src/agents/tavus');
const { buildSystemPrompt } = require('./src/prompts/builder');
const { RETELL_API_BASE } = require('./config/constants');
const { apiKeyAuth, enforceClientIsolation } = require('./src/middleware/auth');
const multer = require('multer');
const upload = multer({ dest: '/tmp/tavus-uploads/' });
const { WebSocketServer } = require('ws');
const { createAnamPersona } = require('./src/video/anam');
const orchestrator = require('./src/video/orchestrator');
const { listRooms } = require('./src/video/livekit');

// ============================================================
//  ENV VAR CHECK — fail fast if missing critical keys
// ============================================================
function checkRequiredEnvVars(keys) {
  const missing = keys.filter(k => !env[k] && !process.env[k]);
  if (missing.length > 0) {
    console.error('\n===================================');
    console.error('  MISSING ENVIRONMENT VARIABLES');
    console.error('===================================');
    missing.forEach(k => console.error(`  - ${k}`));
    console.error('\nSet these before starting the server.');
    console.error('===================================\n');
    process.exit(1);
  }
}

checkRequiredEnvVars([
  'ANTHROPIC_API_KEY',
  'RETELL_API_KEY',
  'VAPI_API_KEY',
  'ELEVENLABS_API_KEY',
  'RECALL_API_KEY',
  'TAVUS_API_KEY',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]);

// ============================================================
//  GLOBAL ERROR HANDLERS
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  // In production, log but don't exit — let the process manager restart if needed
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// ============================================================
//  EXPRESS APP SETUP
// ============================================================
const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors({
  origin: [
    env.BASE_URL,
    'http://localhost:3000',
    'http://localhost:3001',
  ].filter(Boolean),
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-API-Key'],
}));

// Request logging
if (env.NODE_ENV === 'production') {
  app.use(morgan('combined'));
} else {
  app.use(morgan('dev'));
}

// Rate limiting — general
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Rate limiting — webhooks (higher limit)
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Webhook rate limit exceeded.' },
});

// Apply rate limiting
app.use('/webhooks', webhookLimiter);
app.use(generalLimiter);

// Body parsing
app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Mount webhooks
app.use('/webhooks', webhooks);

// ============================================================
//  HEALTH CHECK — deep service verification
// ============================================================
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: require('./package.json').version,
    uptime: process.uptime(),
    services: {
      supabase: 'error',
      retell: 'error',
      livekit: 'error',
      redis: 'unavailable',
    },
  };

  // Check Supabase
  try {
    const { error } = await supabase.from('clients').select('id').limit(1);
    health.services.supabase = error ? 'error' : 'connected';
  } catch (e) {
    health.services.supabase = 'error';
  }

  // Check Retell
  try {
    const r = await axios.get(`${RETELL_API_BASE}/list-agents`, {
      headers: { 'Authorization': `Bearer ${env.RETELL_API_KEY}` },
      timeout: 5000,
    });
    health.services.retell = r.status === 200 ? 'connected' : 'error';
  } catch (e) {
    health.services.retell = 'error';
  }

  // Check LiveKit
  try {
    const rooms = await listRooms();
    health.services.livekit = Array.isArray(rooms) ? 'connected' : 'error';
  } catch (e) {
    health.services.livekit = 'error';
  }

  // Check Redis (Upstash HTTP REST — optional)
  try {
    const upstash = require('./src/lib/upstash-redis');
    if (upstash.isAvailable()) {
      const pong = await upstash.ping();
      health.services.redis = pong === 'PONG' ? 'connected' : 'unavailable';
    } else {
      health.services.redis = 'not configured';
    }
  } catch (e) {
    health.services.redis = 'unavailable';
  }

  // If Supabase is down, the whole platform is down
  if (health.services.supabase !== 'connected') {
    health.status = 'degraded';
    return res.status(503).json(health);
  }

  res.json(health);
});

// ============================================================
//  DASHBOARD ROUTES — serve HTML pages
// ============================================================
app.get('/dashboard', (req, res) => {
  res.sendFile('dashboard/signup.html', { root: path.join(__dirname, 'public') });
});

app.get('/dashboard/signup', (req, res) => {
  res.sendFile('dashboard/signup.html', { root: path.join(__dirname, 'public') });
});

app.get('/dashboard/:clientId', (req, res) => {
  res.sendFile('dashboard/client.html', { root: path.join(__dirname, 'public') });
});

app.get('/dashboard/:clientId/prospect/:prospectId', (req, res) => {
  res.sendFile('dashboard/prospect.html', { root: path.join(__dirname, 'public') });
});

app.get('/dashboard/:clientId/calls/:callId', (req, res) => {
  res.sendFile('dashboard/call.html', { root: path.join(__dirname, 'public') });
});

// ============================================================
// POST /clients — Full onboarding: soul + agents + save + api_key
// ============================================================
app.post('/clients', async (req, res) => {
  try {
    const clientData = req.body;
    if (!clientData.business_name || !clientData.agent_name) {
      return res.status(400).json({ error: 'business_name and agent_name are required' });
    }

    // Generate API key for multi-tenant auth
    clientData.api_key = crypto.randomUUID();
    clientData.base_url = env.BASE_URL;

    const { data: client, error } = await supabase
      .from('clients')
      .insert(clientData)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    console.log(`[server] Client created: ${client.id} — ${client.business_name}`);

    const soul = await generateAndSaveSoul(client.id);
    console.log(`[server] Soul generated: ${soul.identity?.full_name}`);

    const systemPrompt = await buildSystemPrompt(client.id, null);
    await supabase.from('clients').update({ system_prompt: systemPrompt }).eq('id', client.id);

    let retellResult = null;
    try { retellResult = await createRetellAgent(client.id); }
    catch (err) { console.error('[server] Retell:', err.message); }

    let vapiResult = null;
    try { vapiResult = await createVapiAgent(client.id); }
    catch (err) { console.error('[server] Vapi:', err.message); }

    const { data: finalClient } = await supabase
      .from('clients').select('*').eq('id', client.id).single();

    // Log structured welcome message (onboarding email placeholder)
    console.log('\n========================================');
    console.log('  WELCOME — New Client Onboarded');
    console.log('========================================');
    console.log(`  Agent Name:    ${finalClient.agent_name}`);
    console.log(`  Business:      ${finalClient.business_name}`);
    console.log(`  Client ID:     ${finalClient.id}`);
    console.log(`  API Key:       ${finalClient.api_key}`);
    console.log(`  Webhook URL:   ${env.BASE_URL}/webhooks/retell`);
    console.log(`  Dashboard:     ${env.BASE_URL}/dashboard/${finalClient.id}`);
    console.log(`  Retell Agent:  ${retellResult?.agent_id || 'not configured'}`);
    console.log(`  Vapi Agent:    ${vapiResult?.id || 'not configured'}`);
    console.log('========================================\n');

    res.json({
      client: finalClient,
      soul: soul.identity?.full_name,
      retell_agent_id: retellResult?.agent_id || null,
      vapi_agent_id: vapiResult?.id || null,
    });
  } catch (err) {
    console.error('[server] Client creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /clients/:clientId/calendly — setup Calendly webhook
// ============================================================
app.post('/clients/:clientId/calendly', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { event_type_uri } = req.body;

    if (!event_type_uri) {
      return res.status(400).json({ error: 'event_type_uri is required' });
    }

    // Save event type URI
    await supabase.from('clients').update({
      calendly_event_type_uri: event_type_uri,
    }).eq('id', clientId);

    // Register Calendly webhook subscription
    let webhookId = null;
    if (env.CALENDLY_API_KEY) {
      try {
        // Get organization URI
        const userRes = await axios.get('https://api.calendly.com/users/me', {
          headers: { 'Authorization': `Bearer ${env.CALENDLY_API_KEY}` },
        });
        const orgUri = userRes.data.resource.current_organization;

        const webhookRes = await axios.post('https://api.calendly.com/webhook_subscriptions', {
          url: `${env.BASE_URL}/webhooks/calendly`,
          events: ['invitee.created'],
          organization: orgUri,
          scope: 'organization',
        }, {
          headers: {
            'Authorization': `Bearer ${env.CALENDLY_API_KEY}`,
            'Content-Type': 'application/json',
          },
        });

        webhookId = webhookRes.data.resource?.uri || webhookRes.data.uri;
        console.log(`[server] Calendly webhook registered: ${webhookId}`);
      } catch (err) {
        console.warn('[server] Calendly webhook registration failed:', err.response?.data?.message || err.message);
      }
    }

    if (webhookId) {
      await supabase.from('clients').update({ calendly_webhook_id: webhookId }).eq('id', clientId);
    }

    res.json({
      clientId,
      event_type_uri,
      calendly_webhook_id: webhookId,
      webhook_url: `${env.BASE_URL}/webhooks/calendly`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /clients/:clientId/prompt/:prospectId — Live stitched prompt
// ============================================================
app.get('/clients/:clientId/prompt/:prospectId', async (req, res) => {
  try {
    const { clientId, prospectId } = req.params;
    const prompt = await buildSystemPrompt(clientId, prospectId === 'none' ? null : prospectId);
    res.json({ clientId, prospectId: prospectId === 'none' ? null : prospectId, promptLength: prompt.length, prompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /prospects/:prospectId/memory — Full memory record
// ============================================================
app.get('/prospects/:prospectId/memory', async (req, res) => {
  try {
    const { prospectId } = req.params;
    const { data: prospect, error } = await supabase
      .from('prospects').select('*').eq('id', prospectId).single();
    if (error || !prospect) return res.status(404).json({ error: 'Prospect not found' });

    const { data: calls } = await supabase
      .from('calls')
      .select('id, call_type, duration_seconds, call_summary, key_moments, human_moments, detection_risk_score, status, created_at')
      .eq('prospect_id', prospectId)
      .order('created_at', { ascending: true });

    res.json({ prospect, calls: calls || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /calls/phone/:prospectId — Retell outbound call
// ============================================================
app.post('/calls/phone/:prospectId', async (req, res) => {
  try {
    const { prospectId } = req.params;

    const { data: prospect } = await supabase
      .from('prospects')
      .select('client_id, phone, name')
      .eq('id', prospectId)
      .single();

    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });
    if (!prospect.phone) return res.status(400).json({ error: 'Prospect has no phone number' });

    const { data: client } = await supabase
      .from('clients')
      .select('retell_agent_id')
      .eq('id', prospect.client_id)
      .single();

    if (!client?.retell_agent_id) {
      return res.status(400).json({ error: 'No Retell agent configured for this client' });
    }

    // Update agent with fresh prospect memory
    await updateAgentForProspect(prospect.client_id, prospectId);

    // Initiate outbound call via Retell
    let retellCall = null;
    try {
      const callRes = await axios.post(`${RETELL_API_BASE}/create-phone-call`, {
        agent_id: client.retell_agent_id,
        customer_number: prospect.phone,
      }, {
        headers: {
          'Authorization': `Bearer ${env.RETELL_API_KEY}`,
          'Content-Type': 'application/json',
        },
      });
      retellCall = callRes.data;
    } catch (err) {
      const errMsg = err.response?.data || err.message;
      console.error('[server] Retell call failed:', JSON.stringify(errMsg));
      return res.status(500).json({ error: `Retell call failed: ${JSON.stringify(errMsg)}` });
    }

    // Create call record
    const { data: callRecord } = await supabase
      .from('calls')
      .insert({
        prospect_id: prospectId,
        client_id: prospect.client_id,
        retell_call_id: retellCall.call_id,
        call_type: 'phone',
        status: 'initiated',
      })
      .select()
      .single();

    res.json({
      call: callRecord,
      retell_call_id: retellCall.call_id,
      status: 'initiated',
    });
  } catch (err) {
    console.error('[server] Phone call failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /calls/meet — Deploy Recall bot
// ============================================================
app.post('/calls/meet', async (req, res) => {
  try {
    const { meetUrl, prospectId, clientId } = req.body;
    if (!meetUrl || !prospectId || !clientId) {
      return res.status(400).json({ error: 'meetUrl, prospectId, and clientId are required' });
    }
    const result = await deployRecallBot(meetUrl, prospectId, clientId);
    res.json(result);
  } catch (err) {
    console.error('[server] Meet bot deployment failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SPRINT 6 — HYPER-REAL VIDEO ENDPOINTS
// ============================================================

// POST /clients/:clientId/anam/persona — create Anam CARA-3 persona
app.post('/clients/:clientId/anam/persona', async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await createAnamPersona(clientId);
    res.json(result);
  } catch (err) {
    console.error('[server] Anam persona failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// POST /clients/:clientId/render-mode — set render engine
app.post('/clients/:clientId/render-mode', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { render_mode } = req.body;
    const validModes = ['phoenix_4', 'anam_cara3'];
    if (!validModes.includes(render_mode)) {
      return res.status(400).json({ error: `Invalid render_mode. Must be one of: ${validModes.join(', ')}` });
    }
    const { data: client, error } = await supabase
      .from('clients')
      .update({ render_mode })
      .eq('id', clientId)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    console.log(`[server] Client ${clientId} render mode set to: ${render_mode}`);
    res.json({ clientId, render_mode: client.render_mode, client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /calls/hyper-real/:prospectId — start hyper-real video session
app.post('/calls/hyper-real/:prospectId', async (req, res) => {
  try {
    const { prospectId } = req.params;
    const { meetUrl } = req.body || {};

    const { data: prospect } = await supabase
      .from('prospects')
      .select('client_id')
      .eq('id', prospectId)
      .single();
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

    const { data: client } = await supabase
      .from('clients')
      .select('render_mode, tavus_replica_id, tavus_persona_id')
      .eq('id', prospect.client_id)
      .single();

    const renderMode = client?.render_mode || 'phoenix_4';
    const session = await orchestrator.startVideoSession(prospect.client_id, prospectId, meetUrl, renderMode);
    res.json({
      sessionId: session.sessionId,
      liveKitCompositeUrl: session.liveKitCompositeUrl,
      videoStreamUrl: session.videoStreamUrl,
      renderMode: session.renderMode,
      room_name: session.room_name,
    });
  } catch (err) {
    console.error('[server] Hyper-real session failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /sessions/:sessionId/status — session status
app.get('/sessions/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = orchestrator.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId: session.sessionId,
    renderMode: session.renderMode,
    ravenActive: session.ravenActive,
    status: session.status,
    elapsed: Date.now() - session.startTime,
    room_name: session.room_name,
    videoStreamUrl: session.videoStreamUrl,
  });
});

// POST /webhooks/livekit — LiveKit room events
app.post('/webhooks/livekit', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const event = req.body;
    const eventType = event.event || '';
    console.log(`[webhook:livekit] Event: ${eventType}`);

    if (eventType === 'participant_joined' && event.sessionId) {
      await orchestrator.handleProspectJoined(event.sessionId, event.videoTrack);
    } else if (eventType === 'room_finished' && event.sessionId) {
      await orchestrator.endVideoSession(event.sessionId);
    }
  } catch (err) {
    console.error('[webhook:livekit] Error:', err.message);
  }
});

// ============================================================
//  SPRINT 5 — TAVUS VIDEO ENDPOINTS
// ============================================================

// POST /clients/:clientId/tavus/replica — upload training video
app.post('/clients/:clientId/tavus/replica', upload.single('video'), async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded. Use multipart form with field name "video".' });
    }
    const result = await createTavusReplica(clientId, req.file.path);
    res.json(result);
  } catch (err) {
    console.error('[server] Tavus replica failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// POST /clients/:clientId/tavus/persona — create Tavus persona
app.post('/clients/:clientId/tavus/persona', async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await createTavusPersona(clientId);
    res.json(result);
  } catch (err) {
    console.error('[server] Tavus persona failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// POST /clients/:clientId/video-mode — set video mode
app.post('/clients/:clientId/video-mode', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { video_mode } = req.body;

    const validModes = ['voice_only', 'video_avatar', 'video_recall', 'video_recall_v2'];
    if (!validModes.includes(video_mode)) {
      return res.status(400).json({ error: `Invalid video_mode. Must be one of: ${validModes.join(', ')}` });
    }

    const { data: client, error } = await supabase
      .from('clients')
      .update({ video_mode })
      .eq('id', clientId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    console.log(`[server] Client ${clientId} video mode set to: ${video_mode}`);
    res.json({ clientId, video_mode: client.video_mode, client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /calls/video/:prospectId — create Tavus video conversation
app.post('/calls/video/:prospectId', async (req, res) => {
  try {
    const { prospectId } = req.params;

    const { data: prospect } = await supabase
      .from('prospects')
      .select('client_id, name')
      .eq('id', prospectId)
      .single();

    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

    const { data: client } = await supabase
      .from('clients')
      .select('tavus_replica_id, tavus_persona_id, video_mode')
      .eq('id', prospect.client_id)
      .single();

    if (!client?.tavus_replica_id || !client?.tavus_persona_id) {
      return res.status(400).json({ error: 'Tavus not configured for this client. Create a replica and persona first.' });
    }

    const result = await createTavusConversation(prospect.client_id, prospectId);
    res.json({
      conversation_id: result.conversation_id,
      conversation_url: result.conversation_url,
      call: result.call,
    });
  } catch (err) {
    console.error('[server] Tavus video call failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// GET /calls/:callId/video-status — poll Tavus conversation status
app.get('/calls/:callId/video-status', async (req, res) => {
  try {
    const { callId } = req.params;

    const { data: call, error } = await supabase
      .from('calls')
      .select('conversation_id, status')
      .eq('id', callId)
      .single();

    if (error || !call) return res.status(404).json({ error: 'Call not found' });
    if (!call.conversation_id) return res.status(400).json({ error: 'Not a video call' });

    const convo = await getTavusConversationStatus(call.conversation_id);

    res.json({
      status: convo.status || call.status,
      duration: convo.conversation_length || convo.duration || null,
      transcript_ready: !!(convo.transcript),
      conversation: convo,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ============================================================
//  NEW SPRINT 4 API ENDPOINTS — /api/ prefix
//  Dashboard pages call these; authenticated routes use apiKeyAuth
// ============================================================

// GET /api/clients/:clientId/info — client basic info (for dashboard)
app.get('/api/clients/:clientId/info', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId/stats — aggregate stats
app.get('/api/clients/:clientId/stats', async (req, res) => {
  try {
    const { clientId } = req.params;

    // Total calls
    const { count: totalCalls, error: callsErr } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId);

    if (callsErr) {
      console.error('[stats] calls count error:', callsErr.message);
    }

    // Closed deals (prospects with funnel_stage = 'closed_won')
    const { count: closedDeals, error: dealsErr } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('funnel_stage', 'closed_won');

    if (dealsErr) {
      console.error('[stats] closed deals error:', dealsErr.message);
    }

    // Average detection risk score
    const { data: riskData, error: riskErr } = await supabase
      .from('calls')
      .select('detection_risk_score')
      .eq('client_id', clientId)
      .not('detection_risk_score', 'is', null);

    let avgDetectionRisk = null;
    if (!riskErr && riskData && riskData.length > 0) {
      const sum = riskData.reduce((acc, r) => acc + (r.detection_risk_score || 0), 0);
      avgDetectionRisk = (sum / riskData.length).toFixed(1);
    }

    // Total pipeline value (sum of closed_value from prospects)
    const { data: pipelineData, error: pipelineErr } = await supabase
      .from('prospects')
      .select('closed_value')
      .eq('client_id', clientId)
      .not('closed_value', 'is', null);

    let totalPipelineValue = 0;
    if (!pipelineErr && pipelineData) {
      totalPipelineValue = pipelineData.reduce((acc, p) => acc + (parseFloat(p.closed_value) || 0), 0);
    }

    res.json({
      total_calls: totalCalls || 0,
      closed_deals: closedDeals || 0,
      avg_detection_risk: avgDetectionRisk,
      total_pipeline_value: totalPipelineValue,
    });
  } catch (err) {
    console.error('[stats] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId/calls — paginated call history
app.get('/api/clients/:clientId/calls', async (req, res) => {
  try {
    const { clientId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    // Get total count
    const { count: total } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId);

    // Get paginated calls with prospect name
    const { data: calls, error } = await supabase
      .from('calls')
      .select(`
        id,
        prospect_id,
        call_type,
        duration_seconds,
        outcome,
        detection_risk_score,
        call_summary,
        status,
        created_at,
        prospects!inner(name)
      `)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      // If inner join fails (calls without prospects), retry with left join
      const { data: callsFallback, error: fallbackErr } = await supabase
        .from('calls')
        .select(`
          id,
          prospect_id,
          call_type,
          duration_seconds,
          outcome,
          detection_risk_score,
          call_summary,
          status,
          created_at
        `)
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (fallbackErr) {
        return res.status(500).json({ error: fallbackErr.message });
      }

      // Manually fetch prospect names
      const prospectIds = [...new Set((callsFallback || []).filter(c => c.prospect_id).map(c => c.prospect_id))];
      let prospectMap = {};
      if (prospectIds.length > 0) {
        const { data: prospects } = await supabase
          .from('prospects')
          .select('id, name')
          .in('id', prospectIds);
        if (prospects) {
          prospects.forEach(p => { prospectMap[p.id] = p.name; });
        }
      }

      const formatted = (callsFallback || []).map(c => ({
        ...c,
        prospect_name: prospectMap[c.prospect_id] || null,
      }));

      return res.json({ calls: formatted, total: total || 0, page, limit });
    }

    // Format response — extract prospect name from join
    const formatted = (calls || []).map(c => {
      const { prospects: prospectData, ...callFields } = c;
      return {
        ...callFields,
        prospect_name: prospectData?.name || null,
      };
    });

    res.json({ calls: formatted, total: total || 0, page, limit });
  } catch (err) {
    console.error('[calls] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId/prospects — all prospects
app.get('/api/clients/:clientId/prospects', async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: prospects, error } = await supabase
      .from('prospects')
      .select('*')
      .eq('client_id', clientId)
      .order('last_contact', { ascending: false, nullsFirst: false });

    if (error) return res.status(500).json({ error: error.message });

    res.json(prospects || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/:callId/full — full call detail
app.get('/api/calls/:callId/full', async (req, res) => {
  try {
    const { callId } = req.params;

    const { data: call, error } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .single();

    if (error || !call) return res.status(404).json({ error: 'Call not found' });

    // Verify the call belongs to the requesting client if X-API-Key is provided
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const { data: client } = await supabase
        .from('clients')
        .select('id')
        .eq('api_key', apiKey)
        .single();

      if (client && call.client_id !== client.id) {
        return res.status(403).json({ error: 'Access denied: call does not belong to this client' });
      }
    }

    // Get prospect name
    let prospectName = null;
    if (call.prospect_id) {
      const { data: prospect } = await supabase
        .from('prospects')
        .select('name')
        .eq('id', call.prospect_id)
        .single();
      prospectName = prospect?.name || null;
    }

    res.json({
      call: {
        ...call,
        prospect_name: prospectName,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId/prompt/preview — agent prompt preview (null prospect)
app.get('/api/clients/:clientId/prompt/preview', async (req, res) => {
  try {
    const { clientId } = req.params;
    const prompt = await buildSystemPrompt(clientId, null);
    res.json({
      clientId,
      prospectId: null,
      promptLength: prompt.length,
      prompt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/test — test call (creates records without calling Retell)
app.post('/api/calls/test', async (req, res) => {
  try {
    const { clientId, phoneNumber } = req.body;

    if (!clientId || !phoneNumber) {
      return res.status(400).json({ error: 'clientId and phoneNumber are required' });
    }

    // Verify client exists
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select('id, agent_name, business_name')
      .eq('id', clientId)
      .single();

    if (clientErr || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Check if test prospect already exists for this phone + client
    let prospect = null;
    const { data: existing } = await supabase
      .from('prospects')
      .select('*')
      .eq('client_id', clientId)
      .eq('phone', phoneNumber)
      .single();

    if (existing) {
      prospect = existing;
    } else {
      // Create test prospect
      const { data: newProspect, error: prospectErr } = await supabase
        .from('prospects')
        .insert({
          client_id: clientId,
          name: 'Test Prospect',
          phone: phoneNumber,
          funnel_stage: 'lead',
        })
        .select()
        .single();

      if (prospectErr) {
        return res.status(500).json({ error: 'Failed to create test prospect: ' + prospectErr.message });
      }
      prospect = newProspect;
    }

    // Create test call record (no actual Retell call)
    const { data: callRecord, error: callErr } = await supabase
      .from('calls')
      .insert({
        prospect_id: prospect.id,
        client_id: clientId,
        call_type: 'phone',
        status: 'test',
        call_summary: 'Test call initiated from dashboard',
      })
      .select()
      .single();

    if (callErr) {
      return res.status(500).json({ error: 'Failed to create test call: ' + callErr.message });
    }

    console.log(`[test-call] Test call created for client ${clientId}, prospect ${prospect.id}`);

    res.json({
      prospect,
      call: callRecord,
      message: 'Test call created (no actual phone call placed)',
    });
  } catch (err) {
    console.error('[test-call] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospects/:prospectId/memory — proxy for dashboard (same as existing)
app.get('/api/prospects/:prospectId/memory', async (req, res) => {
  try {
    const { prospectId } = req.params;
    const { data: prospect, error } = await supabase
      .from('prospects').select('*').eq('id', prospectId).single();
    if (error || !prospect) return res.status(404).json({ error: 'Prospect not found' });

    const { data: calls } = await supabase
      .from('calls')
      .select('id, call_type, duration_seconds, call_summary, key_moments, human_moments, detection_risk_score, status, created_at')
      .eq('prospect_id', prospectId)
      .order('created_at', { ascending: true });

    res.json({ prospect, calls: calls || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  AUTHENTICATED API ENDPOINTS (require X-API-Key)
//  These mirror the above but enforce multi-tenant isolation
// ============================================================
app.get('/api/secure/clients/:clientId/stats', apiKeyAuth, enforceClientIsolation, async (req, res) => {
  try {
    const { clientId } = req.params;

    const { count: totalCalls } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId);

    const { count: closedDeals } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('funnel_stage', 'closed_won');

    const { data: riskData } = await supabase
      .from('calls')
      .select('detection_risk_score')
      .eq('client_id', clientId)
      .not('detection_risk_score', 'is', null);

    let avgDetectionRisk = null;
    if (riskData && riskData.length > 0) {
      const sum = riskData.reduce((acc, r) => acc + (r.detection_risk_score || 0), 0);
      avgDetectionRisk = (sum / riskData.length).toFixed(1);
    }

    const { data: pipelineData } = await supabase
      .from('prospects')
      .select('closed_value')
      .eq('client_id', clientId)
      .not('closed_value', 'is', null);

    let totalPipelineValue = 0;
    if (pipelineData) {
      totalPipelineValue = pipelineData.reduce((acc, p) => acc + (parseFloat(p.closed_value) || 0), 0);
    }

    res.json({
      total_calls: totalCalls || 0,
      closed_deals: closedDeals || 0,
      avg_detection_risk: avgDetectionRisk,
      total_pipeline_value: totalPipelineValue,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/secure/clients/:clientId/calls', apiKeyAuth, enforceClientIsolation, async (req, res) => {
  try {
    const { clientId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const { count: total } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId);

    const { data: calls, error } = await supabase
      .from('calls')
      .select('id, prospect_id, call_type, duration_seconds, outcome, detection_risk_score, call_summary, status, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });

    // Fetch prospect names
    const prospectIds = [...new Set((calls || []).filter(c => c.prospect_id).map(c => c.prospect_id))];
    let prospectMap = {};
    if (prospectIds.length > 0) {
      const { data: prospects } = await supabase
        .from('prospects')
        .select('id, name')
        .in('id', prospectIds);
      if (prospects) {
        prospects.forEach(p => { prospectMap[p.id] = p.name; });
      }
    }

    const formatted = (calls || []).map(c => ({
      ...c,
      prospect_name: prospectMap[c.prospect_id] || null,
    }));

    res.json({ calls: formatted, total: total || 0, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/secure/clients/:clientId/prospects', apiKeyAuth, enforceClientIsolation, async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: prospects, error } = await supabase
      .from('prospects')
      .select('*')
      .eq('client_id', clientId)
      .order('last_contact', { ascending: false, nullsFirst: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(prospects || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/secure/calls/:callId/full', apiKeyAuth, async (req, res) => {
  try {
    const { callId } = req.params;

    const { data: call, error } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .single();

    if (error || !call) return res.status(404).json({ error: 'Call not found' });

    // Enforce tenant isolation
    if (call.client_id !== req.client.id) {
      return res.status(403).json({ error: 'Access denied: call does not belong to this client' });
    }

    let prospectName = null;
    if (call.prospect_id) {
      const { data: prospect } = await supabase
        .from('prospects')
        .select('name')
        .eq('id', call.prospect_id)
        .single();
      prospectName = prospect?.name || null;
    }

    res.json({
      call: {
        ...call,
        prospect_name: prospectName,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GLOBAL ERROR HANDLER — must be last middleware
// ============================================================
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
//  START SERVER
// ============================================================
async function start() {
  console.log('\n========================================');
  console.log('  AI CLOSER PLATFORM — Starting...');
  console.log('========================================\n');

  // Verify database connection
  await verifyConnection();

  // Run migrations
  await runMigrations();

  const server = app.listen(env.PORT, () => {
    console.log('\n===================================');
    console.log('  AI Closer Platform — LIVE');
    console.log('===================================');
    console.log(`  Server:    http://localhost:${env.PORT}`);
    console.log(`  Env:       ${env.NODE_ENV}`);
    console.log(`  Supabase:  connected`);
    console.log(`  Retell:    connected`);
    console.log(`  Vapi:      connected`);
    console.log(`  Tavus:     connected`);
    console.log(`  LiveKit:   connected`);
    console.log(`  Webhooks:  /webhooks/*`);
    console.log(`  Dashboard: /dashboard`);
    console.log('===================================\n');

    console.log(`[server] Endpoints:`);
    console.log(`  POST   /clients`);
    console.log(`  POST   /clients/:id/calendly`);
    console.log(`  GET    /clients/:id/prompt/:prospectId`);
    console.log(`  GET    /prospects/:id/memory`);
    console.log(`  POST   /calls/phone/:prospectId`);
    console.log(`  POST   /calls/meet`);
    console.log(`[server] Sprint 6 Hyper-Real:`);
    console.log(`  POST   /clients/:id/anam/persona`);
    console.log(`  POST   /clients/:id/render-mode`);
    console.log(`  POST   /calls/hyper-real/:prospectId`);
    console.log(`  GET    /sessions/:id/status`);
    console.log(`  POST   /webhooks/livekit`);
    console.log(`  WS     /ws/video/:sessionId`);
    console.log(`[server] Sprint 5 Tavus:`);
    console.log(`  POST   /clients/:id/tavus/replica`);
    console.log(`  POST   /clients/:id/tavus/persona`);
    console.log(`  POST   /clients/:id/video-mode`);
    console.log(`  POST   /calls/video/:prospectId`);
    console.log(`  GET    /calls/:id/video-status`);
    console.log(`[server] Sprint 4 API:`);
    console.log(`  GET    /api/clients/:id/stats`);
    console.log(`  GET    /api/clients/:id/calls`);
    console.log(`  GET    /api/clients/:id/prospects`);
    console.log(`  GET    /api/clients/:id/info`);
    console.log(`  GET    /api/clients/:id/prompt/preview`);
    console.log(`  GET    /api/calls/:id/full`);
    console.log(`  POST   /api/calls/test`);
    console.log(`[server] Dashboard:`);
    console.log(`  GET    /dashboard`);
    console.log(`  GET    /dashboard/signup`);
    console.log(`  GET    /dashboard/:clientId`);
    console.log(`  GET    /dashboard/:clientId/prospect/:prospectId`);
    console.log(`  GET    /dashboard/:clientId/calls/:callId\n`);
  });

  // WebSocket server for live video session monitoring
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (request.url && request.url.startsWith('/ws/video')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });
  wss.on('connection', (ws, req) => {
    const urlParts = (req.url || '').split('/');
    const sessionId = urlParts[urlParts.length - 1] || '';

    const session = orchestrator.getSession(sessionId);

    // Send initial status
    ws.send(JSON.stringify({
      type: 'session_status',
      data: session || { sessionId, status: 'not_found' },
    }));

    // Heartbeat every 5 seconds
    const heartbeat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(heartbeat);
        return;
      }
      const s = orchestrator.getSession(sessionId);
      ws.send(JSON.stringify({
        type: 'heartbeat',
        data: {
          ravenActive: s?.ravenActive || false,
          renderMode: s?.renderMode || 'unknown',
          status: s?.status || 'inactive',
          elapsed: s ? Date.now() - s.startTime : 0,
        },
      }));
    }, 5000);

    ws.on('close', () => clearInterval(heartbeat));
  });

  console.log('[server] WebSocket server ready at /ws/video');
}

start().catch(err => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});

module.exports = app;
