# Store kit — Readwise (public app)

- `listing.md` — every field the Even Hub portal asks for, with limits.
  `node scripts/check-listing.mjs` checks lengths and that `app.json`
  matches; `--write` copies the tagline and description into it.
- `icon/icon-book.png` (recommended) · `icon/icon-glasses.png` · `icon/icon-list.png`
  — 24×24, #F4F4F4 on transparent, 2×2 blocks. `python3 scripts/store-icons.py docs/store/icon`
  redraws and re-checks them; `icon-options.png` previews all three.
- `cover-1920x1080.png`, `cover-1200x600.png` — greyscale background.
- `screenshots/` — raw simulator frames (demo library).
- `privacy.md`, `terms.md` — the privacy policy and terms, published with GitHub Pages.
