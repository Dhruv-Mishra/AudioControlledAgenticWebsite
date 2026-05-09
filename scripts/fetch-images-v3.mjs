#!/usr/bin/env node
// scripts/fetch-images-v3.mjs — Adds the v3 image variation set on top
// of the original manifest. Run once: `node scripts/fetch-images-v3.mjs`.
//
// Each entry uses the same Pexels hot-link + sharp WebP pipeline as the
// original fetch-images.mjs, so behaviour and CSP are identical.

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const pexels = (id, w = 1200) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${w}`;

// Distinct subjects for the v3 surfaces. Each Pexels ID was chosen to be
// visually different from anything already on disk so the homepage,
// negotiate, contact, and carrier-directory pages stop reusing the same
// 8 truck portraits.
const MANIFEST = [
  // Editorial hero alternates — different mood per page
  { url: pexels(1267338, 1600), dest: 'public/images/hero/dispatch-console.webp', w: 1600, q: 72 },   // night dispatch console
  { url: pexels(1427541, 1600), dest: 'public/images/hero/container-yard.webp',   w: 1600, q: 72 },   // container yard at dusk
  { url: pexels(906494,  1600), dest: 'public/images/hero/highway-signage.webp',  w: 1600, q: 72 },   // interstate signage

  // Lane cards (3 distinct corridor images for dispatch + negotiate)
  { url: pexels(2547565, 800),  dest: 'public/images/lanes/i80-corridor.webp',    w: 800,  q: 75 },
  { url: pexels(93398,   800),  dest: 'public/images/lanes/i95-spine.webp',       w: 800,  q: 75 },
  { url: pexels(2058472, 800),  dest: 'public/images/lanes/i5-reefer.webp',       w: 800,  q: 75 },

  // Channel + FAQ accents (small)
  { url: pexels(7242908, 600),  dest: 'public/images/ambient/dispatcher-desk.webp', w: 600, q: 72 },
  { url: pexels(5025513, 600),  dest: 'public/images/ambient/paper-logbook.webp',   w: 600, q: 72 }
];

const ALTERNATES = {
  1267338: [2199293, 906494, 93398],
  1427541: [2547565, 2058472, 906494],
  906494:  [93398, 1267338, 2547565],
  2547565: [906494, 93398, 2058472],
  93398:   [2547565, 906494, 2058472],
  2058472: [2547565, 93398, 906494],
  7242908: [3760529, 1181675, 1181271],
  5025513: [3057960, 590493, 7235805]
};

async function fetchBuf(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (r.status === 404) return null;
    } catch (e) { /* retry */ }
  }
  return null;
}

async function placeholder(dest, w, q) {
  await mkdir(dirname(dest), { recursive: true });
  await sharp({ create: { width: w, height: Math.round(w * 0.5), channels: 3, background: { r: 30, g: 38, b: 26 } } })
    .webp({ quality: q })
    .toFile(dest);
}

let ok = 0, fb = 0;
for (const img of MANIFEST) {
  await mkdir(dirname(img.dest), { recursive: true });
  const name = img.dest.split('/').pop();
  let buf = await fetchBuf(img.url);
  if (!buf) {
    const idMatch = img.url.match(/photos\/(\d+)\//);
    const primId = idMatch ? Number(idMatch[1]) : null;
    const alts = primId ? (ALTERNATES[primId] || []) : [];
    for (const altId of alts) {
      const altUrl = `https://images.pexels.com/photos/${altId}/pexels-photo-${altId}.jpeg?auto=compress&cs=tinysrgb&w=${img.w}`;
      console.log(`  ↻ alt ${altId} for ${name}`);
      buf = await fetchBuf(altUrl);
      if (buf) break;
    }
  }
  if (buf) {
    try {
      await sharp(buf).rotate().resize({ width: img.w, withoutEnlargement: true }).withMetadata(false).webp({ quality: img.q }).toFile(img.dest);
      console.log(`  ✓ ${img.dest}`);
      ok++;
    } catch (e) {
      console.warn(`  ⚠ sharp failed for ${name}: ${e.message}`);
      await placeholder(img.dest, img.w, img.q);
      fb++;
    }
  } else {
    console.warn(`  ✗ all URLs failed for ${name}`);
    await placeholder(img.dest, img.w, img.q);
    fb++;
  }
}
console.log(`\nDone: ${ok} fetched, ${fb} placeholders.`);
