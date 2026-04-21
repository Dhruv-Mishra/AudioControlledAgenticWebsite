'use strict';

/**
 * /api/eval — text-mode probe into the same model + tool schemas + system
 * prompt the Live bridge uses, but with a non-Live call so we can script
 * determinstic evals without spinning up audio.
 *
 * Body: { text: string, page?: string, elements?: ElementSummary[] }
 * Response: { ok, toolCalls: [{name, args}], text, raw }
 */

const { GoogleGenAI } = require('@google/genai');
const { STATIC_TOOL_DECLARATIONS, buildSystemInstruction } = require('./tools');
const { getPersona, DEFAULT_PERSONA_ID } = require('./personas');

const EVAL_MODEL = process.env.GEMINI_EVAL_MODEL || 'gemini-2.5-flash';

async function readJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleEval(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'POST only' }));
    return;
  }
  let body;
  try { body = await readJson(req); }
  catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'GEMINI_API_KEY not set.' }));
    return;
  }

  const persona = getPersona(body.persona || DEFAULT_PERSONA_ID);
  const system = buildSystemInstruction({
    personaFragment: persona.fragment,
    pageName: body.page || '/'
  });

  const elementsSummary = Array.isArray(body.elements) && body.elements.length
    ? body.elements.map((e) => `${e.id} [${e.role}] ${e.label || ''}`).join('\n')
    : 'No elements sent with this probe.';

  const userText = body.text ? String(body.text).slice(0, 2000) : '';

  const genai = new GoogleGenAI({ apiKey });

  try {
    const response = await genai.models.generateContent({
      model: EVAL_MODEL,
      config: {
        systemInstruction: {
          parts: [{ text: system + '\n\n<page_elements>\n' + elementsSummary + '\n</page_elements>' }]
        },
        tools: [{ functionDeclarations: STATIC_TOOL_DECLARATIONS }],
        thinkingConfig: { thinkingBudget: 0 }
      },
      contents: [
        { role: 'user', parts: [{ text: `<user_input>${userText}</user_input>` }] }
      ]
    });

    const toolCalls = [];
    const textParts = [];
    const candidates = (response && response.candidates) || [];
    for (const cand of candidates) {
      const parts = (cand.content && cand.content.parts) || [];
      for (const part of parts) {
        if (part.functionCall) {
          toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
        }
        if (part.text) textParts.push(part.text);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, toolCalls, text: textParts.join('\n').trim(), model: EVAL_MODEL }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: (err && err.message) || String(err) }));
  }
}

module.exports = { handleEval };
