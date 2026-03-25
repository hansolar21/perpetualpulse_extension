// platform.js — Platform detection & abstraction layer
// Supports: lighter.xyz, hyperliquid.xyz

(function () {
    "use strict";

    const PLATFORMS = {
        LIGHTER: "lighter",
        HYPERLIQUID: "hyperliquid",
    };

    function detectPlatform() {
        const host = location.hostname;
        if (host.includes("lighter.xyz")) return PLATFORMS.LIGHTER;
        if (host.includes("hyperliquid.xyz")) return PLATFORMS.HYPERLIQUID;
        return null;
    }

    // Platform-specific selectors and behaviors
    const platformConfig = {
        [PLATFORMS.LIGHTER]: {
            // Order type tabs
            getMarketBtn: () => document.querySelector('[data-testid="select-order-type-market"]'),
            getLimitBtn: () => document.querySelector('[data-testid="select-order-type-limit"]'),
            getAdvancedBtn: () => document.querySelector('[data-testid="select-order-type-dropdown"]'),
            getAdvancedLabel: () => "Advanced",
            getTwapBtn: () => document.querySelector('[data-testid="select-order-type-twap"]'),

            // Buy/Sell
            getBuySellRow: () => document.querySelector('div.relative.flex.h-8'),
            findBuyBtn: (btns) => btns.find(b => /buy|long/i.test(b.textContent)),
            findSellBtn: (btns) => btns.find(b => /sell|short/i.test(b.textContent)),

            // Amount input & place order
            getAmountInput: () => document.querySelector('input[data-testid="place-order-size-input"], input[placeholder="0.0"], input[placeholder="0"]'),
            getPlaceOrderBtn: () => document.querySelector('button[data-testid="place-order-button"]'),

            // Positions table
            getPositionsTable: () => document.querySelector('table[data-testid="positions-table"]') || document.querySelector("table"),
            isLongRow: (td0) => !!td0.querySelector('[data-testid="direction-long"]'),
            isShortRow: (td0) => !!td0.querySelector('[data-testid="direction-short"]'),
            getSymbolFromCell: (td0) => {
                const spans = td0.querySelectorAll("span");
                for (const sp of spans) {
                    const txt = (sp.textContent || "").trim();
                    if (txt && /^[A-Za-z0-9]{2,15}$/.test(txt)) return txt;
                }
                return (td0.textContent || "").trim().split(/\s+/)[0] || "";
            },
            positionRowSelector: "tbody tr[data-testid^='row-']",

            // Account section (for injecting metrics)
            getAccountContainer: () => document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto'),

            // Funding rates
            fundingRateSource: "lighter-api", // uses Lighter's funding-rates endpoint + WS

            // Advanced dropdown needs Radix pointer events
            advancedDropdownNeedsPointerEvents: true,
        },

        [PLATFORMS.HYPERLIQUID]: {
            // Order type tabs — text-based, find by content
            getMarketBtn: () => {
                // HL uses sc-AHaJN class tabs with text content
                const tabs = document.querySelectorAll('.sc-AHaJN, [class*="AHaJN"]');
                for (const t of tabs) {
                    if (t.textContent.trim() === "Market") return t;
                }
                return null;
            },
            getLimitBtn: () => {
                const tabs = document.querySelectorAll('.sc-AHaJN, [class*="AHaJN"]');
                for (const t of tabs) {
                    if (t.textContent.trim() === "Limit") return t;
                }
                return null;
            },
            getAdvancedBtn: () => {
                // "Pro" dropdown — find the tab containing "Pro" text
                const tabs = document.querySelectorAll('.sc-AHaJN, [class*="AHaJN"]');
                for (const t of tabs) {
                    if (/^\s*Pro\s*$/i.test(t.textContent.trim()) || t.querySelector('[class*="gikAfH"]')) return t;
                }
                // Fallback: find div with "Pro" text near order type tabs
                const divs = document.querySelectorAll('div');
                for (const d of divs) {
                    if (d.textContent.trim() === "Pro" && d.querySelector('svg')) return d;
                }
                return null;
            },
            getAdvancedLabel: () => "Pro",
            getTwapBtn: () => {
                // After Pro dropdown opens, look for TWAP option
                // HL uses a dropdown/popover with text options
                const items = document.querySelectorAll('[class*="dmctIk"], [class*="menuItem"], a, div');
                for (const el of items) {
                    if (/^TWAP$/i.test(el.textContent.trim())) return el;
                }
                return null;
            },

            // Buy/Sell — HL uses a toggle with "Buy / Long" and "Sell / Short"
            getBuySellRow: () => {
                // Find the container with the buy/sell toggle
                const divs = document.querySelectorAll('.sc-gGvHcT, [class*="gGvHcT"]');
                for (const d of divs) {
                    if (/Buy.*Long/i.test(d.textContent) && /Sell.*Short/i.test(d.textContent)) return d;
                }
                // Fallback: look for the specific layout
                const containers = document.querySelectorAll('div');
                for (const c of containers) {
                    const text = c.textContent || "";
                    if (/Buy \/ Long/.test(text) && /Sell \/ Short/.test(text) && c.children.length <= 5) return c;
                }
                return null;
            },
            findBuyBtn: (children) => {
                // HL buy/sell are div elements within the toggle, not buttons
                for (const el of children) {
                    if (/Buy|Long/i.test(el.textContent)) return el;
                }
                return null;
            },
            findSellBtn: (children) => {
                for (const el of children) {
                    if (/Sell|Short/i.test(el.textContent)) return el;
                }
                return null;
            },

            // Amount input
            getAmountInput: () => {
                // HL has input with class dpFCPO or similar near "Size" label
                const inputs = document.querySelectorAll('input[class*="hHTYSt"], input[class*="dpFCPO"]');
                if (inputs.length > 0) return inputs[0];
                // Fallback: find input near "Size" label
                const labels = document.querySelectorAll('div');
                for (const l of labels) {
                    if (l.textContent.trim() === "Size" && l.closest('div')?.querySelector('input')) {
                        return l.closest('div').querySelector('input');
                    }
                }
                return null;
            },
            getPlaceOrderBtn: () => {
                // HL place order button — green/red button with "Buy" or "Sell" + coin name
                const btns = document.querySelectorAll('button[class*="ftTHYK"], button[class*="hIwQDy"]');
                for (const b of btns) {
                    if (/Place Order|Buy|Sell|Long|Short/i.test(b.textContent) && b.style.width !== "100px") return b;
                }
                return null;
            },

            // Positions table
            getPositionsTable: () => {
                // HL positions table — find table inside the positions panel
                const tables = document.querySelectorAll("table");
                for (const t of tables) {
                    const headers = t.querySelectorAll("th, td.sc-gScZFl, td[class*='gScZFl']");
                    for (const h of headers) {
                        if (/\bCoin\b/.test(h.textContent)) return t;
                    }
                }
                // Fallback: first table with "Coin" in header
                for (const t of tables) {
                    if (/\bCoin\b/.test(t.querySelector("tr")?.textContent || "")) return t;
                }
                return tables[0] || null;
            },
            isLongRow: (td0) => {
                // HL indicates direction via left border color: green = long, red = short
                // Check raw inline style (most reliable) + computed properties
                const raw = td0.getAttribute("style") || "";
                if (raw.includes("31, 166, 125")) return true;
                const bg = td0.style?.background || td0.style?.backgroundImage || "";
                if (bg.includes("31, 166, 125") || bg.includes("1fa67d")) return true;
                // Also check size cell span color (green text = long)
                const sizeSpan = td0.nextElementSibling?.querySelector("span");
                if (sizeSpan) {
                    const color = (sizeSpan.getAttribute("style") || "") + (sizeSpan.style?.color || "");
                    if (color.includes("31, 166, 125")) return true;
                }
                return false;
            },
            isShortRow: (td0) => {
                const raw = td0.getAttribute("style") || "";
                if (raw.includes("237, 112, 136")) return true;
                const bg = td0.style?.background || td0.style?.backgroundImage || "";
                if (bg.includes("237, 112, 136") || bg.includes("ed7088")) return true;
                const sizeSpan = td0.nextElementSibling?.querySelector("span");
                if (sizeSpan) {
                    const color = (sizeSpan.getAttribute("style") || "") + (sizeSpan.style?.color || "");
                    if (color.includes("237, 112, 136")) return true;
                }
                return false;
            },
            getSymbolFromCell: (td0) => {
                // HL coin cell: <a class="...">ANTHROPIC</a>
                const link = td0.querySelector('a[class*="kaaNBM"], a[class*="dmctIk"]');
                if (link) {
                    const text = link.textContent.trim();
                    if (/^[A-Za-z0-9]{1,20}$/.test(text)) return text;
                }
                // Fallback
                return (td0.textContent || "").trim().split(/[\s\n]/)[0].replace(/[^A-Za-z0-9]/g, "") || "";
            },
            positionRowSelector: "tbody tr[class*='gZZrjv'], tbody tr[class*='iOeugr']:not(:first-child)",

            // Account section — find parent of "Account Equity" and "Perps Overview"
            getAccountContainer: () => {
                // Walk up from "Perps Overview" text to find the scrollable container
                const divs = document.querySelectorAll('div');
                for (const d of divs) {
                    const text = (d.firstChild?.textContent || "").trim();
                    if (text === "Perps Overview") {
                        // Go up to find the container with both Account Equity and Perps Overview
                        let parent = d.parentElement;
                        for (let i = 0; i < 5 && parent; i++) {
                            const txt = parent.textContent || "";
                            if (/Account Equity/.test(txt) && /Perps Overview/.test(txt)) return parent;
                            parent = parent.parentElement;
                        }
                    }
                }
                return null;
            },

            // Funding rates
            fundingRateSource: "hyperliquid-api", // uses HL's REST API

            // Pro dropdown is a regular click
            advancedDropdownNeedsPointerEvents: false,
        },
    };

    // Export
    window._PP_PLATFORMS = PLATFORMS;
    window._PP_detectPlatform = detectPlatform;
    window._PP_platformConfig = platformConfig;
    window._PP_currentPlatform = detectPlatform();
    window._PP_config = platformConfig[window._PP_currentPlatform] || null;

    console.log("[Perpetualpulse] Platform detected:", window._PP_currentPlatform);
})();
