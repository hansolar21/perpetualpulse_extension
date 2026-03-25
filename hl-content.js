// hl-content.js — Hyperliquid-specific injection (long/short metrics + funding rates)
// Depends on platform.js being loaded first

(function () {
    "use strict";

    if (window._PP_currentPlatform !== "hyperliquid") return;

    console.log("[Perpetualpulse] Hyperliquid content.js active");

    const EXT_COLOR = "rgba(160, 195, 255, 0.95)";
    const EXT_COLOR_DIM = "rgba(160, 195, 255, 0.70)";

    const cfg = window._PP_config;
    let observer = null;
    let _injecting = false;
    let _injectPending = false;
    let lastHref = location.href;

    // ---------- Funding Rate Cache ----------
    let _hlFundingRates = {}; // symbol -> rate (decimal)
    let _hlFundingLastFetch = 0;
    const FUNDING_CACHE_MS = 15_000;

    async function fetchHLFundingRates() {
        if (Date.now() - _hlFundingLastFetch < FUNDING_CACHE_MS && Object.keys(_hlFundingRates).length > 0) {
            return _hlFundingRates;
        }
        try {
            const newRates = {};

            // Fetch standard perps, vntl (pre-launch), and xyz (HIP-3 equities) in parallel
            const dexes = ["", "vntl", "xyz"];
            const responses = await Promise.all(
                dexes.map((dex) =>
                    fetch("https://api.hyperliquid.xyz/info", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" }),
                    }).then((r) => r.json()).catch(() => [{ universe: [] }, []])
                )
            );

            for (const data of responses) {
                const universe = data[0]?.universe || [];
                const ctxs = data[1] || [];
                for (let i = 0; i < universe.length && i < ctxs.length; i++) {
                    let sym = (universe[i].name || "").toUpperCase();
                    // Strip dex prefix: "vntl:ANTHROPIC" → "ANTHROPIC", "xyz:NVDA" → "NVDA"
                    sym = sym.replace(/^[A-Z]+:/, "");
                    const rate = parseFloat(ctxs[i].funding);
                    if (sym && !isNaN(rate)) newRates[sym] = rate;
                }
            }

            _hlFundingRates = newRates;
            _hlFundingLastFetch = Date.now();
        } catch (e) {
            console.warn("[Perpetualpulse] HL funding fetch failed:", e);
        }
        return _hlFundingRates;
    }

    function getFundingRate(symbol) {
        const sym = (symbol || "").toUpperCase();
        return _hlFundingRates[sym] ?? null;
    }

    function formatFundingRate(rate) {
        if (rate === null || rate === undefined) return "";
        const pct = (rate * 100).toFixed(4);
        const sign = rate >= 0 ? "+" : "";
        return `${sign}${pct}%`;
    }

    // ---------- Utils ----------
    function parseUSD(str) {
        return parseFloat((str || "").replace(/[\s\u00A0,$%xUSDH]/gi, "")) || 0;
    }

    // Persistent mask state
    const maskedRows = {};

    function applyMask(span, realText, isMasked) {
        if (isMasked) {
            span.innerText = "******";
            span.setAttribute("data-masked", "1");
        } else {
            span.innerText = realText;
            span.setAttribute("data-masked", "0");
        }
    }

    function createInfoIcon(tooltipText) {
        const info = document.createElement("span");
        info.innerText = "ⓘ";
        info.title = tooltipText;
        info.style.cssText = `cursor:help;font-size:11px;opacity:0.6;color:${EXT_COLOR_DIM};margin-left:3px;`;
        return info;
    }

    function formatRow(label, value, id = "", isFirst = false, tooltip = null) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;width:100%;align-items:center;justify-content:space-between;line-height:1.2;padding:1px 0;";
        row.setAttribute("data-injected", "pp-hl");
        if (id) row.setAttribute("data-injected-id", id);
        if (isFirst) {
            row.style.borderTop = "1px solid rgba(130, 170, 255, 0.15)";
            row.style.paddingTop = "3px";
            row.style.marginTop = "3px";
        }

        const labelDiv = document.createElement("div");
        const labelSpan = document.createElement("span");
        labelSpan.style.cssText = `font-size:12px;color:${EXT_COLOR_DIM};text-decoration:underline;cursor:pointer;`;
        labelSpan.innerText = label;

        const valueSpan = document.createElement("span");
        valueSpan.style.cssText = `font-size:12px;color:${EXT_COLOR}!important;`;
        valueSpan.setAttribute("data-real", value);

        const isMasked = !!maskedRows[id];
        applyMask(valueSpan, value, isMasked);
        valueSpan.style.cursor = "pointer";
        valueSpan.addEventListener("click", (e) => {
            maskedRows[id] = !(valueSpan.getAttribute("data-masked") === "1");
            applyMask(valueSpan, value, maskedRows[id]);
            e.stopPropagation();
        });

        labelDiv.appendChild(labelSpan);
        if (tooltip) labelDiv.appendChild(createInfoIcon(tooltip));
        row.appendChild(labelDiv);
        row.appendChild(valueSpan);
        return row;
    }

    // ---------- Equity Detection ----------
    let _lastGoodEquity = 0;

    function getEquity() {
        // Strategy: find rows with "justify-content: space-between" that have a label + dollar value
        // Look for "Balance" label under the Perps Overview section
        const rows = document.querySelectorAll('div[style*="justify-content: space-between"]');
        for (const row of rows) {
            const children = row.children;
            if (children.length < 2) continue;
            // Check if first child contains "Balance" text (leaf text, not deep)
            const labelText = (children[0].textContent || "").trim();
            if (/^Balance$/i.test(labelText)) {
                const valText = (children[children.length - 1].textContent || "").trim();
                const v = parseUSD(valText);
                if (v > 0) return v;
            }
        }
        // Fallback: "Account Value" label
        for (const row of rows) {
            const children = row.children;
            if (children.length < 2) continue;
            const labelText = (children[0].textContent || "").trim();
            if (/Account Value/i.test(labelText)) {
                const valText = (children[children.length - 1].textContent || "").trim();
                const v = parseUSD(valText);
                if (v > 0) return v;
            }
        }
        return 0;
    }

    function safeEquity() {
        const v = getEquity();
        if (v > 0) _lastGoodEquity = v;
        return v > 0 ? v : _lastGoodEquity;
    }

    // ---------- Funding injection into table ----------
    function findFundingColIdx(table) {
        // HL header row: <tr> with <td> cells containing nested divs with header text
        const firstRow = table.querySelector("tr");
        if (!firstRow) return -1;
        const cells = firstRow.querySelectorAll("td, th");
        for (let i = 0; i < cells.length; i++) {
            // Check all nested text nodes, ignoring SVGs
            const divs = cells[i].querySelectorAll("div");
            for (const d of divs) {
                // Only check leaf text
                if (d.children.length === 0 || (d.children.length === 0 && d.textContent)) {
                    if (/^Funding$/i.test(d.textContent.trim())) return i;
                }
            }
            // Also direct check
            const directText = cells[i].querySelector('div[class*="bFBYgR"], div[class*="bjfHbI"]');
            if (directText && /^Funding$/i.test(directText.textContent.trim())) return i;
        }
        return -1;
    }

    function injectFundingRates(table) {
        if (!table) return;

        const fundingIdx = findFundingColIdx(table);
        if (fundingIdx < 0) return;

        // Get all rows, skip header
        const allRows = table.querySelectorAll("tr");
        allRows.forEach((row, rowIdx) => {
            if (rowIdx === 0) return; // skip header
            const tds = row.querySelectorAll("td");
            if (tds.length <= fundingIdx) return;

            const td0 = tds[0];
            const symbol = cfg.getSymbolFromCell(td0);
            if (!symbol || /Coin/i.test(symbol)) return;

            const rate = getFundingRate(symbol);
            const fundingTd = tds[fundingIdx];

            // Remove previous injection
            fundingTd.querySelectorAll("[data-pp-funding]").forEach((el) => el.remove());

            if (rate !== null) {
                const rateEl = document.createElement("span");
                rateEl.setAttribute("data-pp-funding", "1");
                rateEl.style.color = rate >= 0 ? "rgba(130, 255, 170, 0.9)" : "rgba(255, 130, 130, 0.9)";
                rateEl.style.fontSize = "inherit";
                rateEl.style.fontFamily = "inherit";
                rateEl.style.marginRight = "4px";
                rateEl.style.whiteSpace = "nowrap";
                rateEl.textContent = formatFundingRate(rate);
                fundingTd.insertBefore(rateEl, fundingTd.firstChild);
            }
        });
    }

    // ---------- Core Injection ----------
    async function injectMetrics() {
        _injecting = true;
        try {
            await fetchHLFundingRates();

            const table = cfg.getPositionsTable();
            if (!table) return;

            // Tighten native spacing
            tightenAccountSpacing();

            // Inject funding rates
            injectFundingRates(table);

            // Parse positions for long/short metrics
            let longSum = 0, shortSum = 0, longCount = 0, shortCount = 0;

            // HL data rows: skip header row
            const allRows = table.querySelectorAll("tr");
            allRows.forEach((row) => {
                const tds = row.querySelectorAll("td");
                if (tds.length < 3) return;

                const td0 = tds[0];
                const sym = cfg.getSymbolFromCell(td0);
                if (!sym || /Coin/i.test(sym)) return; // skip header

                // Position value is typically in column index 2
                let posValue = 0;
                if (tds[2]) {
                    posValue = parseUSD(tds[2].textContent);
                }

                const isLong = cfg.isLongRow(td0);
                const isShort = cfg.isShortRow(td0);

                if (isLong) { longSum += posValue; longCount++; }
                else if (isShort) { shortSum += posValue; shortCount++; }
            });

            // Find the account container to inject metrics
            const container = cfg.getAccountContainer();
            if (!container) return;

            // Remove old injections (but keep wrapper for reuse)
            container.querySelectorAll('[data-injected="pp-hl"]').forEach((el) => el.remove());

            const portVal = safeEquity();
            const longPVx = portVal ? longSum / portVal : 0;
            const shortPVx = portVal ? shortSum / portVal : 0;
            const total = longSum + shortSum;
            const longRatio = total > 0 ? (longSum / total).toFixed(2) : "0.00";

            let lsRatio;
            if (longSum === 0 && shortSum === 0) lsRatio = "0.00";
            else if (shortSum === 0) lsRatio = "∞";
            else if (longSum >= shortSum) lsRatio = (longSum / shortSum).toFixed(2);
            else lsRatio = (-shortSum / longSum).toFixed(2);

            const netExposure = longSum - shortSum;
            const netLeverage = portVal ? netExposure / portVal : 0;

            const fmtDollar = (n) => `$${Math.round(n).toLocaleString()}`;

            const rows = [
                formatRow("Long vs Short:", `${fmtDollar(longSum)} / ${fmtDollar(shortSum)}`, "hl-ls-1", true),
                formatRow("L/S Ratio:", `${lsRatio} (Longs = ${longRatio})`, "hl-ls-2"),
                formatRow("Long vs Portfolio:", `${longPVx.toFixed(2)}x (${longCount} pairs)`, "hl-ls-3"),
                formatRow("Short vs Portfolio:", `${shortPVx.toFixed(2)}x (${shortCount} pairs)`, "hl-ls-4"),
                formatRow("Net Leverage:", `${netLeverage.toFixed(2)}x (${fmtDollar(netExposure)})`, "hl-ls-5"),
            ];

            // Wrap in a tight container to control spacing
            let wrapper = container.querySelector('[data-injected="pp-hl-wrapper"]');
            if (!wrapper) {
                wrapper = document.createElement("div");
                wrapper.setAttribute("data-injected", "pp-hl-wrapper");
                wrapper.style.cssText = "display:flex;flex-direction:column;gap:0px;";
                container.appendChild(wrapper);
            }
            wrapper.innerHTML = "";
            rows.forEach((r) => wrapper.appendChild(r));
        } finally {
            _injecting = false;
        }
    }

    // ---------- Observer ----------
    function observeTable(table) {
        if (observer) { observer.disconnect(); observer = null; }
        observer = new MutationObserver(() => {
            if (_injecting) return;
            if (!_injectPending) {
                _injectPending = true;
                requestAnimationFrame(() => {
                    _injectPending = false;
                    injectMetrics();
                });
            }
        });
        observer.observe(table, { childList: true, subtree: true, characterData: true });
    }

    // Also observe account container for equity changes
    function observeAccount() {
        const container = cfg.getAccountContainer();
        if (!container) return;
        const obs = new MutationObserver(() => {
            if (_injecting) return;
            if (!_injectPending) {
                _injectPending = true;
                requestAnimationFrame(() => {
                    _injectPending = false;
                    injectMetrics();
                });
            }
        });
        obs.observe(container, { childList: true, subtree: true, characterData: true });
    }

    // ---------- Tighten native Account Equity / Perps Overview spacing ----------
    function tightenAccountSpacing() {
        const container = cfg.getAccountContainer();
        if (!container) return;
        // Target all flex-col and grid containers with gap:10px inside the account panel
        const children = container.querySelectorAll('div[style*="gap: 10px"], div[style*="gap:10px"]');
        children.forEach((el) => {
            el.style.gap = "4px";
        });
        // Also tighten the container itself if it has gap
        if (container.style.gap) container.style.gap = "4px";

        // Flatten Deposit / Perps→Spot / Withdraw onto one line
        const buttons = container.querySelectorAll('button[class*="ftTHYK"]');
        let depositBtn = null;
        for (const b of buttons) {
            if (/^Deposit$/i.test(b.textContent.trim())) { depositBtn = b; break; }
        }
        if (depositBtn) {
            const btnCol = depositBtn.parentElement;
            if (btnCol && /flex-direction:\s*column/.test(btnCol.getAttribute("style") || "")) {
                // Make the column into a single row
                btnCol.style.flexDirection = "row";
                btnCol.style.gap = "4px";
                // The Deposit button should share space equally
                depositBtn.style.flex = "1";
                depositBtn.style.minWidth = "0";
                // The grid sub-container (Perps→Spot + Withdraw) should also flex
                const gridDiv = btnCol.querySelector('div[style*="grid-template-columns"]');
                if (gridDiv) {
                    gridDiv.style.flex = "2";
                    gridDiv.style.gap = "4px";
                }
            }
        }
    }

    // ---------- Init ----------
    const maxTries = 60;
    let attempt = 0;

    function waitForDomAndData() {
        const table = cfg.getPositionsTable();
        const container = cfg.getAccountContainer();

        if (table && container) {
            injectMetrics();
            observeTable(table);
            observeAccount();
            // Re-fetch funding rates periodically
            setInterval(() => injectMetrics(), 15000);
        } else if (attempt < maxTries) {
            attempt++;
            setTimeout(waitForDomAndData, 500);
        } else {
            console.warn("[Perpetualpulse] HL: DOM not ready after max attempts");
        }
    }

    // URL change detection (SPA)
    function checkUrlChange() {
        if (location.href !== lastHref) {
            lastHref = location.href;
            attempt = 0;
            waitForDomAndData();
        }
        requestAnimationFrame(checkUrlChange);
    }
    requestAnimationFrame(checkUrlChange);

    // Initial load — wait for page to settle
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => setTimeout(waitForDomAndData, 1000));
    } else {
        setTimeout(waitForDomAndData, 1000);
    }
})();
