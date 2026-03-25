// hl-hotkeys.js — Hotkeys for Hyperliquid (⌥+M, ⌥+L, ⌥+B, ⌥+S, ⌥+A → Pro, ⌥+T → TWAP)
// Depends on platform.js

(function () {
    "use strict";

    if (window._PP_currentPlatform !== "hyperliquid") return;

    console.log("[Perpetualpulse] Hyperliquid hotkeys active");

    const isMac = /Mac/i.test(navigator.platform);
    const cfg = window._PP_config;

    function focusAmountInput() {
        const inp = cfg.getAmountInput();
        if (inp) { inp.focus(); inp.select?.(); }
    }

    function attachEnterForOrder() {
        const inp = cfg.getAmountInput();
        if (inp && !inp._pp_enter) {
            inp.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") {
                    const btn = cfg.getPlaceOrderBtn();
                    if (btn && !btn.disabled) btn.click();
                }
            });
            inp._pp_enter = true;
        }
    }

    const keyBadge = (key) => (isMac ? `⌥+${key}` : `Alt+${key}`);

    function switchToTab(tabFn) {
        const btn = tabFn();
        if (btn) {
            setTimeout(() => {
                btn.click();
                setTimeout(() => { focusAmountInput(); attachEnterForOrder(); }, 150);
            }, 0);
        }
    }

    function switchToSide(sideFn) {
        const row = cfg.getBuySellRow();
        if (!row) return;
        // HL buy/sell are child divs with text, not buttons — click the text container
        const children = Array.from(row.querySelectorAll("div[font-size], div[class*='fbYMXx']"));
        if (children.length === 0) {
            // Fallback: any clickable children
            const allChildren = Array.from(row.children);
            const target = sideFn(allChildren);
            if (target) {
                setTimeout(() => {
                    target.click();
                    setTimeout(() => { focusAmountInput(); attachEnterForOrder(); }, 150);
                }, 0);
            }
            return;
        }
        const target = sideFn(children);
        if (target) {
            setTimeout(() => {
                target.click();
                setTimeout(() => { focusAmountInput(); attachEnterForOrder(); }, 150);
            }, 0);
        }
    }

    // Hotkey labels
    function showHotkeyLabels(show) {
        const pairs = [
            [cfg.getMarketBtn, "M", "pp-hk-market"],
            [cfg.getLimitBtn, "L", "pp-hk-limit"],
        ];

        for (const [getFn, key, cls] of pairs) {
            const btn = getFn();
            if (!btn) continue;
            let span = btn.querySelector(`.${cls}`);
            if (show) {
                if (!span) {
                    span = document.createElement("span");
                    span.className = cls;
                    span.innerHTML = ` <span style="margin-left:0.5em;font-size:0.8em;padding:0.1em 0.4em;border-radius:4px;background:rgba(120,120,120,0.08);color:inherit!important;font-weight:400;">${keyBadge(key)}</span>`;
                    btn.appendChild(span);
                }
            } else if (span) {
                span.remove();
            }
        }

        // Buy/Sell labels
        const row = cfg.getBuySellRow();
        if (row) {
            const children = Array.from(row.querySelectorAll("div[font-size], div[class*='fbYMXx']"));
            const buyEl = cfg.findBuyBtn(children);
            const sellEl = cfg.findSellBtn(children);
            for (const [el, key, cls] of [[buyEl, "B", "pp-hk-buy"], [sellEl, "S", "pp-hk-sell"]]) {
                if (!el) continue;
                let span = el.querySelector(`.${cls}`);
                if (show) {
                    if (!span) {
                        span = document.createElement("span");
                        span.className = cls;
                        span.innerHTML = ` <span style="margin-left:0.5em;font-size:0.8em;padding:0.1em 0.4em;border-radius:4px;background:rgba(120,120,120,0.08);color:inherit!important;font-weight:400;">${keyBadge(key)}</span>`;
                        el.appendChild(span);
                    }
                } else if (span) {
                    span.remove();
                }
            }
        }
    }

    let lastAltTap = 0;
    let hotkeysPinned = false;

    document.addEventListener("keydown", (e) => {
        if ((e.key === "Alt" || (isMac && e.key === "Meta")) && !e.repeat) {
            const now = Date.now();
            if (now - lastAltTap < 400) {
                hotkeysPinned = !hotkeysPinned;
                showHotkeyLabels(hotkeysPinned);
            }
            lastAltTap = now;
        }

        if (e.altKey && !e.repeat) {
            if (!hotkeysPinned) showHotkeyLabels(true);
            switch (e.code) {
                case "KeyM":
                    switchToTab(cfg.getMarketBtn);
                    e.preventDefault();
                    break;
                case "KeyL":
                    switchToTab(cfg.getLimitBtn);
                    e.preventDefault();
                    break;
                case "KeyB":
                    switchToSide(cfg.findBuyBtn);
                    e.preventDefault();
                    break;
                case "KeyS":
                    switchToSide(cfg.findSellBtn);
                    e.preventDefault();
                    break;
                case "KeyA":
                    // Open Pro dropdown
                    {
                        const dd = cfg.getAdvancedBtn();
                        if (dd) dd.click();
                    }
                    e.preventDefault();
                    break;
                case "KeyT":
                    // Select TWAP from open dropdown
                    {
                        const twap = cfg.getTwapBtn();
                        if (twap) {
                            twap.click();
                            setTimeout(() => { focusAmountInput(); attachEnterForOrder(); }, 150);
                        }
                    }
                    e.preventDefault();
                    break;
            }
        }
    });

    document.addEventListener("keyup", (e) => {
        if (!e.altKey && !hotkeysPinned) showHotkeyLabels(false);
    });
    window.addEventListener("blur", () => {
        if (!hotkeysPinned) showHotkeyLabels(false);
    });

    setTimeout(attachEnterForOrder, 500);
})();
