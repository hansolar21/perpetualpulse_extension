// ==UserScript==
// @name         Perpetualpulse Trading Metrics
// @version      1.4
// @description  Injects long/short summary and leverage stats into lighter.xyz, now with persistent masking
// ==/UserScript==

console.log("[Perpetualpulse] content.js injected");

// Debugging
console.log("[Perpetualpulse] patch loaded at", performance.now());
window._patch_test = 1;

let lastHref = location.href;

function checkUrlChange() {
    if (location.href !== lastHref) {
        lastHref = location.href;
        if (/\/trade(\/|$|\?)/.test(location.pathname)) {
            waitForDomAndData();
        }
    }
    requestAnimationFrame(checkUrlChange);
}
requestAnimationFrame(checkUrlChange);

// PATCH FETCH
const origFetch = window.fetch;
window.fetch = function() {
    console.log("[Perpetualpulse] fetch called with:", arguments);
    return origFetch.apply(this, arguments);
};
console.log("[Perpetualpulse] fetch patched", window.fetch === origFetch ? "(no)" : "(yes)");

// PATCH XHR
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function() {
    console.log("[Perpetualpulse] XHR open called with:", arguments);
    return origOpen.apply(this, arguments);
};
console.log("[Perpetualpulse] XHR patched", XMLHttpRequest.prototype.open === origOpen ? "(no)" : "(yes)");


(function() {
    let currentToken = null;
    const origFetch = window.fetch;
    window.fetch = function(input, init = {}) {
        if (init && init.headers) {
            if (init.headers['authorization']) {
                currentToken = init.headers['authorization'];
                console.log("[Perpetualpulse] fetch: captured authorization token:", currentToken);
            }
            if (typeof init.headers.get === 'function') {
                const val = init.headers.get('authorization');
                if (val) {
                    currentToken = val;
                    console.log("[Perpetualpulse] fetch: captured authorization token:", currentToken);
                }
            }
        }
        return origFetch.apply(this, arguments);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() {
        this._url = arguments[1];
        return origOpen.apply(this, arguments);
    };
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        if (header.toLowerCase() === "authorization") {
            currentToken = value;
            console.log("[Perpetualpulse] XHR: captured authorization token:", currentToken);
        }
        return origSetRequestHeader.apply(this, arguments);
    };

    window.getCurrentLighterAuthToken = () => currentToken;
})();

// Utility: poll for the token, print when found
function waitForAuthToken(timeout = 10000, interval = 200) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        (function poll() {
            const token = window.getCurrentLighterAuthToken();
            if (token) {
                console.log("[Perpetualpulse] Final authorization token:", token);
                return resolve(token);
            }
            if (Date.now() - start > timeout) return reject(new Error("Timeout: No authorization token found"));
            setTimeout(poll, interval);
        })();
    });
}

waitForAuthToken().catch(() => { /* ignore if not found */ });

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

    const labelDiv = document.createElement("div");
    labelDiv.setAttribute("data-state", "closed");

    const labelSpan = document.createElement("span");
    labelSpan.className = "text-xs text-gray-2 underline";
    labelSpan.innerText = label;
    labelSpan.style.cursor = "pointer";

    const valueSpan = document.createElement("span");
    valueSpan.className = "text-xs text-gray-0";
    valueSpan.setAttribute("data-real", value);

    const isMasked = !!maskedRows[id];
    applyMask(valueSpan, value, isMasked);

    valueSpan.style.cursor = "pointer";
    valueSpan.addEventListener("click", function (e) {
        maskedRows[id] = !(valueSpan.getAttribute("data-masked") === "1");
        applyMask(valueSpan, value, maskedRows[id]);
        e.stopPropagation();
    });

    labelDiv.appendChild(labelSpan);
    row.appendChild(labelDiv);
    row.appendChild(valueSpan);
    return row;
}

/** Action row: whole line clickable to copy equation; shows 📋 icon, hover color, and ⓘ tooltip */
function formatCopyEquationRow(onClick, id = "") {
    const row = document.createElement("div");
    row.className = "flex w-full items-center justify-between";
    row.setAttribute("data-injected", "ls-info");
    if (id) row.setAttribute("data-injected-id", id);

    // LEFT side: [📋 Copy TradingView equation] [ⓘ]
    const leftWrap = document.createElement("div");
    leftWrap.className = "flex items-center gap-2";

    const labelSpan = document.createElement("span");
    labelSpan.className = "text-xs text-gray-2 underline";
    labelSpan.innerText = "Copy TradingView equation";
    labelSpan.style.cursor = "pointer";

    // Copy icon
    const icon = document.createElement("span");
    icon.innerText = "📋";
    icon.setAttribute("aria-hidden", "true");
    icon.style.fontSize = "12px";

    // ⓘ tooltip
    const info = document.createElement("span");
    info.innerText = "ⓘ";
    info.setAttribute("title",
        "Paste into TradingView to see a consolidated chart of your current positions. TradingView only supports 10 combined tickers. This equation implies a 1x leverage relative to your equity."
    );
    info.style.cursor = "help";
    info.style.fontSize = "12px";
    info.style.opacity = "0.8";

    leftWrap.appendChild(icon);
    leftWrap.appendChild(labelSpan);
    leftWrap.appendChild(info);

    // Entire row acts as a button
    row.style.cursor = "pointer";
    row.style.userSelect = "none";

    // Hover effect (make more visible)
    const baseColor = "rgba(255,255,255,0.6)"; // text-gray-2-ish
    const hoverColor = "rgba(255,255,255,0.9)";
    labelSpan.style.color = baseColor;
    row.addEventListener("mouseenter", () => {
        labelSpan.style.color = hoverColor;
        labelSpan.style.textDecoration = "underline";
    });
    row.addEventListener("mouseleave", () => {
        labelSpan.style.color = baseColor;
        labelSpan.style.textDecoration = "underline";
    });

    // Click handler (on entire row + leftWrap + labelSpan + icon)
    const handler = async (e) => {
        e.stopPropagation();
        try {
            await onClick();
            const prev = labelSpan.innerText;
            labelSpan.innerText = "Copied!";
            setTimeout(() => (labelSpan.innerText = prev), 1200);
        } catch (err) {
            console.error("[Perpetualpulse] Copy TV equation failed:", err);
            const prev = labelSpan.innerText;
            labelSpan.innerText = "Error";
            setTimeout(() => (labelSpan.innerText = prev), 1500);
        }
    };
    row.addEventListener("click", handler);
    leftWrap.addEventListener("click", handler);
    labelSpan.addEventListener("click", handler);
    icon.addEventListener("click", handler);

    // Assemble; no right-side text (removed per request)
    row.appendChild(leftWrap);
    return row;
}

function parseUSD(str) {
    return parseFloat(str.replace(/[$,%x]/gi, '')) || 0;
}

function getPortfolioValue() {
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) return 0;

    const rows = container.querySelectorAll('div.flex.w-full.items-center.justify-between');
    for (let row of rows) {
        const labelSpan = row.querySelector('span.text-xs.text-gray-3, span.text-xs.text-gray-3.underline');
        if (!labelSpan) continue;

        const ltxt = labelSpan.innerText.trim().toLowerCase();
        if (
            ltxt === "portfolio value:" ||
            ltxt === "perps equity:" ||
            ltxt.includes("portfolio") ||
            ltxt.includes("equity")
        ) {
            const valueSpan = row.querySelector('span.text-xs.text-gray-0');
            if (valueSpan) {
                return parseUSD(valueSpan.innerText);
            }
        }
    }
    return 0;
}

function tableHasData(table) {
    const rows = table.querySelectorAll("tbody tr");
    for (let row of rows) {
        const tds = row.querySelectorAll("td");
        if (tds.length < 3) continue;
        const value = parseUSD(tds[2].innerText);
        if (value > 0) return true;
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

/** Build TradingView equation from current table (top 10 by abs notional), multiplicative with exponents:
 *   SYMBOLUSDT^weight * SYMBOLUSDT^-weight * ...
 *   Long => positive exponent, Short => negative exponent
 */
async function copyTradingViewEquationFromTable(table, weightDecimals = 4) {
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
        await navigator.clipboard.writeText("");
        return "";
    }

    const top = positions.sort((a, b) => b.notional - a.notional).slice(0, 10);
    const sumAbs = top.reduce((s, p) => s + Math.abs(p.notional), 0) || 1;

    const terms = top.map(p => {
        const w = p.notional / sumAbs; // 0..1
        const exp = (p.side === "Short" ? -w : w).toFixed(weightDecimals);
        return `${p.symbol}^${exp}`;
    });

    const equation = terms.join("*");

    await navigator.clipboard.writeText(equation);
    console.log("[Perpetualpulse] Copied TradingView equation:", equation);
    return equation;
}

function injectMetrics() {
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) return;
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
            longSum += value;
            longCount++;
            if (leverage) longLevs.push(leverage);
        } else if (isShort) {
            shortSum += value;
            shortCount++;
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
    if (longSum === 0 && shortSum === 0) {
        lsRatio = "0.00";
    } else if (shortSum === 0) {
        lsRatio = "∞";
    } else if (longSum >= shortSum) {
        lsRatio = (longSum / shortSum).toFixed(2);
    } else {
        lsRatio = (-shortSum / longSum).toFixed(2);
    }

    const netExposure = longSum - shortSum;
    const netLeverage = portVal ? netExposure / portVal : 0;

    const newRows = [
        formatRow("Long vs Short:", `$${longSum.toLocaleString()} / $${shortSum.toLocaleString()}`, "ls-line-1", true),
        formatRow("L/S Ratio:", `${lsRatio} (Longs = ${longRatio})`, "ls-line-2"),
        formatRow("Long vs Portfolio:", `${longPVx.toFixed(2)}x (${longCount} pairs at ${avg(longLevs).toFixed(1)}x)`, "ls-line-3"),
        formatRow("Short vs Portfolio:", `${shortPVx.toFixed(2)}x (${shortCount} pairs at ${avg(shortLevs).toFixed(1)}x)`, "ls-line-4"),
        formatRow("Net Leverage:", `${netLeverage.toFixed(2)}x ($${netExposure.toLocaleString()})`, "ls-line-5"),
        // New clickable copy row under Net Leverage
        formatCopyEquationRow(
            () => {
                const tableEl = document.querySelector("table");
                return copyTradingViewEquationFromTable(tableEl, 4);
            },
            "ls-line-tv"
        )
    ];

    newRows.forEach(row => container.appendChild(row));
}

function observeTable(table) {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    observer = new MutationObserver(() => {
        injectMetrics();
    });
    observer.observe(table, { childList: true, subtree: true, characterData: true });
    console.log("[Perpetualpulse] MutationObserver attached.");
}

function waitForDomAndData() {
    const table = document.querySelector("table");
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');

    if (table && container && tableHasData(table)) {
        console.log("[Perpetualpulse] DOM & data found. Injecting metrics.");
        injectMetrics();
        observeTable(table);
    } else if (attempt < maxTries) {
        attempt++;
        setTimeout(waitForDomAndData, 500);
    } else {
        console.warn("[Perpetualpulse] DOM/data not ready after max attempts.");
    }
}

waitForDomAndData();

if (window.injectVolatilityColumn) window.injectVolatilityColumn();
