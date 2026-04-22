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
