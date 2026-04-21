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
