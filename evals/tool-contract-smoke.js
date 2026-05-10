'use strict';

const assert = require('assert');
const { STATIC_TOOL_DECLARATIONS, SYSTEM_PROMPT_SKELETON } = require('../api/tools');

function findTool(name) {
  return STATIC_TOOL_DECLARATIONS.find((tool) => tool && tool.name === name);
}

const listElements = findTool('list_elements');
assert(listElements, 'list_elements declaration should exist');
assert(/capabilities/i.test(listElements.description), 'list_elements should advertise capabilities');
assert(/capabilities\.fill=true/i.test(listElements.description), 'list_elements should tell the model how to pick fill targets');

const navigate = findTool('navigate');
assert(navigate, 'navigate declaration should exist');
assert(/open_load/i.test(navigate.description), 'navigate should point load-specific flows to open_load');
assert(/load_id/i.test(navigate.description), 'navigate should document the tolerated load_id query');

const fill = findTool('fill');
assert(fill, 'fill declaration should exist');
assert(/writable input(?:\/| or )textarea/i.test(fill.description), 'fill should be limited to writable inputs/textareas');
assert(/capabilities\.fill=true/i.test(fill.description), 'fill should require the fill capability');
assert(/negotiate\.load_id/i.test(fill.description), 'fill should forbid filling the negotiate load readout');

const openLoad = findTool('open_load');
assert(openLoad, 'open_load declaration should exist');
assert(openLoad.parameters && Array.isArray(openLoad.parameters.required), 'open_load should declare required args');
assert(openLoad.parameters.required.includes('load_id'), 'open_load should require load_id');
assert(/target_page="negotiate"/i.test(openLoad.description), 'open_load should document negotiation target usage');

const rule3 = SYSTEM_PROMPT_SKELETON.split('\n').find((line) => line.startsWith('3.'));
assert(rule3 && /capabilities match the tool/i.test(rule3), 'rule 3 should require matching capabilities');

const rule6 = SYSTEM_PROMPT_SKELETON.split('\n').find((line) => line.startsWith('6.'));
assert(rule6 && /Never silently pause/i.test(rule6), 'rule 6 should forbid silent pauses after tool failures');

const rule10 = SYSTEM_PROMPT_SKELETON.split('\n').find((line) => line.startsWith('10.'));
assert(rule10 && /Speak in first person/i.test(rule10), 'rule 10 should force first-person speech');
assert(rule10 && /do not call yourself Jarvis/i.test(rule10), 'rule 10 should forbid third-person self-reference');

const rule11 = SYSTEM_PROMPT_SKELETON.split('\n').find((line) => line.startsWith('11.'));
assert(rule11 && /open_load/.test(rule11), 'rule 11 should route specific negotiation loads through open_load');
assert(rule11 && /target_page: "negotiate"/i.test(rule11), 'rule 11 should document negotiation target usage');

const totalToolDescriptionChars = STATIC_TOOL_DECLARATIONS.reduce((n, tool) => n + (tool.description || '').length, 0);
assert(SYSTEM_PROMPT_SKELETON.length <= 2600, 'system prompt should stay lean');
assert(totalToolDescriptionChars <= 4500, 'tool descriptions should stay lean');

console.log('PASS tool-contract-smoke');
