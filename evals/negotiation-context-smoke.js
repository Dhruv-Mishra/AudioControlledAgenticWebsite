'use strict';

const assert = require('assert');

const { STATIC_TOOL_DECLARATIONS, SYSTEM_PROMPT_SKELETON } = require('../api/tools');

function findTool(name) {
  return STATIC_TOOL_DECLARATIONS.find((tool) => tool && tool.name === name);
}

const submitQuote = findTool('submit_quote');
assert(submitQuote, 'submit_quote declaration should exist');
assert(
  /no multiple-of-25 rule/i.test(submitQuote.description),
  'submit_quote description should explicitly remove the multiple-of-25 rule'
);
assert(
  /no fixed percent band/i.test(submitQuote.description),
  'submit_quote description should explicitly remove the fixed percent band'
);

const contextTool = findTool('get_negotiation_context');
assert(contextTool, 'get_negotiation_context declaration should exist');
assert(
  /public negotiator profile/i.test(contextTool.description),
  'get_negotiation_context should expose a public negotiator profile'
);
assert(
  !/mood\/patience\/sensitivity/i.test(contextTool.description),
  'get_negotiation_context should not advertise private trait metrics'
);
assert.strictEqual(contextTool.parameters && contextTool.parameters.type, 'object');
assert(
  !Array.isArray(contextTool.parameters.required) || contextTool.parameters.required.length === 0,
  'get_negotiation_context should have no required args'
);
assert.strictEqual(contextTool.response && contextTool.response.type, 'object');
['suggested_rate', 'pricing', 'quote_rules', 'negotiator', 'agent_delegation', 'status'].forEach((field) => {
  assert(
    contextTool.response.properties && contextTool.response.properties[field],
    `get_negotiation_context response should include ${field}`
  );
});

const rule6 = SYSTEM_PROMPT_SKELETON.split('\n').find((line) => line.startsWith('6.'));
assert(rule6 && rule6.includes('code'), 'rule 6 should mention code');
assert(rule6 && rule6.includes('recovery'), 'rule 6 should mention recovery');

const rule11 = SYSTEM_PROMPT_SKELETON.split('\n').find((line) => line.startsWith('11.'));
assert(rule11, 'rule 11 should exist');
assert(rule11.includes('get_negotiation_context'), 'rule 11 should mention get_negotiation_context');
assert(/no fixed percent band/i.test(rule11), 'rule 11 should remove fixed percent band');
assert(/agent_delegation/i.test(rule11), 'rule 11 should mention agent delegation');
assert(/pricing\.distance_miles/.test(rule11), 'rule 11 should ground on distance-based pricing');
assert(/pricing\.weight_lb/.test(rule11), 'rule 11 should ground on weight-based pricing');
assert(/public negotiator profile/i.test(rule11), 'rule 11 should ground on public negotiator profile');
assert(/Never mention hidden trait scores/i.test(rule11), 'rule 11 should hide internal trait scores');
assert(/<app_event>/.test(rule11), 'rule 11 should mention trigger-based app events');

console.log('PASS negotiation-context-smoke');
