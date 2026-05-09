'use strict';

const assert = require('assert');

const { STATIC_TOOL_DECLARATIONS, SYSTEM_PROMPT_SKELETON } = require('../api/tools');

function findTool(name) {
  return STATIC_TOOL_DECLARATIONS.find((tool) => tool && tool.name === name);
}

const submitQuote = findTool('submit_quote');
assert(submitQuote, 'submit_quote declaration should exist');
assert(
  submitQuote.description.includes('±25%'),
  'submit_quote description should mention the ±25% rule'
);
assert(
  /accepted\s+band|\bband\b/i.test(submitQuote.description),
  'submit_quote description should mention the accepted band'
);

const contextTool = findTool('get_negotiation_context');
assert(contextTool, 'get_negotiation_context declaration should exist');
assert.strictEqual(contextTool.parameters && contextTool.parameters.type, 'object');
assert(
  !Array.isArray(contextTool.parameters.required) || contextTool.parameters.required.length === 0,
  'get_negotiation_context should have no required args'
);
assert.strictEqual(contextTool.response && contextTool.response.type, 'object');
['suggested_rate', 'accepted_min', 'accepted_max'].forEach((field) => {
  assert(
    contextTool.response.properties && contextTool.response.properties[field],
    `get_negotiation_context response should include ${field}`
  );
});

const rule6 = SYSTEM_PROMPT_SKELETON.split('\n').find((line) => line.startsWith('6.'));
assert(rule6 && rule6.includes('code'), 'rule 6 should mention code');
assert(rule6 && rule6.includes('recovery'), 'rule 6 should mention recovery');

const rule15 = SYSTEM_PROMPT_SKELETON.split('\n').find((line) => line.startsWith('15.'));
assert(rule15, 'rule 15 should exist');
assert(rule15.includes('get_negotiation_context'), 'rule 15 should mention get_negotiation_context');
assert(/band/i.test(rule15), 'rule 15 should mention the accepted band');

console.log('PASS negotiation-context-smoke');
