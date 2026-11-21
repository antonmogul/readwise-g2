// Local packaging only. Uploading, promotion and invitations remain separate.
//
//   npm run pack           the public app   app.json         → readwise-public.ehpk
//   npm run pack:private   a personal build app.private.json → readwise-even-hub.ehpk
//
// The personal build reads its Brain board URL from `.env.private` (untracked,
// `vite build --mode private`) and its manifest from `app.private.json`
// (untracked; start from app.private.example.json). Neither is in the repo.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const isPrivate = process.argv.includes('--private');
const root = new URL('..', import.meta.url);
const at = (path) => new URL(path, root);
const readJSON = (path) => JSON.parse(readFileSync(at(path), 'utf8'));
const manifestFile = isPrivate ? 'app.private.json' : 'app.json';
const out = isPrivate ? 'readwise-even-hub.ehpk' : 'readwise-public.ehpk';
if (!existsSync(at(manifestFile))) {
  throw new Error(`${manifestFile} not found — copy app.private.example.json and fill in your board`);
}
const manifest = readJSON(manifestFile);
const pkg = readJSON('package.json');
const sdk = readJSON('node_modules/@evenrealities/even_hub_sdk/package.json');

if (manifest.min_sdk_version !== sdk.version || pkg.dependencies['@evenrealities/even_hub_sdk'] !== sdk.version) {
  throw new Error('Pin the installed SDK version in both package.json and the manifest before packing');
}

/** The personal board's host, from the untracked .env.private, so the check names no host itself. */
function privateBoardHost() {
  if (!existsSync(at('.env.private'))) return null;
  const line = readFileSync(at('.env.private'), 'utf8').split('\n').find((l) => l.startsWith('VITE_BOARD_BASE='));
  const url = line?.slice('VITE_BOARD_BASE='.length).trim();
  try { return url ? new URL(url).hostname : null; } catch { return null; }
}

// Nothing dev-only may ship in any build. The public build also must carry no
// board at all: no Tailscale host, no board port, and not this machine's own
// board host — which is what proves it was built without VITE_BOARD_BASE.
const forbidden = ['dev-token', '127.0.0.1:4999', 'localhost:4999'];
if (!isPrivate) {
  forbidden.push('.ts.net', ':4317');
  const host = privateBoardHost();
  if (host) forbidden.push(host);
}
const assets = at('dist/assets/');
for (const file of readdirSync(assets)) {
  const text = readFileSync(new URL(file, assets), 'utf8');
  const hit = forbidden.find((s) => text.includes(s));
  if (hit) throw new Error(`dist/assets/${file} contains "${hit}" — refusing to pack ${out}`);
}
if (!isPrivate && manifest.permissions.some((p) => p.name === 'g2-microphone')) {
  throw new Error('The public app has no voice Ask; it must not ask for the microphone');
}

// CLI 0.2 otherwise derives compatibility from npm latest, which may be a
// different SDK from the one this bundle actually uses.
execFileSync(new URL('node_modules/.bin/evenhub', root).pathname, [
  'pack', manifestFile, 'dist', '--sdk-ver', sdk.version, '-o', out,
], { stdio: 'inherit', cwd: root });
