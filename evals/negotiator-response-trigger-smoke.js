'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'js/page-negotiate.js'), 'utf8');
const voice = fs.readFileSync(path.join(root, 'js/voice-agent.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'api/live-bridge.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/enhancements.css'), 'utf8');

assert(/CARRIER_RESPONSE_DELAY_MS\s*=\s*2800/.test(page), 'carrier response delay should leave room for seller thinking');
assert(/deferUntilSpeechEnd:\s*true/.test(page), 'negotiator response app events should use the speech-end queue');
assert(/AGENT_REACTION_DELAY_MS\s*=\s*600/.test(page), 'agent reaction trigger should be quick after the queued seller event is ready');
assert(/negotiator:response-arrived/.test(page), 'page should emit negotiator response arrival event');
assert(/sendAppEvent\('negotiator_response_arrived'/.test(page), 'page should trigger voice agent after response arrival');
assert(/sendAppEvent\(name, detail/.test(voice), 'VoiceAgent should expose sendAppEvent');
assert(/case 'app_event'/.test(bridge), 'live bridge should accept app_event frames');
assert(/sendRealtimeInput\(\{ text \}\)/.test(bridge), 'live bridge should inject app events as realtime input');
assert(/typing-dots/.test(css), 'typing dots styles should exist');
assert(/negotiate-dot-bounce/.test(css), 'typing dots animation should exist');
assert(!/Patience<\/span>|Sensitivity<\/span>/.test(page), 'negotiator UI should not render patience/sensitivity labels');

console.log('PASS negotiator-response-trigger-smoke');