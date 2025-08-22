// ==UserScript==
// @name         Perpetualpulse Trading Metrics
// @version      1.8
// @description  Injects long/short summary and leverage stats into lighter.xyz, with TV equation copy & Show/Hide preview
// ==/UserScript==

console.log("[Perpetualpulse] content.js injected");

let lastHref = location.href;
function checkUrlChange() {
    if (location.href !== lastHref) {
        lastHref = location.href;
        if (/\/trade(\/|$|\?)/.test(location.pathname)) waitForDomAndData();
    }
    requestAnimationFrame(checkUrlChange);
}
requestAnimationFrame(checkUrlChange);

const maxTries = 40;
let attempt = 0;
let observer = null;

// Persistent mask state (id -> true = masked)
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

// ------- UI ROW HELPERS -------
function formatRow(label, value, id = "", isFirst = false) {
    const row = document.createElement("div");
    row.className = "flex w-full items-center justify-between";
    row.setAttribute("data-injected", "ls-info");
    if (id) row.setAttribute("data-injected-id", id);

    if (isFirst) {
        row.style.borderTop = "1px solid rgba(255,255,255,0.1)";
        row.style.paddingTop = "4px";
        row.style.marginTop = "4px";
    }

    const labelSpan = document.createElement("span");
    labelSpan.className = "text-xs";
    labelSpan.style.color = "rgba(255,255,255,0.7)";
    labelSpan.innerText = label;

    const valueSpan = document.createElement("span");
    valueSpan.className = "text-xs";
    valueSpan.style.color = "white";
    valueSpan.setAttribute("data-real", value);

    const isMasked = !!maskedRows[id];
    applyMask(valueSpan, value, isMasked);

    valueSpan.style.cursor = "pointer";
    valueSpan.addEventListener("click", function (e) {
        maskedRows[id] = !(valueSpan.getAttribute("data-masked") === "1");
        applyMask(valueSpan, value, maskedRows[id]);
        e.stopPropagation();
    });

    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    return row;
}

// prevent any click from bubbling (keep native title tooltip)
function blockPropagation(el) {
    const stop = (e) => { e.stopImmediatePropagation?.(); e.stopPropagation(); };
    ["click","pointerdown","pointerup","mousedown","mouseup","touchstart","touchend"]
        .forEach(evt => el.addEventListener(evt, stop, true));
}

/** Copy row: 📋 + "Copy TradingView equation" + ⓘ (tooltip only) + Show/Hide toggle on right.
 *  - Left (📋 + label): copies to clipboard
 *  - Right (Show/Hide): toggles a boxed equation below this row (no copy)
 *  Ensures Show/Hide is ALWAYS visible (left side truncates with ellipsis).
 */
function formatCopyEquationRow(onCopyClick, onToggleRequest, id = "") {
    // Wrapper holds the row and the equation box
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-injected", "ls-info");
    if (id) wrapper.setAttribute("data-injected-id", id);
    wrapper.style.width = "100%";
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";

    // Main row
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.width = "100%";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "8px";

    // LEFT (shrinks with ellipsis)
    const leftWrap = document.createElement("div");
    leftWrap.style.display = "flex";
    leftWrap.style.alignItems = "center";
    leftWrap.style.gap = "6px";
    leftWrap.style.flex = "1 1 auto";
    leftWrap.style.minWidth = "0"; // REQUIRED for ellipsis

    const icon = document.createElement("span");
    icon.innerText = "📋";
    icon.style.fontSize = "12px";
    icon.style.flexShrink = "0";

    const labelSpan = document.createElement("span");
    labelSpan.className = "text-xs underline";
    labelSpan.innerText = "Copy TradingView equation";
    labelSpan.style.display = "block";
    labelSpan.style.whiteSpace = "nowrap";
    labelSpan.style.overflow = "hidden";
    labelSpan.style.textOverflow = "ellipsis";
    labelSpan.style.color = "rgba(255,255,255,0.7)";

    const info = document.createElement("span");
    info.innerText = "ⓘ";
    info.setAttribute("title",
        "Paste into TradingView to see a consolidated chart of your current positions. TradingView only supports 10 combined tickers. This equation implies a 1x leverage relative to your equity."
    );
    info.style.cursor = "help";
    info.style.fontSize = "12px";
    info.style.opacity = "0.8";
    info.style.flexShrink = "0";
    blockPropagation(info); // never copies

    leftWrap.appendChild(icon);
    leftWrap.appendChild(labelSpan);
    leftWrap.appendChild(info);

    // RIGHT (never shrinks)
    const rightWrap = document.createElement("div");
    rightWrap.style.display = "flex";
    rightWrap.style.alignItems = "center";
    rightWrap.style.gap = "6px";
    rightWrap.style.flex = "0 0 auto";

    const toggle = document.createElement("span");
    toggle.className = "text-xs underline";
    toggle.innerText = "Show";
    toggle.style.cursor = "pointer";
    toggle.style.color = "rgba(255,255,255,0.7)";
    rightWrap.appendChild(toggle);

    // Hover accent (red) for clickable bits (label + 📋 + toggle)
    const hoverColor = "rgb(212, 68, 77)";
    icon.style.color = "rgba(255,255,255,0.7)";
    labelSpan.addEventListener("mouseenter", () => { labelSpan.style.color = hoverColor; icon.style.color = hoverColor; });
    labelSpan.addEventListener("mouseleave", () => { labelSpan.style.color = "rgba(255,255,255,0.7)"; icon.style.color = "rgba(255,255,255,0.7)"; });
    icon.addEventListener("mouseenter", () => { labelSpan.style.color = hoverColor; icon.style.color = hoverColor; });
    icon.addEventListener("mouseleave", () => { labelSpan.style.color = "rgba(255,255,255,0.7)"; icon.style.color = "rgba(255,255,255,0.7)"; });
    toggle.addEventListener("mouseenter", () => { toggle.style.color = hoverColor; });
    toggle.addEventListener("mouseleave", () => { toggle.style.color = "rgba(255,255,255,0.7)"; });

    // Assemble main row
    row.appendChild(leftWrap);
    row.appendChild(rightWrap);

    // Equation box BELOW the row
    const eqBox = document.createElement("div");
    eqBox.style.display = "none";
    eqBox.style.marginTop = "6px";
    eqBox.style.padding = "6px 8px";
    eqBox.style.background = "rgba(255,255,255,0.06)";
    eqBox.style.border = "1px solid rgba(255,255,255,0.12)";
    eqBox.style.borderRadius = "6px";

    const eqText = document.createElement("div");
    eqText.className = "text-xs";
    eqText.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    eqText.style.color = "white";
    eqText.style.whiteSpace = "normal";   // wrap
    eqText.style.wordBreak = "break-all"; // break long tokens
    eqText.style.maxHeight = "72px";      // compact
    eqText.style.overflow = "auto";       // scroll if long
    eqBox.appendChild(eqText);

    // Bind copy (left)
    const handleCopy = async (e) => {
        e.stopPropagation();
        try {
            const eq = await onCopyClick(); // copies to clipboard
            if (eq && typeof eq === "string") {
                // If the box is open, refresh its contents
                if (eqBox.style.display !== "none") eqText.textContent = eq;
            }
        } catch (err) {
            console.error("[Perpetualpulse] Copy TV equation failed:", err);
        }
    };
    labelSpan.addEventListener("click", handleCopy);
    icon.addEventListener("click", handleCopy);

    // Bind toggle (right)
    let cachedEquation = "";
    let isShown = false;
    const updateToggleUI = () => { toggle.innerText = isShown ? "Hide" : "Show"; };

    const handleToggle = async (e) => {
        e.stopPropagation();
        try {
            if (!isShown) {
                if (!cachedEquation) {
                    cachedEquation = await onToggleRequest(); // build (no copy)
                }
                eqText.textContent = cachedEquation || "(no positions)";
                eqBox.style.display = "block";
                isShown = true;
                updateToggleUI();
            } else {
                eqBox.style.display = "none";
                isShown = false;
                updateToggleUI();
            }
        } catch (err) {
            console.error("[Perpetualpulse] Toggle TV equation failed:", err);
        }
    };
    toggle.addEventListener("click", handleToggle);

    // Build wrapper
    wrapper.appendChild(row);
    wrapper.appendChild(eqBox);

    // For debugging: confirm injection
    console.log("[Perpetualpulse] Injecting TV equation row (Show/Hide present).");
    return wrapper;
}

// ------- PARSERS -------
function parseUSD(str) { return parseFloat(str.replace(/[$,%x]/gi, '')) || 0; }

function getPortfolioValue() {
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) return 0;
    const rows = container.querySelectorAll('div.flex.w-full.items-center.justify-between');
    for (let row of rows) {
        const labelSpan = row.querySelector('span.text-xs.text-gray-3, span.text-xs.text-gray-3.underline, span.text-xs');
        if (!labelSpan) continue;
        const ltxt = labelSpan.innerText.trim().toLowerCase();
        if (ltxt.includes("portfolio") || ltxt.includes("equity")) {
            const valueSpan = row.querySelector('span.text-xs.text-gray-0, span.text-xs');
            if (valueSpan) return parseUSD(valueSpan.innerText);
        }
    }
    return 0;
}

function tableHasData(table) {
    const rows = table.querySelectorAll("tbody tr");
    for (let row of rows) {
        const tds = row.querySelectorAll("td");
        if (tds.length < 3) continue;
        if (parseUSD(tds[2].innerText) > 0) return true;
    }
    return false;
}

/** Normalize market symbol to TradingView symbol (force USDT, strip leading lowercase 'k') */
function normalizeToUSDT(rawSymbol) {
    if (!rawSymbol) return "";
    let sym = String(rawSymbol).split("\n")[0].trim();
    sym = sym.replace(/[:/.\-\s]/g, "");
    sym = sym.replace(/USDT$/i, "");
    sym = sym.replace(/^k(?=[A-Z0-9])/, ""); // kBONK -> BONK
    return `${sym.toUpperCase()}USDT`;
}

/** Build TV equation from table (top 10 by abs notional), multiplicative with exponents:
 * SYMBOLUSDT^weight * SYMBOLUSDT^-weight * ...
 * Long => +exp, Short => -exp
 *
 * @param {HTMLTableElement} table
 * @param {number} weightDecimals
 * @param {boolean} copyToClipboard
 * @returns {Promise<string>} equation string
 */
async function buildTradingViewEquationFromTable(table, weightDecimals = 4, copyToClipboard = true) {
    if (!table) throw new Error("No table");
    const rows = table.querySelectorAll("tbody tr");

    const positions = [];
    rows.forEach(row => {
        const tds = row.querySelectorAll("td");
        if (tds.length < 3) return;

        const marketCellText = tds[0].innerText || "";
        const lower = marketCellText.toLowerCase();
        const isLong = lower.includes("\nlong");
        const isShort = lower.includes("\nshort");
        if (!isLong && !isShort) return;

        const notional = Math.abs(parseUSD(tds[2].innerText));
        if (!(notional > 0)) return;

        positions.push({
            symbol: normalizeToUSDT(marketCellText),
            side: isShort ? "Short" : "Long",
            notional
        });
    });

    if (positions.length === 0) {
        if (copyToClipboard) await navigator.clipboard.writeText("");
        return "";
    }

    const top = positions.sort((a, b) => b.notional - a.notional).slice(0, 10);
    const sumAbs = top.reduce((s, p) => s + Math.abs(p.notional), 0) || 1;

    const terms = top.map(p => {
        const w = p.notional / sumAbs;
        const exp = (p.side === "Short" ? -w : w).toFixed(weightDecimals);
        return `${p.symbol}^${exp}`;
    });

    const equation = terms.join("*");
    if (copyToClipboard) await navigator.clipboard.writeText(equation);
    console.log("[Perpetualpulse] TV equation:", equation);
    return equation;
}

// ------- MAIN INJECTION -------
function injectMetrics() {
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) return;

    // Clear previous injection
    container.querySelectorAll('[data-injected="ls-info"]').forEach(el => el.remove());

    const table = document.querySelector("table");
    if (!table) return;

    let longSum = 0, shortSum = 0;
    let longLevs = [], shortLevs = [];
    let longCount = 0, shortCount = 0;

    const rows = table.querySelectorAll("tbody tr");
    rows.forEach(row => {
        const tds = row.querySelectorAll("td");
        if (tds.length < 3) return;

        const marketText = tds[0].innerText.trim().toLowerCase();
        const value = parseUSD(tds[2].innerText);
        const isLong = marketText.includes("\nlong");
        const isShort = marketText.includes("\nshort");
        const levMatch = marketText.match(/(\d+(\.\d+)?)x/);
        const leverage = levMatch ? parseFloat(levMatch[1]) : 0;

        if (isLong) {
            longSum += value; longCount++;
            if (leverage) longLevs.push(leverage);
        } else if (isShort) {
            shortSum += value; shortCount++;
            if (leverage) shortLevs.push(leverage);
        }
    });

    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const portVal = getPortfolioValue();
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

    const newRows = [
        formatRow("Long vs Short:", `$${longSum.toLocaleString()} / $${shortSum.toLocaleString()}`, "ls-line-1", true),
        formatRow("L/S Ratio:", `${lsRatio} (Longs = ${longRatio})`, "ls-line-2"),
        formatRow("Long vs Portfolio:", `${longPVx.toFixed(2)}x (${longCount} pairs at ${avg(longLevs).toFixed(1)}x)`, "ls-line-3"),
        formatRow("Short vs Portfolio:", `${shortPVx.toFixed(2)}x (${shortCount} pairs at ${avg(shortLevs).toFixed(1)}x)`, "ls-line-4"),
        formatRow("Net Leverage:", `${netLeverage.toFixed(2)}x ($${netExposure.toLocaleString()})`, "ls-line-5"),
        formatCopyEquationRow(
            // onCopyClick (copies to clipboard)
            () => {
                const tableEl = document.querySelector("table");
                return buildTradingViewEquationFromTable(tableEl, 4, true);
            },
            // onToggleRequest (build only, no copy)
            () => {
                const tableEl = document.querySelector("table");
                return buildTradingViewEquationFromTable(tableEl, 4, false);
            },
            "ls-line-tv"
        )
    ];

    newRows.forEach(row => container.appendChild(row));
    console.log("[Perpetualpulse] Metrics injected (rows:", newRows.length, ").");
}

function observeTable(table) {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => injectMetrics());
    observer.observe(table, { childList: true, subtree: true, characterData: true });
}

function waitForDomAndData() {
    const table = document.querySelector("table");
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (table && container && tableHasData(table)) {
        injectMetrics();
        observeTable(table);
    } else if (attempt < maxTries) {
        attempt++; setTimeout(waitForDomAndData, 500);
    } else {
        console.warn("[Perpetualpulse] DOM/data not ready after max attempts.");
    }
}

waitForDomAndData();
