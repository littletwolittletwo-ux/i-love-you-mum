const fs = require('fs');
const path = require('path');
const supabase = require('../database/client');
const { buildSystemPrompt } = require('../prompts/builder');
const axios = require('axios');
const env = require('../../config/env');
const { RETELL_API_BASE } = require('../../config/constants');

const PROCESSED_DIR = path.join(__dirname, 'processed');
const PATTERNS_DIR = path.join(__dirname, 'patterns');

/**
 * Load training data — from cache if available, disk otherwise.
 */
function loadTrainingData() {
  if (global.trainingCache) return global.trainingCache;

  const data = {};
  try {
    data.phraseLibrary = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, 'phrase_library.json'), 'utf8'));
  } catch { data.phraseLibrary = null; }
  try {
    data.patterns = JSON.parse(fs.readFileSync(path.join(PATTERNS_DIR, 'extracted_patterns.json'), 'utf8'));
  } catch { data.patterns = null; }
  try {
    data.lengthStats = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, 'length_stats.json'), 'utf8'));
  } catch { data.lengthStats = null; }
  try {
    data.ausSlang = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, 'australian_patterns.json'), 'utf8'));
  } catch { data.ausSlang = null; }

  return data;
}

/**
 * Enhance a base system prompt with training data insights.
 */
async function buildTrainingEnhancedPrompt(basePrompt) {
  const data = loadTrainingData();

  const sections = [basePrompt];

  if (data.lengthStats || data.phraseLibrary || data.patterns) {
    sections.push('\nNATURAL HUMAN SPEECH PATTERNS (extracted from real conversations):');
  }

  if (data.lengthStats) {
    sections.push(`\nAverage human response: ${data.lengthStats.avg_words} words`);
    if (data.lengthStats.distribution) {
      sections.push(`Response length distribution: ${Object.entries(data.lengthStats.distribution).map(([k, v]) => `${k} words: ${v}`).join(', ')}`);
    }
  }

  if (data.phraseLibrary) {
    const pl = data.phraseLibrary;
    if (pl.openers?.length) {
      sections.push(`\nNatural openers people actually use:\n${pl.openers.slice(0, 10).map(o => `- "${o}"`).join('\n')}`);
    }
    if (pl.agreements?.length) {
      sections.push(`\nNatural agreements:\n${pl.agreements.slice(0, 10).map(o => `- "${o}"`).join('\n')}`);
    }
    if (pl.questions?.length) {
      sections.push(`\nNatural questions:\n${pl.questions.slice(0, 10).map(o => `- "${o}"`).join('\n')}`);
    }
    if (pl.transitions?.length) {
      sections.push(`\nNatural transitions:\n${pl.transitions.slice(0, 10).map(o => `- "${o}"`).join('\n')}`);
    }
    if (pl.closers?.length) {
      sections.push(`\nNatural closers:\n${pl.closers.slice(0, 6).map(o => `- "${o}"`).join('\n')}`);
    }
  }

  if (data.patterns?.example_exchanges?.length) {
    sections.push('\nEXAMPLE NATURAL EXCHANGES (study these rhythms):');
    const exchanges = data.patterns.example_exchanges.slice(0, 5);
    for (const ex of exchanges) {
      if (ex.a && ex.b) {
        sections.push(`  Prospect: "${ex.a}"\n  Sarah: "${ex.b}"`);
      }
    }
  }

  if (data.ausSlang) {
    const aus = data.ausSlang;
    if (aus.filler?.length) {
      sections.push(`\nAustralian filler words to use naturally: ${aus.filler.join(', ')}`);
    }
  }

  return sections.join('\n');
}

/**
 * Build enhanced prompt for Sarah and push to her Retell LLM.
 */
async function updateSarahWithEnhancements() {
  const SARAH_CLIENT_ID = '9d3cd726-c57b-470d-9b18-24361a119496';
  const SARAH_AGENT_ID = 'agent_a65b3f0e09eddb372e7c7a9426';

  console.log('[inject] Building enhanced prompt for Sarah...');

  // Build base prompt
  const basePrompt = await buildSystemPrompt(SARAH_CLIENT_ID, null);

  // Enhance with training data
  const enhancedPrompt = await buildTrainingEnhancedPrompt(basePrompt);

  console.log(`[inject] Base prompt: ${basePrompt.length} chars`);
  console.log(`[inject] Enhanced prompt: ${enhancedPrompt.length} chars (+${enhancedPrompt.length - basePrompt.length} chars of training data)`);
  console.log(`[inject] Word count: ${enhancedPrompt.split(/\s+/).length}`);

  // Get LLM ID from agent
  const retellHeaders = {
    'Authorization': `Bearer ${env.RETELL_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const agentsRes = await axios.get(`${RETELL_API_BASE}/list-agents`, { headers: retellHeaders });
  const sarah = agentsRes.data.find(a => a.agent_id === SARAH_AGENT_ID);
  if (!sarah) throw new Error('Sarah agent not found on Retell');

  const llmId = sarah.response_engine?.llm_id;
  if (!llmId) throw new Error('No LLM ID on Sarah agent');

  console.log(`[inject] Patching Retell LLM ${llmId}...`);

  await axios.patch(`${RETELL_API_BASE}/update-retell-llm/${llmId}`, {
    general_prompt: enhancedPrompt,
  }, { headers: retellHeaders });

  console.log('[inject] Sarah updated successfully.');
  console.log(`[inject] First 500 chars:\n${enhancedPrompt.slice(0, 500)}...`);

  return { promptLength: enhancedPrompt.length, wordCount: enhancedPrompt.split(/\s+/).length };
}

module.exports = { buildTrainingEnhancedPrompt, updateSarahWithEnhancements, loadTrainingData };
