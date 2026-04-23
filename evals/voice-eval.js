// Text-mode eval: fire 5 scripted prompts at /api/eval and assert the model
// calls the expected tool with the expected arg shape.
//
// Usage:
//   node evals/voice-eval.js            (requires server running on PORT or 3001)
//   EVAL_HOST=localhost:3001 node evals/voice-eval.js

'use strict';

const http = require('http');
const https = require('https');

const HOST = process.env.EVAL_HOST || 'localhost:3001';
const [host, port] = HOST.split(':');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host, port: port || 80, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Element fixtures the model can target. Mirrors real DOM content on each page.
const DISPATCH_ELEMENTS = [
  { id: 'dispatch.filters.search', role: 'input', label: 'Search' },
  { id: 'dispatch.filters.status', role: 'select', label: 'Status', options: ['All','In transit','Booked','Pending','Delayed','Delivered'] },
  { id: 'dispatch.filters.lane', role: 'input', label: 'Lane contains' },
  { id: 'dispatch.action.export', role: 'button', label: 'Export CSV' },
  { id: 'dispatch.row.LD-10824', role: 'button', label: 'Load LD-10824, Chicago, IL to Dallas, TX' },
  { id: 'nav.carriers', role: 'link', label: 'Carriers' },
  { id: 'nav.negotiate', role: 'link', label: 'Negotiate' }
];

const NEGOTIATE_ELEMENTS = [
  { id: 'negotiate.form.pickup', role: 'input', label: 'Pickup' },
  { id: 'negotiate.form.dropoff', role: 'input', label: 'Dropoff' },
  { id: 'negotiate.form.target_rate', role: 'input', label: 'Target rate (USD)' },
  { id: 'negotiate.form.note', role: 'input', label: 'Note for carrier' },
  { id: 'negotiate.submit', role: 'button', label: 'Submit quote' },
  { id: 'negotiate.counter', role: 'button', label: 'Log carrier counter' }
];

const CARRIER_ELEMENTS = [
  { id: 'carriers.filters.search', role: 'input', label: 'Search' },
  { id: 'carriers.filters.available', role: 'select', label: 'Availability', options: ['Any','Available now','Unavailable'] },
  { id: 'carriers.card.C-088.shortlist', role: 'button', label: 'Shortlist' },
  { id: 'carriers.card.C-118.shortlist', role: 'button', label: 'Shortlist' }
];

const MAP_ELEMENTS = [
  { id: 'map.canvas', role: 'application', label: 'Freight map' },
  { id: 'map.filter.loads', role: 'button', label: 'Loads' },
  { id: 'map.filter.carriers', role: 'button', label: 'Carriers' },
  { id: 'map.filter.lanes', role: 'button', label: 'Lanes' },
  { id: 'map.reset_view', role: 'button', label: 'Reset view' },
  { id: 'map.marker.LD-10824', role: 'button', label: 'Load LD-10824 Chicago → Dallas' }
];

const CASES = [
  {
    name: 'navigate to carriers',
    page: '/',
    elements: DISPATCH_ELEMENTS,
    text: 'Take me to the carriers page.',
    expect: (tc) => tc.some((c) => c.name === 'navigate' && /carriers/i.test(String(c.args?.path || '')))
  },
  {
    name: 'fill target rate',
    page: '/negotiate.html',
    elements: NEGOTIATE_ELEMENTS,
    text: 'Set the target rate to 1850.',
    expect: (tc) => tc.some((c) => c.name === 'fill' && /target[_ ]?rate/i.test(String(c.args?.agent_id || '')) && String(c.args?.value).includes('1850'))
  },
  {
    name: 'list available carriers',
    page: '/carriers.html',
    elements: CARRIER_ELEMENTS,
    text: 'Which carriers are available?',
    expect: (tc) => tc.some((c) => c.name === 'list_elements' || c.name === 'read_text' || (c.name === 'select' && /availab/i.test(String(c.args?.agent_id || ''))))
  },
  {
    name: 'submit the quote',
    page: '/negotiate.html',
    elements: NEGOTIATE_ELEMENTS,
    text: 'Submit the quote.',
    expect: (tc) => tc.some((c) => c.name === 'submit_quote' || c.name === 'submit_form' || (c.name === 'click' && /submit/i.test(String(c.args?.agent_id || ''))))
  },
  {
    name: 'highlight the submit button',
    page: '/negotiate.html',
    elements: NEGOTIATE_ELEMENTS,
    text: 'Flash the submit button so I can see it.',
    expect: (tc) => tc.some((c) => c.name === 'highlight' && /submit/i.test(String(c.args?.agent_id || '')))
  },
  // ---- New tools introduced by the upgrade (one eval entry per tool). ----
  {
    name: 'turn captions on',
    page: '/',
    elements: DISPATCH_ELEMENTS,
    text: 'Turn captions on so I can read them while I drive.',
    expect: (tc) => tc.some((c) => c.name === 'set_captions' && c.args && c.args.enabled === true)
  },
  {
    name: 'open command palette with a query',
    page: '/',
    elements: DISPATCH_ELEMENTS,
    text: 'Open the command palette and search for carriers.',
    expect: (tc) => tc.some((c) => c.name === 'open_palette' || c.name === 'run_palette_action')
  },
  {
    name: 'run palette action to toggle theme',
    page: '/',
    elements: DISPATCH_ELEMENTS,
    text: 'Use the palette action to toggle the theme for me.',
    expect: (tc) => tc.some((c) => c.name === 'run_palette_action' || c.name === 'set_theme')
  },
  {
    name: 'activity note during tool work',
    page: '/carriers.html',
    elements: CARRIER_ELEMENTS,
    text: 'Compare the top three reefer carriers for me and tell me when you have a shortlist.',
    expect: (tc) => tc.some((c) => c.name === 'set_activity_note' || c.name === 'filter_carriers' || c.name === 'list_elements')
  },
  {
    name: 'set quick actions after a selection',
    page: '/carriers.html',
    elements: CARRIER_ELEMENTS,
    text: 'Give me quick buttons for shortlisting and requesting quotes on the visible carriers.',
    expect: (tc) => tc.some((c) => c.name === 'set_quick_actions' || c.name === 'click')
  },
  {
    name: 'filter loads by delayed status',
    page: '/',
    elements: DISPATCH_ELEMENTS,
    text: 'Show me just the delayed loads.',
    expect: (tc) => tc.some((c) => c.name === 'filter_loads' && /delayed/i.test(String(c.args?.status || ''))) ||
                   tc.some((c) => c.name === 'select' && /status/i.test(String(c.args?.agent_id || '')))
  },
  {
    name: 'filter carriers by equipment',
    page: '/carriers.html',
    elements: CARRIER_ELEMENTS,
    text: 'Only show reefer carriers that are available now.',
    expect: (tc) => tc.some((c) => c.name === 'filter_carriers' && /reefer/i.test(String(c.args?.equipment || ''))) ||
                   tc.some((c) => c.name === 'select' && /equipment|availab/i.test(String(c.args?.agent_id || '')))
  },
  {
    name: 'set theme to dark',
    page: '/',
    elements: DISPATCH_ELEMENTS,
    text: 'Switch to dark mode, please.',
    expect: (tc) => tc.some((c) => c.name === 'set_theme' && /dark/i.test(String(c.args?.theme || ''))) ||
                   tc.some((c) => c.name === 'run_palette_action' && /theme/i.test(String(c.args?.action_id || '')))
  },
  // ---- v2 tools: map navigation + continuous compression strength. ----
  {
    name: 'map_focus on Chicago',
    page: '/map.html',
    elements: MAP_ELEMENTS,
    text: 'Center the map on Chicago.',
    expect: (tc) => tc.some((c) => c.name === 'map_focus' && /chicago/i.test(String(c.args?.target || '')))
  },
  {
    name: 'map_highlight_load for a specific load',
    page: '/map.html',
    elements: MAP_ELEMENTS,
    text: 'Show me load LD-10824 on the map.',
    expect: (tc) => tc.some((c) => c.name === 'map_highlight_load' && /LD-?10824/i.test(String(c.args?.load_id || ''))) ||
                   tc.some((c) => c.name === 'map_focus' && /10824/i.test(String(c.args?.target || '')))
  },
  {
    name: 'map_show_layer hides carriers',
    page: '/map.html',
    elements: MAP_ELEMENTS,
    text: 'Hide the carriers on the map — just show loads.',
    expect: (tc) => tc.some((c) => c.name === 'map_show_layer' && /carrier/i.test(String(c.args?.layer || '')) && c.args?.visible === false)
  },
  {
    name: 'map_focus by state abbreviation',
    page: '/map.html',
    elements: MAP_ELEMENTS,
    text: 'Zoom the map out to Texas.',
    expect: (tc) => tc.some((c) => c.name === 'map_focus' && /^(texas|tx)$/i.test(String(c.args?.target || '').trim()))
  },
  {
    name: 'map_focus by load id routes through focusTarget',
    page: '/map.html',
    elements: MAP_ELEMENTS,
    text: 'Center the map on load LD-10824 without flashing it.',
    expect: (tc) => tc.some((c) => c.name === 'map_focus' && /LD-?10824/i.test(String(c.args?.target || ''))) ||
                   tc.some((c) => c.name === 'map_highlight_load' && /LD-?10824/i.test(String(c.args?.load_id || '')))
  },
  {
    name: 'map_show_layer toggles delayed overlay on',
    page: '/map.html',
    elements: MAP_ELEMENTS,
    text: 'Highlight just the delayed shipments on the map.',
    expect: (tc) => tc.some((c) => c.name === 'map_show_layer' && /delayed/i.test(String(c.args?.layer || '')) && c.args?.visible === true) ||
                   tc.some((c) => c.name === 'filter_loads' && /delayed/i.test(String(c.args?.status || '')))
  },
  {
    name: 'map tool auto-navigates from dispatch page',
    page: '/',
    elements: DISPATCH_ELEMENTS,
    text: 'Pull up Dallas on the map for me.',
    expect: (tc) => tc.some((c) => c.name === 'map_focus' && /dallas/i.test(String(c.args?.target || ''))) ||
                   tc.some((c) => c.name === 'navigate' && /map/i.test(String(c.args?.path || '')))
  },
  {
    name: 'map_highlight_load confirms ambiguous id',
    page: '/map.html',
    elements: MAP_ELEMENTS,
    text: 'Show me load L D one oh eight two four.',
    expect: (tc) => tc.some((c) => c.name === 'map_highlight_load' && /LD-?10824/i.test(String(c.args?.load_id || ''))) ||
                   tc.length === 0 // acceptable: confirm phonetics before calling
  },
  // audio-flow: end_call lets the agent hang up when the user signals
  // they're done. Must NOT fire on a polite-but-mid-task message.
  {
    name: 'end_call when user says goodbye',
    page: '/',
    elements: DISPATCH_ELEMENTS,
    text: 'Thanks, that\'s all I needed. Goodbye.',
    expect: (tc) => tc.some((c) => c.name === 'end_call')
  },
  {
    name: 'end_call stays silent on a normal question',
    page: '/',
    elements: DISPATCH_ELEMENTS,
    text: 'Which carriers are available for the Dallas lane?',
    expect: (tc) => !tc.some((c) => c.name === 'end_call')
  }
];

async function main() {
  let passed = 0;
  let failed = 0;
  for (const tc of CASES) {
    try {
      const r = await post('/api/eval', { text: tc.text, page: tc.page, elements: tc.elements });
      if (!r.body.ok) {
        console.log(`FAIL  ${tc.name}  :: server error ${r.body.error}`);
        failed += 1; continue;
      }
      const ok = tc.expect(r.body.toolCalls || []);
      if (ok) {
        console.log(`PASS  ${tc.name}  :: calls = ${JSON.stringify(r.body.toolCalls)}`);
        passed += 1;
      } else {
        console.log(`FAIL  ${tc.name}  :: calls = ${JSON.stringify(r.body.toolCalls)} text="${(r.body.text || '').slice(0,120)}"`);
        failed += 1;
      }
    } catch (err) {
      console.log(`ERROR ${tc.name} :: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`\n${passed}/${passed + failed} passed.`);
  process.exit(failed ? 1 : 0);
}

main();
