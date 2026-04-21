// Single entry point for the SPA shell. Responsibilities:
//   1. Build the header, skip link, and voice dock exactly once.
//   2. Instantiate the VoiceAgent exactly once — it survives every
//      in-app navigation.
//   3. Instantiate the Router, which then owns per-route enter/exit.
//
// The entire page lifecycle is driven from here. Each partial page module
// exports { enter, exit } instead of booting its own agent.

import { bootstrapVoiceShell } from './ui.js';
import { Router } from './router.js';

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
      // One place that tells the VoiceAgent "the user moved to this page."
      // Sends a single page_context frame — no WS reconnect, no teardown.
      if (agent && typeof agent.handleRouteChange === 'function') {
        agent.handleRouteChange({ path });
      }
    }
  });
  window.__router = router;

  // First render — `replace: true` so we don't push a history entry.
  await router.navigate(location.pathname, { replace: true });
}

main().catch((err) => {
  console.error('[app] bootstrap failed', err);
});
