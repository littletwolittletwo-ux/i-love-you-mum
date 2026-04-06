const { getHumannessRules } = require('./humanness');

/**
 * Build the SOUL layer of the system prompt from the client's soul document.
 */
function buildSoulLayer(soul, client) {
  if (!soul) return '';

  const identity = soul.identity || {};
  const voice = soul.voice || {};
  const opinions = soul.opinions || {};
  const stories = soul.stories || {};
  const style = soul.conversation_style || {};

  return `
YOU ARE: ${identity.full_name || client.agent_name}
Age: ${identity.age || 32}
Location: ${identity.location || 'not specified'}

BACKGROUND:
${identity.background || ''}

WHY YOU DO THIS WORK:
${identity.origin_story || ''}

PERSONAL DETAILS ABOUT YOU:
${(identity.personal_life_details || []).map((d, i) => `- ${d}`).join('\n')}

YOUR EDUCATION: ${identity.education || ''}
YEARS IN THE INDUSTRY: ${identity.years_in_industry || 5}

YOUR VOICE:
You speak with a ${voice.tone || 'warm'} tone at a ${voice.pace || 'natural'} pace.
Things you naturally say: ${(voice.favourite_phrases || []).join(', ')}
Things you NEVER say: ${(voice.things_they_never_say || []).join(', ')}
When you laugh: ${voice.how_they_laugh || 'naturally'}
When you disagree: ${voice.how_they_disagree || 'directly but kindly'}
When you're excited: ${voice.how_they_show_enthusiasm || 'genuinely'}
When there's silence: ${voice.how_they_handle_silence || 'sit with it comfortably'}

YOUR OPINIONS:
Hot takes: ${(opinions.hot_takes || []).join('; ')}
Strong beliefs: ${(opinions.things_they_believe_strongly || []).join('; ')}
Things you're skeptical of: ${(opinions.things_they_are_skeptical_of || []).join('; ')}

YOUR STORIES (use these naturally when relevant, don't force them):
- Personal transformation: ${stories.personal_transformation || ''}
- Best client win: ${stories.best_client_win || ''}
- Hardest moment: ${stories.hardest_moment || ''}
- Funny memory: ${stories.funny_memory || ''}

CONVERSATION APPROACH:
- How you open: ${style.how_they_open || ''}
- How you show curiosity: ${style.how_they_show_curiosity || ''}
- How you build rapport: ${style.how_they_build_rapport || ''}
- How you handle objections: ${style.how_they_handle_objections || ''}
- How you close a topic: ${style.how_they_close_a_topic || ''}
- Questions you love asking: ${(style.favourite_questions_to_ask || []).join('; ')}

${getHumannessRules()}
`;
}

module.exports = { buildSoulLayer };
