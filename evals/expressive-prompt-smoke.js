// Smoke — expressive-agent prompt contract.
//
// The agent may sound human, but stage directions must never leak into
// spoken output, transcripts, or captions. Checks are static and do not hit
// Gemini.
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

// 1. Human delivery is still requested.
assert(
  /real phone line/i.test(SYSTEM_PROMPT_SKELETON),
  'skeleton asks for natural phone-line delivery'
);

// 2. Stage directions are explicitly forbidden from text/audio narration.
assert(
  /never output stage directions/i.test(SYSTEM_PROMPT_SKELETON),
  'skeleton forbids stage directions in spoken/caption text'
);

// 3. The old marker-producing instruction must not return.
assert(
  !/Use\s+`?\*action\*`?\s+markers/i.test(SYSTEM_PROMPT_SKELETON),
  'skeleton does not instruct the model to emit *action* markers'
);

// 4. The prompt carries concrete forbidden examples so the model knows
//    exactly what to avoid.
const forbiddenExamples = ['*sighs*', '*soft breath*', '[laughs]', '(pause)'];
const foundForbidden = forbiddenExamples.filter((example) => SYSTEM_PROMPT_SKELETON.includes(example));
assert(foundForbidden.length >= 3, 'forbidden marker examples present — found: ' + JSON.stringify(foundForbidden));

// 5. Soft length cap preserves cache prefix.
assert(SYSTEM_PROMPT_SKELETON.length <= 2600, 'skeleton length ' + SYSTEM_PROMPT_SKELETON.length + ' <= 2600 chars');

// 6. buildSystemInstruction preserves skeleton verbatim at the top.
const built = buildSystemInstruction({ personaFragment: 'PERSONA_STUB', pageName: '/' });
assert(
  built.startsWith(SYSTEM_PROMPT_SKELETON),
  'buildSystemInstruction emits skeleton verbatim at the top'
);

if (FAIL === 0) {
  console.log('\nALL EXPRESSIVE-PROMPT SMOKE CHECKS PASSED');
  process.exit(0);
} else {
  console.error('\n' + FAIL + ' check(s) failed');
  process.exit(1);
}
