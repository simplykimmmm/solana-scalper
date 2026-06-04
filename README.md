# Solana Scalper

Solana scalping bot with DexScreener discovery, Gemini scoring, Jupiter swaps, and a local P&L dashboard.

## Setup

```bash
npm install
copy .env.example .env
npm start
```

Keep `SIMULATION_MODE=true` while testing. Set `PRIVATE_KEY` only in your local `.env` file, never in source control.

## Configuration

The app reads runtime settings from `.env` and safe defaults in `config.js`.

Required for AI scoring:

```text
GEMINI_API_KEY=your_gemini_key_here
```

Required for live trading:

```text
SIMULATION_MODE=false
PRIVATE_KEY=your_wallet_private_key
```

Use a dedicated wallet with limited funds. Live memecoin trading is high risk.

## Remote dashboard

The hosted dashboard source lives in `remote-dashboard/`. The root `vercel.json` makes Vercel serve that dashboard even if the GitHub integration is pointed at the repository root. The trading bot, wallet key, scanning, scoring, and swapping stay on this laptop.

Vercel environment variables:

```text
REMOTE_BRIDGE_TOKEN=a-long-random-token-you-choose
KV_REST_API_URL=from Vercel KV or Upstash Redis
KV_REST_API_TOKEN=from Vercel KV or Upstash Redis
```

The API also accepts Upstash's native names:

```text
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Local `.env` variables:

```text
REMOTE_BRIDGE_URL=https://your-vercel-app.vercel.app
REMOTE_BRIDGE_TOKEN=the-same-long-random-token
REMOTE_BRIDGE_AGENT_ID=laptop-main
REMOTE_BRIDGE_POLL_MS=3000
```

Open the Vercel URL, enter the bridge token in the dashboard, and the page will show the latest laptop status. Start/Stop pauses or resumes new scans and buys; the local Node process must stay running for remote control to work. The top-up panel shows the wallet public address so you can send SOL to it from an exchange or wallet. If `PRIVATE_KEY` is missing and the bot generated a temporary simulation wallet, top-up copying is disabled.
