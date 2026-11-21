// Checks docs/store/listing.md against the Even Hub limits and keeps
// app.json's tagline and description identical to it.
//   node scripts/check-listing.mjs          check
//   node scripts/check-listing.mjs --write  copy listing.md into app.json
import { readFileSync, writeFileSync } from 'node:fs';

const md = readFileSync(new URL('../docs/store/listing.md', import.meta.url), 'utf8');
const between = (tag) => md.split(`<!-- ${tag}:start -->`)[1].split(`<!-- ${tag}:end -->`)[0].trim();
const tagline = md.split('## 4. Tagline (≤ 50)')[1].trim().split('\n')[0].trim();
const description = between('description');
const release = between('release');
const manifestUrl = new URL('../app.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));

// Lengths count Unicode code points after trimming (docs/cli/apps).
const len = (s) => [...s.replace(/\r\n?/g, '\n').trim()].length;
const checks = [
  ['name', manifest.name, 20], ['tagline', tagline, 50],
  ['description', description, 2000], ['release notes / changelog', release, 500],
];
let ok = true;
for (const [field, value, max] of checks) {
  const n = len(value);
  console.log(`${n <= max ? 'ok  ' : 'FAIL'} ${field}: ${n}/${max}`);
  if (n > max) ok = false;
}
if (/even/i.test(manifest.name)) { console.log('FAIL name must not contain "Even"'); ok = false; }

if (process.argv.includes('--write')) {
  manifest.tagline = tagline;
  manifest.description = description;
  writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
  console.log('app.json updated from listing.md');
} else if (manifest.tagline !== tagline || manifest.description !== description) {
  console.log('FAIL app.json differs from listing.md — run with --write'); ok = false;
}
process.exit(ok ? 0 : 1);
