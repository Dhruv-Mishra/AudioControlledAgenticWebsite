/* Anti-FOUC theme bootstrap.
 *
 * Loaded synchronously from index.html <head> BEFORE any CSS so the
 * `data-theme` attribute is set on <html> on the very first paint. Without
 * this, a stored "light" preference would briefly render against the
 * default dark surface (or vice-versa) — visible flicker.
 *
 * This file is intentionally tiny and dependency-free. It must:
 *   - never throw (storage/match-media calls are wrapped in try/catch),
 *   - run before css/tokens.css evaluates `[data-theme="light"]`, and
 *   - be served from the same origin so it satisfies `script-src 'self'`
 *     in the production CSP. (We previously inlined this; that violated
 *     CSP and the only sane fix is an external file.)
 *
 * The runtime theme controller in js/theme.js takes over after first
 * paint — it shares the same storage key + 'system' fallback semantics.
 */
(function bootstrapTheme() {
  try {
    var stored = localStorage.getItem('jarvis.theme') || 'system';
    var effective = stored;
    if (stored === 'system') {
      effective = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', effective);
  } catch (_) {
    /* localStorage / matchMedia unavailable (very old browser, file://, or
     * privacy mode). Default `data-theme` is unset — CSS treats this as
     * the dark theme (the :root block is the default). */
  }
})();
