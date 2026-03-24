# Perpetualpulse Lighter Trading Metrics Extension

## Summary

A lightweight browser extension that injects real-time trading metrics, live funding rates, and keyboard shortcuts directly into the [Lighter.xyz](https://lighter.xyz) trading interface.

## Features

### Portfolio Metrics
- **Long vs Short:** Dollar exposure on both sides
- **L/S Ratio:** Relative size of longs to shorts
- **Exposure vs Portfolio:** Leverage vs portfolio value, with pair counts
- **Net Leverage:** Overall directional leverage across all positions
- **TradingView Equation:** One-click copy of a weighted portfolio equation for TradingView charting
- **Show/Hide Values:** Click any metric value to mask it

All metrics update live as positions change — no manual refresh needed.

### Live Funding Rates
- Fetches funding rates from the Lighter API every 30 seconds
- Displays the current funding rate inline in the Funding column of the positions table
- Color-coded: green for positive, red for negative
- Positions table columns automatically adjusted (Size narrowed, Funding widened) to accommodate the extra data

### Risk Metrics
- **Value at Risk (VaR)** — maximum expected loss over 24H at 95% confidence, matching Lighter's quant page calculation
- **Net Beta** — weighted average beta across all positions, indicating overall market risk exposure
- **Risk of Liquidation** — probability of liquidation based on per-position volatility and distance to liquidation price
- Risk constants (volatility, beta, drift per market) are automatically extracted from the Lighter frontend bundle on page load — always in sync with Lighter's own calculations

### Visual Distinction
All extension-injected content uses a slight bluish hue to distinguish it from native Lighter UI elements.

## Hotkey Controls

Speed up trading with built-in keyboard shortcuts:

| Action | Mac | Windows/Linux |
|---|---|---|
| Switch to Market tab | ⌥ + M | Alt + M |
| Switch to Limit tab | ⌥ + L | Alt + L |
| Open Advanced dropdown | ⌥ + A | Alt + A |
| Select TWAP (when dropdown open) | ⌥ + T | Alt + T |
| Switch to Buy side | ⌥ + B | Alt + B |
| Switch to Sell side | ⌥ + S | Alt + S |
| Execute trade (in Amount input) | Enter | Enter |
| **Show/hide hotkey badges** | **Double-tap ⌥** | **Double-tap Alt** |

- **Badges**: Hotkey hints appear next to tabs/buttons while holding Option/Alt.
- **Focus**: After any hotkey, cursor jumps to the Amount input.
- **One-touch trading**: Press **Enter** while Amount input is focused to place your order.
- **TWAP workflow**: Press ⌥+A to open the Advanced dropdown, then ⌥+T to select TWAP.

### Example Workflow

1. **Hold Option/Alt** to see hotkey badges.
2. Press **M/L/B/S** to switch order type or side.
3. Type your amount.
4. Press **Enter** to trade.

---

## Manual Installation (Chrome, Edge, Brave, etc.)

1. **Download the extension ZIP** and unzip it to a folder on your computer.
2. Open your browser and go to `chrome://extensions` (or menu > Extensions).
3. **Enable "Developer mode"** (toggle in the top-right).
4. Click **"Load unpacked"** and select the folder you just unzipped.
5. Visit [https://app.lighter.xyz](https://app.lighter.xyz) — the metrics will appear automatically.

**To update:** Pull latest changes and click the refresh icon on `chrome://extensions`.
