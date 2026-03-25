# Perpetualpulse Trading Extension

## Summary

A browser extension that injects real-time trading metrics, live funding rates, and keyboard shortcuts into [Lighter.xyz](https://app.lighter.xyz) and [Hyperliquid](https://app.hyperliquid.xyz) trading interfaces.

## Supported Platforms

| Platform | Metrics | Funding Rates | Hotkeys | Risk Metrics | TV Equation |
|---|---|---|---|---|---|
| **Lighter.xyz** | ✅ | ✅ (WebSocket + REST) | ✅ | ✅ (VaR, Beta, Liq) | ✅ |
| **Hyperliquid** | ✅ | ✅ (REST — perps, vntl, xyz) | ✅ | — | ✅ |

## Features

### Portfolio Metrics (Both Platforms)
- **Long vs Short:** Dollar exposure on both sides
- **L/S Ratio:** Relative size of longs to shorts
- **Long/Short vs Portfolio:** Leverage vs equity, with pair counts
- **Net Leverage:** Overall directional leverage across all positions
- **Show/Hide Values:** Click any metric value to mask it

Metrics update live as positions change.

### Live Funding Rates

**Lighter:**
- WebSocket (`market_stats` channel) for live predicted rates, REST API fallback
- Auto-reconnect with exponential backoff

**Hyperliquid:**
- Fetches from 3 dexes in parallel every 15s:
  - Standard perps (`metaAndAssetCtxs`)
  - Pre-launch/venture assets (`dex: "vntl"` — ANTHROPIC, SPACEX, etc.)
  - HIP-3 equities (`dex: "xyz"` — NVDA, TSLA, GOLD, etc.)
- Displayed inline in the Funding column, color-coded green/red

### Risk Metrics (Lighter Only)
- **Value at Risk (VaR)** — max expected loss over 24H at 95% confidence
- **Net Beta** — weighted portfolio beta relative to BTC
- **Risk of Liquidation** — per-position volatility-based liquidation probability
- Constants auto-extracted from the Lighter frontend bundle on page load

### TradingView Equation (Both Platforms)
- One-click copy of a weighted portfolio equation for TradingView charting
- Top 10 positions by notional, weighted long/short exposure
- Shows the full equation for 2 seconds after copying
- **Lighter:** Uses `SYMBOL^weight` format with USDT pairs
- **Hyperliquid:** Smart ticker mapping:
  - Crypto perps → `BINANCE:BTCUSDT.P`
  - xyz equities (NVDA, TSLA) → native exchange (`NASDAQ:NVDA`)
  - Korean stocks → KRX tickers (`KRX:005930`)
  - Pre-launch/vntl → best-effort fallback

### Hyperliquid UI Enhancements
- **Tighter spacing** — Account Equity and Perps Overview sections condensed (10px → 4px gaps)
- **Buttons on one row** — Deposit, Perps→Spot, and Withdraw flattened to a single line
- **Bluish accent** — injected content uses a distinct hue to separate from native UI

## Hotkey Controls

Same shortcuts on both platforms. On Hyperliquid, ⌥+A opens the **Pro** dropdown (equivalent to Lighter's Advanced).

| Action | Mac | Windows/Linux |
|---|---|---|
| Switch to Market tab | ⌥ + M | Alt + M |
| Switch to Limit tab | ⌥ + L | Alt + L |
| Open Advanced / Pro dropdown | ⌥ + A | Alt + A |
| Select TWAP (when dropdown open) | ⌥ + T | Alt + T |
| Switch to Buy / Long | ⌥ + B | Alt + B |
| Switch to Sell / Short | ⌥ + S | Alt + S |
| Execute trade (in Amount input) | Enter | Enter |
| **Show/hide hotkey badges** | **Double-tap ⌥** | **Double-tap Alt** |

- **Badges**: Hotkey hints appear next to tabs/buttons while holding Option/Alt.
- **Focus**: After any hotkey, cursor jumps to the Amount input.
- **TWAP workflow**: ⌥+A to open dropdown, then ⌥+T to select TWAP.

## Architecture

```
platform.js          — Platform detection & selector abstraction (text-based, no class dependencies)
content.js           — Lighter: metrics, funding (WS+REST), risk, TV equation
hotkeys.js           — Lighter: keyboard shortcuts
volatility.js        — Lighter: volatility column injection
hl-content.js        — Hyperliquid: metrics, funding (3-dex REST), UI tweaks, TV equation
hl-hotkeys.js        — Hyperliquid: keyboard shortcuts
manifest.json        — MV3, content scripts per domain
```

### Selector Strategy
- **Lighter**: Uses `data-testid` attributes (stable across deploys)
- **Hyperliquid**: Uses text content matching (header text, label text, inline style colors) instead of CSS class names which change on each deploy

## Installation

1. Clone or download this repo.
2. Open `chrome://extensions` → enable **Developer mode**.
3. Click **Load unpacked** → select this folder.
4. Visit [app.lighter.xyz](https://app.lighter.xyz/trade) or [app.hyperliquid.xyz](https://app.hyperliquid.xyz/trade) — metrics appear automatically.

**To update:** `git pull` and click the refresh icon on `chrome://extensions`.
