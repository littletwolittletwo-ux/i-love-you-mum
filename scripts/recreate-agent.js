require('dotenv').config();
const { createRetellAgent } = require('../src/agents/retell');

(async () => {
  const SARAH_ID = '9d3cd726-c57b-470d-9b18-24361a119496';
  const result = await createRetellAgent(SARAH_ID);
  console.log('Created:', result);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
