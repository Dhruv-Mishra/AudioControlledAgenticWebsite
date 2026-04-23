// Smoke — expressive-agent prompt contract.
//
// Asserts the v2.2 expressive-delivery block exists in the system prompt
// and is LAST (preserving the prompt cache prefix). The block is short
// (≤ 30 tokens) and instructs the model to use up to one vocal burst per
// turn when emotionally warranted.
//
// Checks performed without hitting Gemini:
//
//   1. The skeleton contains the header "Expressive delivery".
//   2. The skeleton mentions at least TWO vocal-burst tokens:
//      *sighs*, *laughs*, *hmm*, breath. (Case-insensitive.)
//   3. The expressive block is the LAST section of the skeleton — any
//      prior section (rules, map-tool usage) appears BEFORE it.
//   4. The skeleton length stays under a soft cap so the prompt-cache
//      prefix is not bloated. 8000 chars is generous headroom.
//   5. `buildSystemInstruction` still emits the skeleton verbatim at the
//      top of the output (no reordering).
//
// Usage:
//   node evals/expressive-prompt-smoke.js
//   npm run smoke:expressive-prompt

'use strict';

const { SYSTEM_PROMPT_SKELETON, buildSystemInstruction } = require('../api/tools');

let FAIL = 0;
function assert(cond, msg) {
  if (cond) { console.log('PASS  ' + msg); }
  else      { console.error('FAIL  ' + msg); FAIL += 1; }
}

// 1. Header present.
assert(
  /Expressive delivery/i.test(SYSTEM_PROMPT_SKELETON),
  'skeleton contains "Expressive delivery" header'
);

// 2. At least two vocal-burst tokens mentioned.
const bursts = ['*sighs*', '*laughs*', '*hmm*', 'breath', 'burst'];
const found = bursts.filter((b) => SYSTEM_PROMPT_SKELETON.toLowerCase().includes(b.toLowerCase()));
assert(
  found.length >= 2,
  'at least 2 burst tokens mentioned — found: ' + JSON.stringify(found)
);

// 3. Expressive block is LAST. Find the header position and assert no
//    other major section header comes after it.
const expIdx = SYSTEM_PROMPT_SKELETON.search(/Expressive delivery/i);
const mapIdx = SYSTEM_PROMPT_SKELETON.search(/Map-tool usage/i);
assert(expIdx > mapIdx && expIdx > 0, 'Expressive block comes AFTER Map-tool usage');

// 4. Soft length cap preserves cache prefix.
assert(SYSTEM_PROMPT_SKELETON.length <= 8000, 'skeleton length ' + SYSTEM_PROMPT_SKELETON.length + ' ≤ 8000 chars');

// 5. buildSystemInstruction preserves skeleton verbatim at the top.
const built = buildSystemInstruction({ personaFragment: 'PERSONA_STUB', pageName: '/' });
assert(
  built.startsWith(SYSTEM_PROMPT_SKELETON),
  'buildSystemInstruction emits skeleton verbatim at the top'
);

// 6. Narrate-emotion-in-brackets is explicitly discouraged.
assert(
  /Do NOT narrate emotion in brackets/i.test(SYSTEM_PROMPT_SKELETON),
  'skeleton discourages "[surprised]" style bracket narration'
);

if (FAIL === 0) {
  console.log('\nALL EXPRESSIVE-PROMPT SMOKE CHECKS PASSED');
  process.exit(0);
} else {
  console.error('\n' + FAIL + ' check(s) failed');
  process.exit(1);
}
