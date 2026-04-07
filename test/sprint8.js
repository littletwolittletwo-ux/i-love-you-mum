/**
 * Sprint 8 — Team Dashboard, Call Me Now, and Phone Call Tests
 * Real integration tests against running server.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, name) {
  total++;
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  }
}

async function fetchJSON(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  return { res, status: res.status, data: await res.json().catch(() => null), text: '' };
}

async function fetchText(path) {
  const res = await fetch(`${BASE}${path}`);
  return { res, status: res.status, text: await res.text() };
}

async function run() {
  console.log('\n\x1b[35m========================================\x1b[0m');
  console.log('\x1b[35m  Sprint 8 — Team Dashboard & Calls\x1b[0m');
  console.log('\x1b[35m========================================\x1b[0m\n');

  // -------- TEAM DASHBOARD --------
  console.log('\x1b[36m--- Team Dashboard ---\x1b[0m');

  // 1. GET /dashboard returns 200
  const dash = await fetchText('/dashboard');
  assert(dash.status === 200, 'GET /dashboard returns 200');

  // 2. Dashboard contains sidebar nav
  assert(dash.text.includes('sidebar-nav'), 'GET /dashboard contains sidebar nav HTML');

  // 3. Dashboard contains "Call Me Now" button
  assert(dash.text.includes('Call Me Now'), 'GET /dashboard contains "Call Me Now" button');

  // 4. Dashboard contains agents grid
  assert(dash.text.includes('agents-grid') || dash.text.includes('agentsGrid'), 'GET /dashboard contains agents grid');

  // 5. Dashboard contains health indicator
  assert(dash.text.includes('healthDot') || dash.text.includes('health-dot'), 'GET /dashboard contains health indicator');

  // 6. Dashboard contains overview stats
  assert(dash.text.includes('statAgents') || dash.text.includes('Total Agents'), 'GET /dashboard contains overview stats');

  // 7. Dashboard contains recent calls table
  assert(dash.text.includes('recentCallsBody') || dash.text.includes('Recent Calls'), 'GET /dashboard contains recent calls section');

  // 8. Dashboard contains client switch dropdown
  assert(dash.text.includes('clientSwitch') || dash.text.includes('Switch Client'), 'GET /dashboard contains client switch dropdown');

  // -------- TEAM API --------
  console.log('\n\x1b[36m--- Team API ---\x1b[0m');

  // 9. GET /api/team/stats
  const teamStats = await fetchJSON('/api/team/stats');
  assert(teamStats.status === 200, 'GET /api/team/stats returns 200');
  assert(teamStats.data && 'total_agents' in teamStats.data, 'Team stats has total_agents');
  assert(teamStats.data && 'total_calls' in teamStats.data, 'Team stats has total_calls');
  assert(teamStats.data && 'total_prospects' in teamStats.data, 'Team stats has total_prospects');

  // 10. GET /api/team/clients
  const teamClients = await fetchJSON('/api/team/clients');
  assert(teamClients.status === 200, 'GET /api/team/clients returns 200');
  assert(Array.isArray(teamClients.data), 'Team clients returns array');

  // 11. GET /api/team/calls
  const teamCalls = await fetchJSON('/api/team/calls');
  assert(teamCalls.status === 200, 'GET /api/team/calls returns 200');
  assert(Array.isArray(teamCalls.data), 'Team calls returns array');

  // 12. GET /api/team/prospects
  const teamProspects = await fetchJSON('/api/team/prospects');
  assert(teamProspects.status === 200, 'GET /api/team/prospects returns 200');
  assert(Array.isArray(teamProspects.data), 'Team prospects returns array');

  // -------- CALLS/QUICK --------
  console.log('\n\x1b[36m--- Quick Call ---\x1b[0m');

  // 13. POST /calls/quick with missing fields returns 400
  const quickMissing = await fetchJSON('/calls/quick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(quickMissing.status === 400, 'POST /calls/quick with missing fields returns 400');

  // 14. POST /calls/quick with test phone — returns either call or clear error about RETELL_PHONE_NUMBER
  let testClientId = null;
  if (teamClients.data && teamClients.data.length > 0) {
    testClientId = teamClients.data[0].id;
  }

  if (testClientId) {
    const quickCall = await fetchJSON('/calls/quick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: testClientId,
        phone_number: '+10000000000',
        prospect_name: 'Sprint8 Test',
      }),
    });

    const isCallOrConfigError = (
      quickCall.status === 200 ||
      (quickCall.status === 400 && quickCall.data && (quickCall.data.setup_required || quickCall.data.error.includes('RETELL_PHONE_NUMBER'))) ||
      (quickCall.status === 500 && quickCall.data && (quickCall.data.error.includes('RETELL_PHONE_NUMBER') || quickCall.data.error.includes('Retell')))
    );
    assert(isCallOrConfigError, 'POST /calls/quick returns call or clear RETELL_PHONE_NUMBER error');
  } else {
    console.log('  \x1b[33m⚠\x1b[0m Skipping quick call test (no clients)');
  }

  // -------- CALL STATUS --------
  console.log('\n\x1b[36m--- Call Status ---\x1b[0m');

  // 15. GET /calls/:callId/status with invalid ID returns 404
  const statusInvalid = await fetchJSON('/calls/00000000-0000-0000-0000-000000000000/status');
  assert(statusInvalid.status === 404, 'GET /calls/:callId/status with invalid ID returns 404');

  // 16. Check status endpoint shape if we have real calls
  if (teamCalls.data && teamCalls.data.length > 0) {
    const realCallId = teamCalls.data[0].id;
    const callStatus = await fetchJSON(`/calls/${realCallId}/status`);
    assert(callStatus.status === 200, 'GET /calls/:callId/status returns 200 for real call');
    assert(callStatus.data && 'call_id' in callStatus.data, 'Call status has call_id');
    assert(callStatus.data && 'status' in callStatus.data, 'Call status has status');
    assert(callStatus.data && 'transcript_ready' in callStatus.data, 'Call status has transcript_ready');
  } else {
    console.log('  \x1b[33m⚠\x1b[0m Skipping call status shape test (no calls)');
  }

  // -------- CLIENT DASHBOARD --------
  console.log('\n\x1b[36m--- Client Dashboard ---\x1b[0m');

  if (testClientId) {
    const clientDash = await fetchText(`/dashboard/${testClientId}`);
    assert(clientDash.status === 200, 'GET /dashboard/:clientId returns 200');
    assert(clientDash.text.includes('Call Me Now') || clientDash.text.includes('Call Now') || clientDash.text.includes('Test Call'), 'Client dashboard contains call button');
    assert(clientDash.text.includes('Back to Team Dashboard'), 'Client dashboard contains "Back to Team Dashboard" link');
  } else {
    console.log('  \x1b[33m⚠\x1b[0m Skipping client dashboard tests (no clients)');
  }

  // -------- SIGNUP ROUTE --------
  console.log('\n\x1b[36m--- Navigation ---\x1b[0m');

  const signupPage = await fetchText('/dashboard/signup');
  assert(signupPage.status === 200, 'GET /dashboard/signup returns 200');

  // -------- HEALTH --------
  console.log('\n\x1b[36m--- Health ---\x1b[0m');

  const health = await fetchJSON('/health');
  assert(health.status === 200, 'GET /health returns 200');
  assert(health.data && health.data.status === 'ok', 'Health status is ok');

  // -------- RESULTS --------
  console.log('\n\x1b[35m========================================\x1b[0m');
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  console.log('\x1b[35m========================================\x1b[0m\n');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('\n\x1b[31mTest runner crashed:\x1b[0m', err.message);
  process.exit(1);
});
