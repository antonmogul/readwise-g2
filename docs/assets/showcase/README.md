# Showcase assets

Glasses frames, phone screens, `walkthrough.gif` and `overview.png` for the
public app ("Readwise", com.antonmorrison.reader), captured 2026-11-21 from the
public build (no `VITE_BOARD_BASE`) in the simulator (0.9.5, glow) and a 390px
browser. The library is the stand-in's invented demo content
(`scripts/demo-content.mjs`) — no real publication's words. Summaries come from
the stand-in's `/v1/messages`, shaped like Anthropic's replies.

Re-create:

    DEMO=1 ASK_DELAY_MS=2500 npm run standin
    VITE_READWISE_BASE=http://127.0.0.1:4999/api/v3 \
      VITE_READWISE_TOKEN=dev-token VITE_ANTHROPIC_BASE=http://127.0.0.1:4999 \
      VITE_CLAUDE_SETTINGS='{"apiKey":"dev-token","model":"claude-opus-5-5"}' \
      npx vite --host 0.0.0.0
    npm run sim:glow
    python3 scripts/sim-drive.py <shots-dir> shot=01-home click shot=02-recent …
    python3 scripts/showcase-compose.py <dir-with-shots/> docs/assets/showcase
