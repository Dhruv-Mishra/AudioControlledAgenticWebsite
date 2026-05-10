// Command-palette action registry. Import-only — no side effects at load.
// Each action: { id, label, keywords, section, handler(ctx) }
// ctx supplies { voiceAgent, router } when available.

function navigate(path) {
  return () => {
    if (typeof window !== 'undefined' && window.__router && typeof window.__router.navigate === 'function') {
      window.__router.navigate(path);
    } else {
      window.location.href = path;
    }
  };
}

function setTranscriptMode(mode) {
  return ({ voiceAgent }) => {
    if (voiceAgent && typeof voiceAgent.setTranscriptMode === 'function') {
      voiceAgent.setTranscriptMode(mode);
    }
  };
}

function toggleTheme() {
  return async () => {
    const mod = await import('./theme.js');
    const curr = mod.currentTheme();
    const next = curr === 'dark' ? 'light' : curr === 'light' ? 'system' : 'dark';
    mod.setTheme(next);
  };
}

function clearTranscript() {
  return ({ voiceAgent }) => {
    if (voiceAgent && typeof voiceAgent.clearTranscript === 'function') voiceAgent.clearTranscript();
  };
}

function endCall() {
  return ({ voiceAgent }) => {
    if (!voiceAgent) return;
    if (typeof voiceAgent.isInCall === 'function' && voiceAgent.isInCall()) {
      voiceAgent.endCall();
    }
  };
}

function toggleMute() {
  return ({ voiceAgent }) => {
    if (!voiceAgent) return;
    if (typeof voiceAgent.isInCall === 'function' && voiceAgent.isInCall()) {
      voiceAgent.toggleMuted();
    }
  };
}

function openSettings() {
  return () => {
    const sheet = document.getElementById('voice-settings-sheet');
    const btn = document.getElementById('voice-settings');
    if (sheet && !sheet.classList.contains('is-open')) {
      sheet.hidden = false;
      sheet.classList.add('is-open');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    }
  };
}

function filterDelayedLoads() {
  return () => {
    // Navigate to dispatch if needed, then set the status filter to delayed.
    const ensureDispatch = new Promise((resolve) => {
      if (location.pathname === '/' || location.pathname === '/index.html') return resolve();
      if (window.__router && typeof window.__router.navigate === 'function') {
        window.__router.navigate('/').then(resolve, resolve);
      } else {
        location.href = '/?dispatch.status=delayed';
        resolve();
      }
    });
    ensureDispatch.then(() => {
      const sel = document.querySelector('[data-agent-id="dispatch.filters.status"]');
      if (sel) {
        sel.value = 'delayed';
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      try {
        const url = new URL(location.href);
        url.searchParams.set('dispatch.status', 'delayed');
        history.replaceState(null, '', url.toString());
      } catch {}
    });
  };
}

export function buildActions() {
  return [
    { id: 'nav.dispatch',  section: 'Navigate', label: 'Go to Dispatch',           keywords: 'dispatch loads home board',               handler: navigate('/') },
    { id: 'nav.carriers',  section: 'Navigate', label: 'Go to Carriers',           keywords: 'carriers directory partners',              handler: navigate('/carriers.html') },
    { id: 'nav.negotiate', section: 'Navigate', label: 'Go to Rate Negotiation',   keywords: 'negotiate rate quote counter',             handler: navigate('/negotiate.html') },
    { id: 'nav.contact',   section: 'Navigate', label: 'Go to Contact',            keywords: 'contact support callback',                 handler: navigate('/contact.html') },
    { id: 'nav.map',       section: 'Navigate', label: 'Go to Freight Map',         keywords: 'map loads lanes tracking geography',        handler: navigate('/map.html') },

    { id: 'transcript.off',       section: 'Transcript', label: 'Hide transcript',            keywords: 'transcript off hide',          handler: setTranscriptMode('off') },
    { id: 'transcript.captions',  section: 'Transcript', label: 'Show captions only',         keywords: 'captions subtitles slim',      handler: setTranscriptMode('captions') },
    { id: 'transcript.full',      section: 'Transcript', label: 'Show full transcript',       keywords: 'transcript full panel',        handler: setTranscriptMode('full') },
    { id: 'transcript.clear',     section: 'Transcript', label: 'Clear transcript',           keywords: 'clear reset wipe transcript',  handler: clearTranscript() },

    { id: 'theme.toggle',  section: 'Appearance', label: 'Toggle theme (dark / light / system)', keywords: 'theme dark light system colors', handler: toggleTheme() },

    { id: 'call.end',      section: 'Call',  label: 'End call',                 keywords: 'end hang up call stop',          handler: endCall() },
    { id: 'call.mute',     section: 'Call',  label: 'Mute / unmute microphone', keywords: 'mute mic unmute microphone',     handler: toggleMute() },

    { id: 'dispatch.delayed', section: 'Filters', label: 'Show delayed loads',  keywords: 'delayed late overdue filter',    handler: filterDelayedLoads() },

    { id: 'ui.settings',   section: 'Settings', label: 'Open call settings',    keywords: 'settings options preferences',   handler: openSettings() }
  ];
}
