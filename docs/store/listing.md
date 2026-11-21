# Store listing — Readwise (public app)

Everything the Even Hub portal asks for, in the order it asks. Limits are from
the Even Hub docs (docs/cli/apps, docs/ship/app-submission, checked 2026-11-21);
`scripts/check-listing.mjs` re-checks the lengths.

| Field | Value |
|---|---|
| Package ID | `com.antonmorrison.reader` (permanent once released) |
| Name (≤ 20) | Readwise |
| Version | 0.1.0 |
| Languages | en |

## 1. Contact information

| Field | Value | Note |
|---|---|---|
| Developer name (≤ 25) | Anton Morrison | |
| Contact email (≤ 50) | anton.morrison@gmail.com | Shown publicly on the app page. |
| Contact telephone (≤ 20) | (leave blank) | optional |
| Contact address (≤ 100) | (leave blank) | optional |

## 2. App icon

`docs/store/icon/icon-book.png`, 24×24, `#F4F4F4` on transparent, every lit
pixel in a 2×2 block (checked by `scripts/store-icons.py`). An open book with
lines of text, our own drawing, not Readwise's logo, which the rules forbid
without permission. Alternative: `icon-glasses.png`. Previews:
`icon-options.png`.

## 3. Cover and screenshots

- Cover / background (greyscale only): `docs/store/cover-1920x1080.png` or
  `cover-1200x600.png`, the Home screen as the glasses show it.
- Screenshots, straight from the simulator as the rules require:
  `docs/store/screenshots/01-home.png` … `08-feed-sorted.png`.

## 4. Tagline (≤ 50)

Your Readwise Reader library on your glasses

## 5. Description (≤ 2,000)

<!-- description:start -->
Take your Readwise Reader library on the road. I have used Readwise for years, and my saved-for-later list grew faster than I could ever sit down and read it. So I built this to read it on my glasses: glance at what arrived, decide what is worth your time, and read in the moments in between.

WHAT YOU CAN DO
• Browse Recently added, Quick reads under 5 minutes, your Feed, Continue reading, Long reads and Surprise me
• Open an article on a preview (the publisher's note or its opening) and decide whether to read it
• Read the full article on the glasses. Your place is saved as you go, so you can pick up where you left off
• Hold to archive in Readwise and move straight on to the next article
• Use the phone companion to search, filter and read the full text

AI SUMMARIES (OPTIONAL)
AI summaries and Feed sorting are written by Claude, using your own Anthropic API key, which you add in Settings. You choose the model: Claude Opus, Sonnet or Haiku. Opening an article never uses AI. You ask for a summary from the menu, and it is kept, so you only pay for it once.

Why not Ghostreader? Readwise's own AI, Ghostreader, is not available through the Readwise API, so the app brings its own. If Readwise makes Ghostreader available to apps, this one will use it.

WHAT YOU NEED
• A Readwise Reader account and your access token from readwise.io/access_token
• Optional: an Anthropic API key from console.anthropic.com, for AI summaries

PRIVACY
Your Readwise token and Claude key stay on your phone. The app talks only to Readwise and, if you add a key, to Anthropic. There is no server in between, no account to create, and no tracking.

An independent app by a long-time Readwise user. Not made by or affiliated with Readwise.
<!-- description:end -->

## 6. Permissions

Declared in `app.json`: **network** only, limited to
`https://readwise.io` and `https://api.anthropic.com`. No microphone, location,
camera or photos.

> Reads your Readwise Reader library with your access token. If you add a Claude
> API key, sends an article you ask to summarise, or your Feed headlines, to
> Anthropic. Nothing goes to any other server.

## 7. Privacy and terms

- Privacy policy: `docs/store/privacy.md` (covers the one permission and both
  domains, as review requires).
- Terms of use: `docs/store/terms.md`.
- The portal's format (URL or pasted text) is not documented. Both read as plain
  text if pasted; for a URL they need a public home (see the open-source note).

## Release notes, version 0.1.0 (1–3 lines)

<!-- release:start -->
Read your Readwise Reader library on G2: browse, preview, read full articles with your place saved, and hold to archive. Optional AI summaries with your own Claude key.
<!-- release:end -->

## Build changelog (≤ 500)

Same text as the release notes.

## Before submitting

- [ ] Readwise's written OK to use the name "Readwise". The rules forbid
      impersonating existing apps and using brand logos without permission.
      Fallback name: "Reader for Readwise".
- [ ] Privacy policy and terms hosted, if the portal wants URLs.
- [ ] Beta on real glasses: locked phone for 5 minutes, root double-tap exit,
      first run with no token, and one real Claude summary.
