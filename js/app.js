// Single entry point for the SPA shell. Responsibilities:
//   1. Build the header, skip link, and voice dock exactly once.
//   2. Instantiate the VoiceAgent exactly once — it survives every
//      in-app navigation.
//   3. Instantiate the Router, which then owns per-route enter/exit.
//   4. Dynamic-import feature modules (palette, activity indicator,
//      quick chips, captions, theme) AFTER first paint via requestIdleCallback
//      so the initial bundle stays small.
//
// The entire page lifecycle is driven from here. Each partial page module
// exports { enter, exit } instead of booting its own agent.

import { bootstrapVoiceShell } from './ui.js';
import { Router } from './router.js';
import { applyDispatchFilters, applyCarrierFilters } from './tool-registry.js';
import { setActivityNote } from './activity-indicator.js';

function onIdle(fn) {
  const run = () => { try { fn(); } catch (err) { console.error('[app] idle task failed', err); } };
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 1500 });
  } else {
    setTimeout(run, 120);
  }
}

async function main() {
  const target = document.getElementById('route-target');
  if (!target) {
    console.error('[app] #route-target missing from shell document');
    return;
  }

  // Bootstrap header, dock, voice agent. Returns the long-lived VoiceAgent.
  const agent = await bootstrapVoiceShell();
  window.__voiceAgent = agent;

  // Wire the router to the long-lived agent.
  const router = new Router({
    target,
    voiceAgent: agent,
    onRouteChange: ({ path }) => {
      if (agent && typeof agent.handleRouteChange === 'function') {
        agent.handleRouteChange({ path });
      }
    }
  });
  window.__router = router;

  // First render — `replace: true` so we don't push a history entry.
  await router.navigate(location.pathname, { replace: true });

  // --- Map tools: registered eagerly so they work the moment the agent
  // connects (before onIdle fires). Every handler validates args FIRST,
  // then navigates, then awaits the widget's ready-Promise before calling
  // the direct widget API.
  async function ensureMapWidget() {
    if (location.pathname !== '/map.html') {
      if (!router || typeof router.navigate !== 'function') {
        throw new Error('Router not attached; cannot open map.');
      }
      await router.navigate('/map.html');
    }
    const w = window.__mapWidget;
    if (!w) throw new Error('Map did not mount.');
    await w.ready;
    return w;
  }

  // Detect what kind of target we're dealing with so we can set a tailored
  // activity-note phrasing.
  function activityNoteForTarget(target) {
    if (target && typeof target === 'object' && Number.isFinite(Number(target.lat))) {
      return 'Panning to coordinates…';
    }
    const str = String(target || '').trim();
    if (/^LD-[A-Za-z0-9]+/i.test(str)) return `Finding load ${str}…`;
    if (/^C-[A-Za-z0-9]+/i.test(str))  return `Finding carrier ${str}…`;
    // 2-letter state code (e.g. "TX") or explicit state word.
    if (/^[A-Za-z]{2}$/.test(str)) return `Showing ${str.toUpperCase()}…`;
    if (str.includes(',')) return `Centering on ${str}…`;
    return `Centering on ${str}…`;
  }

  agent.toolRegistry.registerDomain('map_focus', async (args) => {
    let target;
    if (args && Number.isFinite(Number(args.lat)) && Number.isFinite(Number(args.lng))) {
      target = { lat: Number(args.lat), lng: Number(args.lng), zoom: args.zoom };
    } else if (args && typeof args.target === 'string' && args.target.trim()) {
      target = args.target.trim();
    } else {
      throw new Error('map_focus requires target (string) or lat+lng (numbers).');
    }
    try { setActivityNote({ text: activityNoteForTarget(target), ttl_seconds: 3 }); } catch {}
    const w = await ensureMapWidget();
    const r = await w.focusTarget(target);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });

  agent.toolRegistry.registerDomain('map_highlight_load', async (args) => {
    const id = args && typeof args.load_id === 'string' ? args.load_id.trim() : '';
    if (!id) throw new Error('map_highlight_load requires load_id.');
    try { setActivityNote({ text: `Highlighting ${id}…`, ttl_seconds: 3 }); } catch {}
    const w = await ensureMapWidget();
    const r = await w.highlightLoad(id);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });

  agent.toolRegistry.registerDomain('map_show_layer', async (args) => {
    const layer = args && typeof args.layer === 'string' ? args.layer.toLowerCase().trim() : '';
    const visible = args ? !!args.visible : false;
    if (!layer) throw new Error('map_show_layer requires layer.');
    try {
      setActivityNote({
        text: (visible ? 'Showing ' : 'Hiding ') + layer + '…',
        ttl_seconds: 3
      });
    } catch {}
    const w = await ensureMapWidget();
    const r = await w.setLayerVisible(layer, visible);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });

  agent.toolRegistry.registerDomain('set_compression_strength', (args) => {
    const raw = args == null ? null : args.strength;
    const n = Math.max(0, Math.min(100, Math.round(Number(raw))));
    if (!Number.isFinite(n)) throw new Error('set_compression_strength requires a numeric strength.');
    const el = document.querySelector('[data-agent-id="voice.compression_strength"]');
    if (el) {
      el.value = String(n);
      el.setAttribute('aria-valuenow', String(n));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (typeof agent.setCompressionStrength === 'function') {
      agent.setCompressionStrength(n);
    }
    return { ok: true, strength: n };
  });

  // After first paint, dynamic-import the feature modules. Each module
  // owns its own init() which mounts its DOM + wires its own tool handler.
  // Using requestIdleCallback keeps the critical path fast.
  onIdle(() => {
    Promise.all([
      import('./theme.js'),
      import('./command-palette.js'),
      import('./activity-indicator.js'),
      import('./quick-chips.js'),
      import('./captions-overlay.js')
    ]).then(([theme, palette, activity, chips, captions]) => {
      theme.init();
      theme.registerTool(agent.toolRegistry);

      palette.init({ voiceAgent: agent });
      palette.registerTools(agent.toolRegistry);

      activity.init(agent);
      activity.registerTool(agent.toolRegistry);

      chips.init({ voiceAgent: agent, router });
      chips.registerTool(agent.toolRegistry);

      captions.init(agent);
      captions.mount();

      // Register cross-cutting tool handlers that live in app.js so they
      // survive route changes (per-page handlers still use registerDomain
      // in their own page-*.js). These are DOM-scoped via known agent_ids.
      agent.toolRegistry.registerDomain('filter_loads', (args) => applyDispatchFilters(args || {}));
      agent.toolRegistry.registerDomain('filter_carriers', (args) => applyCarrierFilters(args || {}));
      agent.toolRegistry.registerDomain('set_captions', (args) => {
        const enabled = !!(args && args.enabled);
        const mode = agent.setCaptionsEnabled(enabled);
        // Ensure the overlay is initialised even if the user never toggled
        // the setting manually before.
        captions.setEnabled(mode === 'captions');
        return { ok: true, transcript_mode: mode };
      });
      agent.toolRegistry.registerDomain('set_transcript_pref', (args) => {
        const pref = args && typeof args.pref === 'string' ? args.pref.toLowerCase() : '';
        if (pref !== 'off' && pref !== 'captions' && pref !== 'full') {
          throw new Error(`set_transcript_pref: "${pref}" is not one of off|captions|full.`);
        }
        agent.setTranscriptMode(pref);
        const mode = agent.getTranscriptMode();
        captions.setEnabled(mode === 'captions');
        return { ok: true, transcript_mode: mode, server_forced: !agent.getFlags().showText };
      });

      // Keep the captions overlay state consistent with the transcript
      // mode toggle in the settings sheet.
      agent.addEventListener('transcript-mode-changed', (ev) => {
        const mode = ev.detail && ev.detail.mode;
        captions.setEnabled(mode === 'captions');
      });
      // Apply the initial mode (post-mount).
      captions.setEnabled(agent.getTranscriptMode() === 'captions');
    }).catch((err) => {
      console.error('[app] feature module init failed', err);
    });
  });
}

main().catch((err) => {
  console.error('[app] bootstrap failed', err);
});
