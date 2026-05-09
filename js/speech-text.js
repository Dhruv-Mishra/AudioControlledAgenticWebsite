const STAGE_CUE_WORDS = '(?:breath(?:e|es|ing)?|sighs?|laughs?|chuckles?|giggles?|hmm+|uh+|um+|pause|silence|inhales?|exhales?|clears? throat)';
const STAGE_CUE_PREFIX = '(?:soft|quick|small|quiet|brief|audible|light|little|low|short|slow|tired|warm|gentle)?';

const COMPLETE_STAGE_MARKER_RE = new RegExp(
  `\\s*[\\*_\\[]\\s*${STAGE_CUE_PREFIX}\\s*${STAGE_CUE_WORDS}[^\\]\\*_{]{0,48}[\\*_\\]]\\s*`,
  'gi'
);
const COMPLETE_PAREN_STAGE_MARKER_RE = new RegExp(
  `\\s*\\(\\s*${STAGE_CUE_PREFIX}\\s*${STAGE_CUE_WORDS}[^)]{0,48}\\)\\s*`,
  'gi'
);
const DANGLING_STAGE_MARKER_RE = new RegExp(
  `\\s*[\\*_\\[(]\\s*${STAGE_CUE_PREFIX}\\s*${STAGE_CUE_WORDS}[^\\]\\*_)\\n]{0,48}$`,
  'gi'
);
const STANDALONE_STAGE_LINE_RE = new RegExp(
  `^\\s*${STAGE_CUE_PREFIX}\\s*${STAGE_CUE_WORDS}\\.?\\s*$`,
  'i'
);

export function sanitizeAgentSpeechText(text) {
  const raw = String(text || '');
  if (!raw) return '';
  return raw
    .replace(COMPLETE_STAGE_MARKER_RE, ' ')
    .replace(COMPLETE_PAREN_STAGE_MARKER_RE, ' ')
    .replace(DANGLING_STAGE_MARKER_RE, '')
    .split('\n')
    .filter((line) => !STANDALONE_STAGE_LINE_RE.test(line))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([.!?])\s+([.!?])/g, '$1')
    .trimStart();
}