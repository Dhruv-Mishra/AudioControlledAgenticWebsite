// Client-side persona mirror. The server is the source of truth; this is a
// fallback so the UI can render before /api/config resolves. When the real
// list arrives we overwrite `PERSONAS`.
export const DEFAULT_PERSONAS = [
  { id: 'professional', label: 'Professional', dotColor: '#9AA3B2' },
  { id: 'cheerful',     label: 'Cheerful',     dotColor: '#6EE7B7' },
  { id: 'frustrated',   label: 'Frustrated',   dotColor: '#F87171' },
  { id: 'tired',        label: 'Tired',        dotColor: '#60A5FA' },
  { id: 'excited',      label: 'Excited',      dotColor: '#C084FC' }
];

export const DEFAULT_PERSONA_ID = 'professional';
