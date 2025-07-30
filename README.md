# Perpetualpulse Lighter Trading Metrics Extension

## Summary

A lightweight browser extension that injects real-time trading metrics—including long/short exposure and leverage stats—directly into the [Lighter.xyz](https://lighter.xyz) trading interface.
Also supports hotkeys

## Metrics

- **Live summary:** Shows your total long/short portfolio exposure, leverage ratios, and count of positions.
- **Automatic refresh:** Updates automatically when you open new trades, close positions, or refresh the page—no manual reload required.
- **Non-intrusive:** Integrates cleanly into the existing account overview panel, with no external dependencies.
- **Show/Hide Values**: Toggle visibility of the metrics with a single click.

## What It Does

Once loaded on [Lighter.xyz](https://lighter.xyz), this extension adds a summary under your Account Overview:

- **Long vs Short:** Dollar exposure on both sides.
- **L/S Ratio:** Relative size of longs to shorts.
- **Exposure vs Portfolio:** Leverage vs portfolio value, with average leverage.
- **Net Leverage:** Overall leverage across all positions.
- Updates live as your positions change.

## Hotkey Controls

Speed up trading with built-in keyboard shortcuts:

| Action                       | Mac Shortcut | Windows/Linux Shortcut |
|------------------------------|--------------|-----------------------|
| Switch to Market tab         | ⌥ + M        | Alt + M               |
| Switch to Limit tab          | ⌥ + L        | Alt + L               |
| Switch to Buy side           | ⌥ + B        | Alt + B               |
| Switch to Sell side          | ⌥ + S        | Alt + S               |
| Execute trade (in Amount input) | Enter   | Enter                 |
| **Show/hide hotkey badges**  | **Double-tap Option** | **Double-tap Alt**  |


- **Badges**: Hotkey hints appear next to each tab or side button for your operating system (⌥ for Mac, Alt for Windows/Linux) while you hold Option/Alt.
- **Focus**: After any tab or side hotkey, your cursor jumps to the Amount input—just type your size.
- **One-touch trading**: Press **Enter** while the Amount input is focused to immediately place your order (if the Place Order button is enabled).

### Example Workflow

1. **Hold Option/Alt** to see hotkey badges.
2. Press **M/L/B/S** to switch order type or side.
3. Type your amount.
4. Press **Enter** to trade.

---

## Manual Installation (Chrome, Edge, Brave, etc.)

1. **Download the extension ZIP** and unzip it to a folder on your computer.
2. Open your browser and go to `chrome://extensions` (or menu > Extensions).
3. **Enable “Developer mode”** (toggle in the top-right).
4. Click **“Load unpacked”** and select the folder you just unzipped.
5. Visit [https://lighter.xyz](https://lighter.xyz) — the metrics will appear automatically.

**To update:** Simply remove the old version and repeat with your latest code.
