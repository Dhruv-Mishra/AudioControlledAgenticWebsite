'use strict';

const assert = require('assert');

const { SYSTEM_PROMPT_SKELETON, buildSystemInstruction } = require('../api/tools');
const { buildCallInitiatedText } = require('../api/live-bridge');

const introScript = 'Jarvis here, Dhruv FreightOps. How can I help?';

const systemPrompt = buildSystemInstruction({
  personaFragment: 'Stay concise.',
  pageName: '/map.html'
});

assert(
  systemPrompt.includes('<current_page>\nCurrently on: /map.html'),
  'system prompt should render the static page block as <current_page>'
);
assert(
  !systemPrompt.includes('<page_context>\nCurrently on: /map.html'),
  'static page block should not render as <page_context>'
);
assert(
  !systemPrompt.includes('\n</page_context>'),
  'system prompt should not close the static page block with </page_context>'
);
assert(
  SYSTEM_PROMPT_SKELETON.includes('The static <current_page> block in your system prompt is just situational awareness'),
  'rule 8 should explain that <current_page> is situational awareness only'
);
assert(
  SYSTEM_PROMPT_SKELETON.includes('do NOT acknowledge it on its own'),
  'rule 8 should forbid acknowledging static <current_page> by itself'
);

const mapGreeting = buildCallInitiatedText({
  page: '/map.html',
  title: 'Map',
  persona: { introScript }
});

assert(
  mapGreeting.includes(`Step 1 — Speak this greeting EXACTLY first, word-for-word: "${introScript}"`),
  'non-default page greeting should require the intro first'
);
assert(
  mapGreeting.includes('Step 2 — Then add ONE short, natural sentence acknowledging that the user is on /map.html'),
  'non-default page greeting should include a page-aware Step 2'
);
assert(
  mapGreeting.includes('Do NOT skip Step 1'),
  'non-default page greeting should explicitly preserve Step 1'
);

const defaultGreeting = buildCallInitiatedText({
  page: '/',
  title: 'Dispatch Board',
  persona: { introScript }
});

assert(
  defaultGreeting.includes('Step 2 — That is the entire turn. Then wait for the user to respond.'),
  'default page greeting should stop after the intro'
);
assert(
  !defaultGreeting.includes('Then add ONE short, natural sentence acknowledging'),
  'default page greeting should not ask for a page-aware acknowledgement'
);

console.log('PASS greeting non-default page prompt smoke');