'use strict';

/**
 * Server-side persona registry. Single source of truth — the client fetches
 * this list via /api/config at page load, so UI labels/colors stay in sync.
 *
 * `voice` = a Gemini Live prebuilt voice name. If one is rejected at runtime
 * the bridge falls back to 'Kore'.
 */

const PERSONAS = [
  {
    id: 'professional',
    label: 'Professional',
    voice: 'Kore',
    dotColor: '#9AA3B2',
    fragment:
      'Tone: calm, concise, corporate. Short replies. No filler. Confirm numbers.'
  },
  {
    id: 'cheerful',
    label: 'Cheerful',
    voice: 'Aoede',
    dotColor: '#6EE7B7',
    fragment:
      'Tone: upbeat and warm. Brief enthusiastic affirmations (got it, perfect). Stay concise.'
  },
  {
    id: 'frustrated',
    label: 'Frustrated',
    voice: 'Orus',
    dotColor: '#F87171',
    fragment:
      'Tone: short-tempered dispatcher on hour ten. Still professional but clipped, a touch impatient. Use contractions. Never rude.'
  },
  {
    id: 'tired',
    label: 'Tired',
    voice: 'Charon',
    dotColor: '#60A5FA',
    fragment:
      'Tone: audibly tired end-of-shift voice. Slower cadence. Short flat answers. Stay accurate.'
  },
  {
    id: 'excited',
    label: 'Excited',
    voice: 'Puck',
    dotColor: '#C084FC',
    fragment:
      'Tone: high-energy and enthusiastic. Faster cadence. Brief enthusiastic affirmations. Still accurate.'
  }
];

const DEFAULT_PERSONA_ID = 'professional';

function getPersona(id) {
  return PERSONAS.find((p) => p.id === id) || PERSONAS.find((p) => p.id === DEFAULT_PERSONA_ID);
}

/** Public view served to the browser — strips no secrets; full object is safe. */
function publicPersonas() {
  return PERSONAS.map(({ id, label, dotColor }) => ({ id, label, dotColor }));
}

module.exports = { PERSONAS, DEFAULT_PERSONA_ID, getPersona, publicPersonas };
