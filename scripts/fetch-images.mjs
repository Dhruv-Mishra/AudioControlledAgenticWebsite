#!/usr/bin/env node
// scripts/fetch-images.mjs — Download + convert hero, carrier, ambient,
// and empty-state images to WebP via sharp.
//
// Usage:  npm run fetch:images
// Requires: npm i -D sharp   (Node 20+)

import sharp from 'sharp';
import { mkdir, access } from 'node:fs/promises';
import { dirname } from 'node:path';

// Pexels hot-link helper.
const pexels = (id, w = 1200) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${w}`;

// ── MANIFEST ────────────────────────────────────────────────
// Each entry: { url, dest, w (resize width), q (webp quality) }
const MANIFEST = [
  // Hero — aerial semi-trucks on interstate at dusk
  { url: pexels(2199293, 1600), dest: 'public/images/hero/interstate-dusk.webp', w: 1600, q: 72 },

  // Carrier thumbs (8 distinct trucks)
  { url: pexels(2199293, 480),  dest: 'public/images/carriers/peterbilt-579.webp',       w: 480, q: 75 },
  { url: pexels(1267338, 480),  dest: 'public/images/carriers/kenworth-w990.webp',       w: 480, q: 75 },
  { url: pexels(5025513, 480),  dest: 'public/images/carriers/freightliner-cascadia.webp', w: 480, q: 75 },
  { url: pexels(2684219, 480),  dest: 'public/images/carriers/volvo-vnl.webp',           w: 480, q: 75 },
  { url: pexels(1427541, 480),  dest: 'public/images/carriers/flatbed-steel.webp',       w: 480, q: 75 },
  { url: pexels(1367269, 480),  dest: 'public/images/carriers/dry-van-dock.webp',        w: 480, q: 75 },
  { url: pexels(4246120, 480),  dest: 'public/images/carriers/tanker-fuel.webp',         w: 480, q: 75 },
  { url: pexels(3802510, 480),  dest: 'public/images/carriers/kenworth-t680.webp',       w: 480, q: 75 },

  // Generic fallback carrier image
  { url: pexels(2199293, 480),  dest: 'public/images/carriers/truck-generic.webp',       w: 480, q: 75 },

  // Empty state — loading dock
  { url: pexels(1267338, 1200), dest: 'public/images/ambient/loading-dock.webp',         w: 1200, q: 70 },

  // Map side panel ambient — port container yard
  { url: pexels(1427541, 240),  dest: 'public/images/ambient/port-yard.webp',            w: 240, q: 70 },
];

// ── Alternate Pexels IDs to try if the primary 404s ─────────
const ALTERNATES = {
  2684219: [906494, 1117211, 93398],
  1427541: [2547565, 2058472, 1117211],
  1367269: [906494, 2547565, 93398],
  4246120: [2058472, 906494, 1117211],
  3802510: [93398, 2547565, 906494],
};

async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 404) return null;
      if (i < retries) continue;
      return null;
    } catch (err) {
      if (i >= retries) {
        console.warn(`  ⚠ Network error for ${url}: ${err.message}`);
        return null;
      }
    }
  }
  return null;
}

async function generatePlaceholder(dest, w, q) {
  await mkdir(dirname(dest), { recursive: true });
  // Dark grey solid — visually unobtrusive placeholder
  await sharp({
    create: {
      width: w,
      height: Math.round(w * 0.667),
      channels: 3,
      background: { r: 42, g: 50, b: 38 },
    },
  })
    .webp({ quality: q })
    .toFile(dest);
}

let ok = 0;
let fallback = 0;
let failed = 0;

for (const img of MANIFEST) {
  await mkdir(dirname(img.dest), { recursive: true });
  const shortName = img.dest.split('/').pop();

  // Try primary URL
  let buf = await fetchWithRetry(img.url);

  // Try alternates if primary 404d
  if (!buf) {
    const idMatch = img.url.match(/photos\/(\d+)\//);
    const primaryId = idMatch ? Number(idMatch[1]) : null;
    const alts = primaryId && ALTERNATES[primaryId];
    if (alts) {
      for (const altId of alts) {
        const altUrl = `https://images.pexels.com/photos/${altId}/pexels-photo-${altId}.jpeg?auto=compress&cs=tinysrgb&w=${img.w}`;
        console.log(`  ↻ Trying alternate ${altId} for ${shortName}...`);
        buf = await fetchWithRetry(altUrl, 1);
        if (buf) break;
      }
    }
  }

  if (buf) {
    try {
      await sharp(buf)
        .rotate()
        .resize({ width: img.w, withoutEnlargement: true })
        .withMetadata(false)
        .webp({ quality: img.q })
        .toFile(img.dest);
      console.log(`  ✓ ${img.dest}`);
      ok++;
    } catch (err) {
      console.warn(`  ⚠ sharp failed for ${shortName}: ${err.message} — generating placeholder`);
      await generatePlaceholder(img.dest, img.w, img.q);
      fallback++;
    }
  } else {
    console.warn(`  ✗ All URLs failed for ${shortName} — generating placeholder`);
    await generatePlaceholder(img.dest, img.w, img.q);
    fallback++;
  }
}

console.log(`\nDone: ${ok} fetched, ${fallback} placeholders, ${failed} failed.`);
if (fallback > 0) {
  console.log('Re-run with different Pexels IDs to replace placeholders.');
}
