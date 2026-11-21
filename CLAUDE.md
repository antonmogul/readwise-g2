# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Even Hub app for Even Realities G2 smart glasses that surfaces the user's
Readwise Reader library. One codebase, two surfaces: the glasses HUD (576×288,
driven through the SDK bridge) and the phone companion (the Even Hub webview).
Both are served from the same `index.html`.

Read `README.md` first — it carries the product argument and a "Things that cost
real time to discover" section that is the accumulated cost of debugging against
real hardware. Do not re-derive those findings.

## Commands

```bash
npm run dev          # vite on :5173 (host 0.0.0.0 so the glasses can reach it)
npm run sim          # simulator against :5173, automation API on :9898
npm run sim:glow     # ...with glow — how the glasses actually look
npm test             # vitest run — ~600 tests
npm run test:watch
npm run build        # tsc && vite build
npm run pack         # the PUBLIC app: build + app.json → readwise-public.ehpk
npm run pack:private # a personal build with a Brain board: .env.private + app.private.json → readwise-even-hub.ehpk
npm run qr           # QR to load the dev URL on-device
npm run standin      # scripts/standin.mjs — local Readwise + Brain on :4999
```

Single test file / single test:

```bash
npx vitest run src/glass/nav.test.ts
npx vitest run -t 'clamps at the last page'
```

Driving it locally without burning the 20 req/min budget — run `npm run standin`
and point at it (these are read at **build** time, so a packaged `.ehpk` can
only reach readwise.io). The stand-in logs every request, so progress and
archive writes can be checked; `ASK_DELAY_MS` sets how slow the Brain is:

```bash
VITE_READWISE_BASE=http://127.0.0.1:4999/api/v3 \
VITE_BOARD_BASE=http://127.0.0.1:4999 \
VITE_READWISE_TOKEN=dev-token \
npx vite --host 0.0.0.0
```

## Two apps, one codebase

This repository is public. Nothing personal is committed: a personal board's
URL lives in the untracked `.env.private`, its manifest in the untracked
`app.private.json` (start from the `*.example` files).

- **Public "Readwise"** — `app.json`, `com.antonmorrison.reader`, `npm run pack`.
  The default build: no `VITE_BOARD_BASE`, so `src/build.ts` has no board — no
  Ask row or menu item, no microphone; AI only with the reader's own Claude key.
  `scripts/pack.mjs` refuses a public bundle containing `.ts.net`, `:4317`, the
  host in `.env.private`, or dev values, and a manifest asking for the mic.
- **A personal build** — `npm run pack:private` (`vite build --mode private`
  reads `VITE_BOARD_BASE` from `.env.private`; manifest `app.private.json`).
  Adds a Brain board over Tailscale: voice Ask, board summaries, microphone.
  Anton's is `com.antonmorrison.readwise`.
- Tests run as a personal build (`vitest.config.ts` sets a placeholder
  `VITE_BOARD_BASE`); `build.public.test.ts` clears it to test the default.
- Anything private-only must be gated on `boardEnabled()` so the bundler drops
  it from the public build.

## Architecture

**`src/main.ts` is the only file that may import `@evenrealities/even_hub_sdk`**
(`main-gestures.ts` imports the `OsEventTypeList` enum only). This is the load-
bearing invariant of the whole codebase: everything else is pure, so all
tests run in a `node` vitest environment with no hardware, no network and no
clock. Do not import the SDK into `glass/`, `readwise/`, `brain/` or `phone/`.

```
src/
  main.ts            glasses shell — bridge, render, gesture dispatch, top-level await
  main-gestures.ts   gesture decoding, split out so it CAN be tested
  app.ts             fetch + cache + offline story; impure but fully injected (AppDeps)
  readwise/          client.ts (Reader API) · views.ts (the three views) ·
                     extract.ts (html→text) · store.ts (KV mechanics) ·
                     storage.ts (which KV each key gets) · token.ts (the token)
  brain/             summarise.ts (summaries) · digest.ts (Feed triage) ·
                     library.ts (spoken questions: transcribe → search → answer) ·
                     ask.ts (one model call: the reader's Claude key, else the
                     board) · claude.ts (direct Anthropic call, SDK lazy-loaded) ·
                     settings.ts (the Claude key + model, durable)
  voice/utterance.ts mic frames → a question; the pause detector
  voice/ask.ts       the asking flow's pure decisions (what counts as a question)
  glass/             layout.ts (geometry + budget validation) · sheets.ts (long
                     text → firmware-scrolled sheets) · screens.ts (screens as
                     data) · nav.ts (gesture reducer) · diff.ts (same / upgrade
                     in place / rebuild — decided from the screen data)
  phone/             views.ts (decisions) · render.ts (DOM) · app.ts (controller) ·
                     tokens.ts (official Even Hub design tokens)
```

Data flow, glasses: `nav.step(route, ctx, gesture)` is a pure reducer returning
`{ route, effect }`. `main.ts` renders the new route immediately (so the HUD
feels instant), then performs the effect. Effects are *described* by `nav.ts`
and *executed* by `main.ts` — never perform IO inside the reducer.

`app.ts` takes an `AppDeps` (`readwise`, `kv`, `now`, and optional `boardBase` /
`fetchImpl` / `rand`). Both shells build their own; tests pass fakes. Add
dependencies to `AppDeps` rather than importing globals.

## Constraints that shape the code

These are cross-file couplings; changing one side without the other breaks the
display silently.

- **Rate limit is the design constraint**, not a footnote: 20 req/min on
  list/text, 50/min on update. The library is fetched once and served from a
  15-minute cache (`store.ts`); summaries cache forever. **Nothing polls.**
  Never add a background refresh, and never refetch to reflect a local mutation
  (see `archiveArticle` — it prunes optimistically).
- **Firmware line height is a fixed 27px, and border + padding are drawn INSIDE
  the container.** `LINE`/`boxHeight(n, padding, border)` in `glass/layout.ts`
  encode it; `screen()` throws when a text area is not a whole number of lines,
  because the firmware answers with a scrollbar (every 2-line card had one until
  2026-10-29). The reading sheet (`SHEET`) is exactly 10 × 27 = 270px with zero
  padding: any other height shows a half-cut line, any padding a sliver of the
  previous line once scrolled. A NON-capture container that overflows does not
  clip — it prints over what is below.
- **Text is measured, not counted.** `fitPx`/`wrapLines` use
  `@evenrealities/pretext` (the firmware font's advance widths). Never truncate
  by character count: capitals are twice the width of an `i`.
- **Reading screens are sheets the firmware scrolls.** Summary and reader are ONE
  full-width capture container each. The firmware scrolls it a line per swipe
  with no event; `SCROLL_BOTTOM`/`SCROLL_TOP` reach the app only for a swipe made
  when already at that edge, and the reducer turns the sheet (`glass/sheets.ts`
  cuts text at paragraph → sentence → word boundaries). Positions are stored as
  a FRACTION of the text, never a sheet index.
- **Every rebuild resets the scroll to the top.** `draw()` skips a screen
  identical to the one up, and `handleGesture` draws nothing for a no-op step.
  Anything that re-renders a reading screen without changing it would otherwise
  throw the reader back up the sheet.
- **Summaries are asked for, never assumed.** Opening an article (and the
  next one after an archive) loads its text only; the front page shows a free
  `articlePreview` (publisher's blurb, else the opening), labelled as such. Only
  the `summarise` gesture (menu `Summarise`, `MENU.summarise`) or the
  phone's button asks the Brain. Each ask is a Claude run on the mini; asking on
  every open started one per row swiped through (2026-11-19). A failed ask is
  not shown as the summary — the preview stays and the offer remains.
- **`SUMMARY_MAX = 1400`** in `brain/summarise.ts` is a ceiling to stop a summary
  becoming the article, not a screen budget — the summary scrolls.
- **Text brightness is per container, 0–4** (`textColor`, SDK 0.0.14+, Even App
  2.2.9+; `TEXT` in `layout.ts`). Header/footer are furniture (2), the focused
  row is 4, a door with nothing behind it is quiet (1). It cannot vary within a
  container, so a notice line inside a sheet is told apart by its glyph
  (`□` pending · `■` done · `○` failed), not its weight. The simulator renders
  the levels; legibility of 1–2 on the glasses is not photometrically matched
  (glasses-ui skill) — nothing that must be read sits below 3. `INK` is borders.
- **Glyphs that render** (even-g2-notes display.md; pretext `getAdvW` > 0):
  `● ○ ◐ ◎ ■ □ ▲ ▼ ▶ ▷ ▽ ★ ☆ ← → ━ ─ │ ╭╮╯╰ ▁▂▃▄▅▆▇█ ‹ › “ ” — …`. Not in the
  font (silently dropped): `✓ ✔ ✗` and the Dingbats, `⌛ ⏳`, emoji, braille,
  `░ ▓ ▀`. Home marks are `MARK` in `screens.ts`; verified in simulator 0.9.5
  on 2026-10-29. No image containers: each is a placeholder after every rebuild
  and costs a 0.5–2s BLE frame, and every focus move is a rebuild.
- **Screen budget:** max 8 text containers, exactly one `isEventCapture: 1`,
  `containerName` ≤ 16 chars, content ≤ 999 UTF-8 BYTES (not the 1,000/2,000
  characters the docs claim — the simulator rejects more), inside the canvas,
  text areas a multiple of 27px. `screen()` throws on violation — build every
  screen through it so the failure lands in a test, not on-device.
- **Footers and closing lines share one grammar** (`hint()`/`HINT` in
  `layout.ts`): gesture then verb, middle dots, no colons — `Swipe · Press open ·
  Tap-hold menu · Double back`. The menu is TAP-then-hold; never write `Hold menu`.
- **Home is five equal tile slots**; the dashboard is slot 0 and scrolls away
  like a row. Nothing on Home may change height between focus positions.
- **Focus is content and brightness, never geometry.** The focused row carries
  a `▶ ` cursor (25px) at `textColor` 4; the others a 25px pad at 3; every tile
  and card keeps the same 1px dim border. `textContainerUpgrade` can change
  only `content` and `textColor` (SDK 0.0.16 typings), so `draw()` moves focus
  in place via `diffScreens()` (`glass/diff.ts`) — 'same' draws nothing,
  'upgrade' when only content/brightness differ with identical geometry,
  borders, capture and menu, 'rebuild' otherwise. A refused or timed-out
  upgrade falls back to a rebuild. Never express focus as a border again.
- **The contextual menu never repeats the page.** Home's menu is `Ask your
  library` + `Refresh library`; elsewhere the section items use the Home rows'
  exact names. `Refresh library` is the only way past the 15-minute cache — one
  bounded fetch, not a poll.
- **One write only:** `location=archive`. `reading_progress` is NOT writable
  through the API (PATCH returns 200 and changes nothing — verified live
  2026-09-24); positions live on the device. No highlight creation.
- **Summaries and Feed triage go through `askModel()`** (`brain/ask.ts`). With
  the reader's own Claude key (phone Settings, `rw.claude`) it calls Anthropic
  directly from the webview via `@anthropic-ai/sdk` with
  `dangerouslyAllowBrowser` — `api.anthropic.com` allows browser origins
  (checked 2026-11-20); the SDK sends the key as `Authorization: Bearer`. No
  tools, instructions as `system`, stranger-written text as the user turn,
  `fallbacks: 'default'` on Opus/Sonnet. The SDK is ~380 KB and is
  `import()`ed on first use — keep it out of the main bundle. Never ship a key
  in a package: the key is the reader's, entered on the phone. Without a key it
  asks the board. No `VITE_BOARD_BASE` (`boardEnabled()` false) is the public
  build: no board, so Summarise is offered only with a key, and `askModel`
  refuses rather than sending anything. Voice Ask stays
  board-only (speech-to-text runs on the mini; Readwise's MCP search refuses
  browser preflights, 405).
- **Every Brain call goes through `ASK_PATH`** (`/api/ask?provider=claude&mode=text`).
  Without `provider` the board answers 400 and summaries silently fall back to
  extracts; without `mode=text` Claude gets the vault plus file/web tools while
  reading text written by strangers. The board is a separate project, not in
  this repo; check that the one you point at honours `mode=text` (no tools, no
  saved session) before trusting it — a board that ignores it runs every ask as
  a full agent with tools.
- The feed digest (10,000 items) is **phase 2** and must not expand phase 1.

## Storage

**The webview's `localStorage` does not survive the Even Hub app closing.**
Anything kept only there is gone by the next launch — this is what made the app
ask for the token every time, and it meant the offline story and resume could
not actually hold. Durable storage is the host's, via
`bridge.get/setLocalStorage`.

`store.ts` owns the mechanics (`memoryKV`, `localKV`, `hostKV`, `layeredKV`,
`debouncedKV`) and the key names. `storage.ts` owns the *policy* — which KV each
key gets:

| Data | Policy | Why |
|---|---|---|
| Token | write-through | one short string; must be right on the first frame |
| Claude key + model | write-through | `durableString` like the token; read on the render path |
| Library cache | write-through | written once per fetch; the blank-page guard |
| Summaries | write-through | rarely written, a full Claude turn to regenerate |
| Reading positions | **debounced ~2s** | written on *every* sheet turn |

Positions are debounced because `savePosition` re-serialises the whole map on
each sheet turn, and a bridge hop per turn makes reading feel laggy. They are
fractions (0..1) under `rw.progress.v2`; the old `rw.progress` held 7-line page
numbers and is deliberately not read. Every deferred
write still hits the `localStorage` mirror **synchronously**, so a pending value
is never the only copy — `savePosition`'s read-modify-write depends on that
ordering, and breaking it would silently keep only the last article's position.
`main.ts` awaits `storage.flush()` on the exit effect, and flushes again on
`SYSTEM_EXIT`/`ABNORMAL_EXIT` — "Close Readwise" in the system menu never
reaches the exit effect.

Both shells take storage as a value: `main.ts` swaps in `withHost(...)` once the
bridge resolves and passes it to the phone via `PhoneHandle.useStorage`. The
phone starts on `localStorageOnly()` because it mounts before the bridge on
purpose — waiting would leave it blank whenever the glasses are not connected.
`layeredKV` backfills from the mirror on read, so values written by older builds
migrate forward rather than being lost.

Tests touching storage need `@vitest-environment happy-dom`; under the default
`node` environment `globalThis.localStorage?.` optional-chains away and the
assertions pass vacuously.

## Gotchas that have already cost time

- **`content` is always null.** `withHtmlContent=true` returns `html_content`.
  Reading the documented field yields an empty reader and *no error*.
- **Ghostreader has no endpoint.** `Doc.summary` is the *publisher's* blurb.
  Never present it as an AI summary; the Brain writes those, and when the
  tailnet is down the fallback is labelled "Extract".
- **Lifecycle events share the click channel.** `sysEvent` carries nine
  `OsEventTypeList` values; decoding anything outside `CLICK_EVENT` /
  `DOUBLE_CLICK_EVENT` as a press means backgrounding the app fires a
  destructive action. `main-gestures.ts` is an allow-list and
  `main.gestures.test.ts` is the only guard — **the simulator cannot reproduce
  this**, so keep that test green.
- **The listener is `onEvenHubEvent`, not `onEvent`.** `onEvent?.()` silently
  no-ops and no gesture ever reaches the app on hardware. The simulator hides it.
- **Bridge calls must be serialised** (`serial()` in `main.ts`) and timed out;
  concurrent render/storage calls can crash the connection.
- **Effects run OFF the input chain.** Awaiting them there meant an uncached
  summary (a Claude turn, up to 95s) froze every gesture, Back included. Only
  the reducer step and the first render are awaited per gesture.
- **Hold is `LONG_PRESS_EVENT` (9); its release (10) must stay inert.** Hold
  archives and opens the next article, so decoding the release would archive
  that one too. Tap-then-hold is the OS menu and never arrives — footers say
  `Tap-hold menu` for that reason. `main.gestures.test.ts` guards both.
- **The microphone is open only on the Listening screen.** `handleGesture`
  closes it when the route leaves that screen by any path; FOREGROUND_ENTER (the
  menu opening), the exits, `visibilitychange` and `pagehide` close it too. A
  late `audioControl(true)` after a cancel is closed again. Frames are copied —
  the SDK may reuse the buffer. `VITE_FAKE_MIC` feeds a recording in the
  simulator; the stand-in serves one at `/dev/mic.pcm`.
- **The docs changelog lags npm.** Per-release SDK notes are in the npm README
  (`npm view @evenrealities/even_hub_sdk readme`). 0.0.16 fixed the SDK's
  shadowed `setTimeout`/`setInterval` firing callbacks twice.
- **The drawn list is state, not a computed value.** `select()` for Surprise
  shuffles, so recomputing per render reorders rows under the focus cursor and
  opens the wrong article. `rows` is drawn once on entering a view from home and
  held; use `pruneRows()` after a mutation.
- **Draw before you fetch.** `main.ts` renders `S.loading()` before the first
  `refresh()`; until 2026-10-29 the glasses showed nothing until the library had
  loaded. With no token the library carries `NO_TOKEN` and `S.welcome()` is
  shown — nothing is sent to Readwise.
- **The publisher's `<h1>` repeats the title.** `dropLeadingTitle` in
  `extract.ts` strips it at load, or the reader's first sheet shows the title
  twice.

## Conventions

- TypeScript is strict-ish via `verbatimModuleSyntax`, `noUnusedLocals`,
  `noUnusedParameters`, `erasableSyntaxOnly`, `noFallthroughCasesInSwitch` —
  use `import type` for types and avoid enums/parameter properties.
- Tests live beside their module as `*.test.ts` and assert screens as data
  (container specs), not rendered pixels. New glasses UI should be expressible
  as a `Screen` and asserted the same way.
- Comments in this codebase explain *why*, usually citing a verified on-device
  observation with a date. Match that: when you discover firmware or API
  behaviour, record it at the point of use rather than in a commit message.
- Phone styling uses `phone/tokens.ts` verbatim from the official Even Hub
  design system. Never hand-pick a grey.
- The Readwise token is entered on-device and stored in `localStorage`
  (`rw.token`). It must never be committed or baked into the `.ehpk`.
