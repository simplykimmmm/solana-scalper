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
