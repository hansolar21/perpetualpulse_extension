// ==UserScript==
// @name         Perpetualpulse Trading Metrics
// @version      1.7
// @description  Injects long/short summary and leverage stats into lighter.xyz, now with robust equity detection & persistent masking (positions-table aware)
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

const maxTries = 40;
let attempt = 0;
let observer = null;

// Persistent mask state (id -> true = masked)
const maskedRows = {};

// ---------- Utils ----------
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
    info.setAttribute(
        "title",
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

    // Hover effect
    const baseColor = "rgba(255,255,255,0.6)";
    const hoverColor = "rgb(212, 68, 77)";
    labelSpan.style.color = baseColor;
    row.addEventListener("mouseenter", () => {
        labelSpan.style.color = hoverColor;
        labelSpan.style.textDecoration = "underline";
    });
    row.addEventListener("mouseleave", () => {
        labelSpan.style.color = baseColor;
        labelSpan.style.textDecoration = "underline";
    });

    // Click handler
    const handler = async (e) => {
        e.stopPropagation();
        try {
            const eq = await onClick();
            const prev = labelSpan.innerText;
            labelSpan.innerText = eq || "Copied!";
            setTimeout(() => (labelSpan.innerText = prev), 2500);
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

    row.appendChild(leftWrap);
    return row;
}

function parseUSD(str) {
    // Strip $, commas, %, x, spaces, NBSP
    return parseFloat((str || "").replace(/[\s\u00A0,$%x]/gi, "")) || 0;
}

// ---------- Robust Equity Detection ----------
let _lastGoodEquity = 0;

function getPortfolioValue() {
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) return 0;

    // Support both old and new class combos; anchor to direct children
    const rows = container.querySelectorAll(
        ':scope > div.flex.w-full.justify-between, :scope > div.flex.w-full.items-center.justify-between'
    );

    for (const row of rows) {
        // Label can be a <p> or <span>
        const labelEl = row.querySelector('p, span');
        const label = (labelEl?.textContent || "").trim().toLowerCase();

        // Be generous with matching to survive copy tweaks
        if (
            /trading\s*equity/.test(label) ||
            /portfolio\s*value/.test(label) ||
            /perps?\s*equity/.test(label) ||
            /\bequity\b/.test(label)
        ) {
            // Value usually sits in '.tabular-nums span', but fall back broadly
            const valueSpan = row.querySelector('.tabular-nums span, span.text-xs.text-gray-0, span');
            if (valueSpan) {
                const val = parseUSD(valueSpan.textContent);
                if (isFinite(val) && val > 0) return val;
            }
        }
    }
    return 0;
}

function safePortfolioValue() {
    const v = getPortfolioValue();
    if (v > 0) _lastGoodEquity = v;
    return v > 0 ? v : _lastGoodEquity;
}

// ---------- Table helpers ----------

// NEW: specific selector for the positions table
function getPositionsTable() {
    return document.querySelector('table[data-testid="positions-table"]') || document.querySelector("table");
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
    sym = sym.replace(/^k(?=[A-Z0-9])/, "");
    return `${sym.toUpperCase()}USDT`;
}

// NEW: grab symbol from structured spans in Market cell
function getSymbolFromMarketCell(td0) {
    // first <span> after the side bar is the token (HYPE, SOL...)
    const spans = td0.querySelectorAll("span");
    for (const sp of spans) {
        const txt = (sp.textContent || "").trim();
        if (txt && /^[A-Za-z0-9]{2,15}$/.test(txt)) return txt;
    }
    // fallback to innerText
    return (td0.textContent || "").trim().split(/\s+/)[0] || "";
}

async function copyTradingViewEquationFromTable(table, weightDecimals = 4) {
    if (!table) throw new Error("No table");

    // NEW: the rows are absolute-positioned with data-testid="row-X"
    const rows = table.querySelectorAll("tbody tr[data-testid^='row-']");

    const positions = [];
    rows.forEach((row) => {
        const tds = row.querySelectorAll("td");
        if (tds.length < 3) return;

        const td0 = tds[0];
        const isLong = !!td0.querySelector('[data-testid="direction-long"]');   // NEW
        const isShort = !!td0.querySelector('[data-testid="direction-short"]'); // NEW
        if (!isLong && !isShort) return;

        const notional = Math.abs(parseUSD(tds[2].innerText));
        if (!(notional > 0)) return;

        const rawSym = getSymbolFromMarketCell(td0); // NEW
        positions.push({
            symbol: normalizeToUSDT(rawSym),
            side: isShort ? "Short" : "Long",
            notional,
        });
    });

    if (positions.length === 0) {
        await navigator.clipboard.writeText("");
        return "";
    }

    const top = positions.sort((a, b) => b.notional - a.notional).slice(0, 10);
    const sumAbs = top.reduce((s, p) => s + Math.abs(p.notional), 0) || 1;

    const terms = top.map((p) => {
        const w = p.notional / sumAbs;
        const exp = (p.side === "Short" ? -w : w).toFixed(weightDecimals);
        return `${p.symbol}^${exp}`;
    });

    const equation = terms.join("*");
    await navigator.clipboard.writeText(equation);
    console.log("[Perpetualpulse] Copied TradingView equation:", equation);
    return equation;
}

// ---------- Core injection ----------
function injectMetrics() {
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) return;
    container.querySelectorAll('[data-injected="ls-info"]').forEach((el) => el.remove());

    const table = getPositionsTable(); // NEW
    if (!table) return;

    let longSum = 0,
        shortSum = 0;
    let longLevs = [],
        shortLevs = [];
    let longCount = 0,
        shortCount = 0;

    // NEW: target explicit row nodes
    const rows = table.querySelectorAll("tbody tr[data-testid^='row-']");
    rows.forEach((row) => {
        const tds = row.querySelectorAll("td");
        if (tds.length < 3) return;

        const td0 = tds[0];
        const value = parseUSD(tds[2].innerText);

        // NEW: detect side via data-testid markers
        const isLong = !!td0.querySelector('[data-testid="direction-long"]');
        const isShort = !!td0.querySelector('[data-testid="direction-short"]');

        // NEW: leverage is the "20x"/"50x" span in td0
        const levTxt = td0.querySelector('span[data-state]')?.textContent || "";
        const leverage = parseFloat(levTxt.replace(/x/i, "")) || 0;

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

    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const portVal = safePortfolioValue();

    // Avoid divide-by-zero; show 0 only if we truly have 0 exposure
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

    const fmtDollar = (n) => `$${Math.round(n).toLocaleString()}`;

    const newRows = [
        formatRow(
            "Long vs Short:",
            `${fmtDollar(longSum)} / ${fmtDollar(shortSum)}`,
            "ls-line-1",
            true
        ),
        formatRow("L/S Ratio:", `${lsRatio} (Longs = ${longRatio})`, "ls-line-2"),
        formatRow(
            "Long vs Portfolio:",
            `${longPVx.toFixed(2)}x (${longCount} pairs at ${avg(longLevs).toFixed(1)}x)`,
            "ls-line-3"
        ),
        formatRow(
            "Short vs Portfolio:",
            `${shortPVx.toFixed(2)}x (${shortCount} pairs at ${avg(shortLevs).toFixed(1)}x)`,
            "ls-line-4"
        ),
        formatRow(
            "Net Leverage:",
            `${netLeverage.toFixed(2)}x (${fmtDollar(netExposure)})`,
            "ls-line-5"
        ),
        formatCopyEquationRow(
            () => {
                const tableEl = getPositionsTable(); // NEW
                return copyTradingViewEquationFromTable(tableEl, 4);
            },
            "ls-line-tv"
        ),
    ];

    newRows.forEach((row) => container.appendChild(row));
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
    // console.log("[Perpetualpulse] MutationObserver attached.");
}

function waitForDomAndData() {
    const table = getPositionsTable(); // NEW
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');

    if (table && container && tableHasData(table)) {
        // console.log("[Perpetualpulse] DOM & data found. Injecting metrics.");
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
