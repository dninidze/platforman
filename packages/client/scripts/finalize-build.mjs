// Rename the single-file build to dist/last-tile-standing.html (spec §0.2) and fail if anything still points at the network.
import { readFileSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../../../dist/', import.meta.url));
renameSync(`${dist}index.html`, `${dist}last-tile-standing.html`);
const html = readFileSync(`${dist}last-tile-standing.html`, 'utf8');
const external = [...html.matchAll(/<(?:script|link|img|source|audio|video)[^>]*(?:src|href)=["'](?!data:|blob:|#)([^"']+)["']/gi)].map((m) => m[1]);
if (external.length) {
  console.error('external references left in last-tile-standing.html:', external);
  process.exit(1);
}
const kb = statSync(`${dist}last-tile-standing.html`).size / 1024;
console.log(`dist/last-tile-standing.html: ${kb.toFixed(0)} KB, no external src/href references`);
if (kb > 2048) {
  console.error('last-tile-standing.html is larger than the 2 MB target');
  process.exit(1);
}
