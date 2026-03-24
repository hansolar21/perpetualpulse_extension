// ==UserScript==
// @name         Perpetualpulse Trading Metrics
// @version      1.8
// @description  Injects long/short summary, leverage stats, and live funding rates into lighter.xyz
// ==/UserScript==

console.log("[Perpetualpulse] content.js injected");
console.log("[Perpetualpulse] patch loaded at", performance.now());

window._patch_test = 1;

// Extension accent color — slight bluish hue to distinguish injected content
const EXT_COLOR = "rgba(130, 170, 255, 0.85)";
const EXT_COLOR_DIM = "rgba(130, 170, 255, 0.55)";
const EXT_BG = "transparent";

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

// ---------- Funding Rate Cache ----------
let _fundingRates = {};  // symbol -> { lighter: rate, binance: rate, ... }
let _fundingLastFetch = 0;
const FUNDING_CACHE_MS = 30_000; // refresh every 30s

async function fetchFundingRates() {
    if (Date.now() - _fundingLastFetch < FUNDING_CACHE_MS && Object.keys(_fundingRates).length > 0) {
        return _fundingRates;
    }
    try {
        const resp = await fetch("https://mainnet.zklighter.elliot.ai/api/v1/fundingRates");
        const data = await resp.json();
        const rates = data.funding_rates || data.fundingRates || [];
        const newRates = {};
        for (const r of rates) {
            const sym = (r.symbol || "").toUpperCase();
            if (!newRates[sym]) newRates[sym] = {};
            newRates[sym][r.exchange || "lighter"] = r.rate;
        }
        _fundingRates = newRates;
        _fundingLastFetch = Date.now();
    } catch (e) {
        console.warn("[Perpetualpulse] Failed to fetch funding rates:", e);
    }
    return _fundingRates;
}

function getFundingRate(symbol) {
    const sym = (symbol || "").toUpperCase();
    const rates = _fundingRates[sym];
    if (!rates) return null;
    // Prefer lighter's own rate, then binance, then first available
    return rates.lighter ?? rates.binance ?? rates.bybit ?? Object.values(rates)[0] ?? null;
}

function formatFundingRate(rate) {
    if (rate === null || rate === undefined) return "";
    const pct = (rate * 100).toFixed(4);
    const sign = rate >= 0 ? "+" : "";
    return `${sign}${pct}%`;
}

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
        row.style.borderTop = "1px solid rgba(130, 170, 255, 0.15)";
        row.style.paddingTop = "4px";
        row.style.marginTop = "4px";
    }

    const labelDiv = document.createElement("div");
    labelDiv.setAttribute("data-state", "closed");

    const labelSpan = document.createElement("span");
    labelSpan.className = "text-xs";
    labelSpan.innerText = label;
    labelSpan.style.cursor = "pointer";
    labelSpan.style.color = EXT_COLOR_DIM;
    labelSpan.style.textDecoration = "underline";

    const valueSpan = document.createElement("span");
    valueSpan.className = "text-xs";
    valueSpan.style.color = EXT_COLOR;
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

/** Action row: whole line clickable to copy equation */
function formatCopyEquationRow(onClick, id = "") {
    const row = document.createElement("div");
    row.className = "flex w-full items-center justify-between";
    row.setAttribute("data-injected", "ls-info");
    if (id) row.setAttribute("data-injected-id", id);

    const leftWrap = document.createElement("div");
    leftWrap.className = "flex items-center gap-2";

    const labelSpan = document.createElement("span");
    labelSpan.className = "text-xs";
    labelSpan.innerText = "Copy TradingView equation";
    labelSpan.style.cursor = "pointer";
    labelSpan.style.color = EXT_COLOR_DIM;
    labelSpan.style.textDecoration = "underline";

    const icon = document.createElement("span");
    icon.innerText = "📋";
    icon.setAttribute("aria-hidden", "true");
    icon.style.fontSize = "12px";

    const info = document.createElement("span");
    info.innerText = "ⓘ";
    info.setAttribute(
        "title",
        "Paste into TradingView to see a consolidated chart of your current positions. TradingView only supports 10 combined tickers. This equation implies a 1x leverage relative to your equity."
    );
    info.style.cursor = "help";
    info.style.fontSize = "12px";
    info.style.opacity = "0.8";
    info.style.color = EXT_COLOR_DIM;

    leftWrap.appendChild(icon);
    leftWrap.appendChild(labelSpan);
    leftWrap.appendChild(info);

    row.style.cursor = "pointer";
    row.style.userSelect = "none";

    const hoverColor = "rgb(212, 68, 77)";
    row.addEventListener("mouseenter", () => {
        labelSpan.style.color = hoverColor;
    });
    row.addEventListener("mouseleave", () => {
        labelSpan.style.color = EXT_COLOR_DIM;
    });

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
    return parseFloat((str || "").replace(/[\s\u00A0,$%x]/gi, "")) || 0;
}

// ---------- Robust Equity Detection ----------
let _lastGoodEquity = 0;

function getPortfolioValue() {
    for (const testId of [
        'account-overview-perps-equity',
        'account-overview-total-account-value'
    ]) {
        const el = document.querySelector(`[data-testid="${testId}"]`);
        if (el) {
            const valEl = el.querySelector('.tabular-nums span, span') || el;
            const val = parseUSD(valEl.textContent);
            if (isFinite(val) && val > 0) return val;
        }
    }

    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) return 0;

    const rows = container.querySelectorAll(
        ':scope > div.flex.w-full.justify-between, :scope > div.flex.w-full.items-center.justify-between'
    );

    for (const row of rows) {
        const labelEl = row.querySelector('p, span');
        const label = (labelEl?.textContent || "").trim().toLowerCase();

        if (
            /trading\s*equity/.test(label) ||
            /portfolio\s*value/.test(label) ||
            /perps?\s*equity/.test(label) ||
            /unified\s*equity/.test(label) ||
            /\bequity\b/.test(label)
        ) {
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

function normalizeToUSDT(rawSymbol) {
    if (!rawSymbol) return "";
    let sym = String(rawSymbol).split("\n")[0].trim();
    sym = sym.replace(/[:/.\-\s]/g, "");
    sym = sym.replace(/USDT$/i, "");
    sym = sym.replace(/^k(?=[A-Z0-9])/, "");
    return `${sym.toUpperCase()}USDT`;
}

function getSymbolFromMarketCell(td0) {
    const spans = td0.querySelectorAll("span");
    for (const sp of spans) {
        const txt = (sp.textContent || "").trim();
        if (txt && /^[A-Za-z0-9]{2,15}$/.test(txt)) return txt;
    }
    return (td0.textContent || "").trim().split(/\s+/)[0] || "";
}

async function copyTradingViewEquationFromTable(table, weightDecimals = 4) {
    if (!table) throw new Error("No table");

    const rows = table.querySelectorAll("tbody tr[data-testid^='row-']");

    const positions = [];
    rows.forEach((row) => {
        const tds = row.querySelectorAll("td");
        if (tds.length < 3) return;

        const td0 = tds[0];
        const isLong = !!td0.querySelector('[data-testid="direction-long"]');
        const isShort = !!td0.querySelector('[data-testid="direction-short"]');
        if (!isLong && !isShort) return;

        const notional = Math.abs(parseUSD(tds[2].innerText));
        if (!(notional > 0)) return;

        const rawSym = getSymbolFromMarketCell(td0);
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

// ---------- Column resizing & funding injection ----------

// Column resizing removed — Lighter uses virtualized table with fixed column widths

function injectFundingRatesIntoTable(table) {
    if (!table) return;

    const rows = table.querySelectorAll("tbody tr[data-testid^='row-']");

    // Find funding column index by scanning headers
    const ths = table.querySelectorAll("thead th, thead td");
    let fundingColIdx = -1;
    ths.forEach((th, i) => {
        const text = (th.textContent || "").trim().toLowerCase();
        if (text.includes("funding")) fundingColIdx = i;
    });

    // Fallback: scan all columns for cells containing "$" that look like funding values
    // Funding column is typically the last or second-to-last column with $ values
    if (fundingColIdx < 0) {
        // Try to detect from row data — funding cells often have small $ values
        const firstRow = rows[0];
        if (firstRow) {
            const tds = firstRow.querySelectorAll("td");
            for (let i = tds.length - 1; i >= 3; i--) {
                const text = (tds[i].textContent || "").trim();
                if (text.includes("$") && !text.includes("/")) {
                    fundingColIdx = i;
                    break;
                }
            }
        }
    }

    if (fundingColIdx < 0) {
        console.log("[Perpetualpulse] Could not find funding column");
        return;
    }

    rows.forEach((row) => {
        const tds = row.querySelectorAll("td");
        if (tds.length <= fundingColIdx) return;

        const td0 = tds[0];
        const symbol = getSymbolFromMarketCell(td0);
        const rate = getFundingRate(symbol);

        const fundingTd = tds[fundingColIdx];

        // Remove any previously injected rate
        fundingTd.querySelectorAll("[data-pp-funding]").forEach((el) => el.remove());

        if (rate !== null) {
            const rateEl = document.createElement("span");
            rateEl.setAttribute("data-pp-funding", "1");
            rateEl.style.color = rate >= 0 ? "rgba(130, 255, 170, 0.9)" : "rgba(255, 130, 130, 0.9)";
            rateEl.style.fontSize = "10px";
            rateEl.style.fontFamily = "monospace";
            rateEl.style.marginRight = "4px";
            rateEl.textContent = formatFundingRate(rate);

            // Insert before existing content
            fundingTd.insertBefore(rateEl, fundingTd.firstChild);
        }
    });
}

// ---------- Core injection ----------
async function injectMetrics() {
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) return;
    container.querySelectorAll('[data-injected="ls-info"]').forEach((el) => el.remove());

    const table = getPositionsTable();
    if (!table) return;

    // Fetch funding rates (cached, non-blocking after first load)
    await fetchFundingRates();

    // Inject funding rates into position rows
    injectFundingRatesIntoTable(table);

    let longSum = 0,
        shortSum = 0;
    let longCount = 0,
        shortCount = 0;

    const rows = table.querySelectorAll("tbody tr[data-testid^='row-']");
    rows.forEach((row) => {
        const tds = row.querySelectorAll("td");
        if (tds.length < 3) return;

        const td0 = tds[0];
        const value = parseUSD(tds[2].innerText);

        const isLong = !!td0.querySelector('[data-testid="direction-long"]');
        const isShort = !!td0.querySelector('[data-testid="direction-short"]');

        if (isLong) {
            longSum += value;
            longCount++;
        } else if (isShort) {
            shortSum += value;
            shortCount++;
        }
    });

    const portVal = safePortfolioValue();

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
            `${longPVx.toFixed(2)}x (${longCount} pairs)`,
            "ls-line-3"
        ),
        formatRow(
            "Short vs Portfolio:",
            `${shortPVx.toFixed(2)}x (${shortCount} pairs)`,
            "ls-line-4"
        ),
        formatRow(
            "Net Leverage:",
            `${netLeverage.toFixed(2)}x (${fmtDollar(netExposure)})`,
            "ls-line-5"
        ),
        formatCopyEquationRow(
            () => {
                const tableEl = getPositionsTable();
                return copyTradingViewEquationFromTable(tableEl, 4);
            },
            "ls-line-tv"
        ),
    ];

    newRows.forEach((row) => container.appendChild(row));
}

let _injectPending = false;
function observeTable(table) {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    observer = new MutationObserver((mutations) => {
        // Skip mutations caused by our own injections
        const isOwnMutation = mutations.every(m => {
            if (m.type === "childList") {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1 && (node.getAttribute?.("data-pp-funding") || node.getAttribute?.("data-injected"))) return true;
                }
                for (const node of m.removedNodes) {
                    if (node.nodeType === 1 && (node.getAttribute?.("data-pp-funding") || node.getAttribute?.("data-injected"))) return true;
                }
            }
            return false;
        });
        if (isOwnMutation) return;

        // Debounce to prevent rapid re-fires
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

function waitForDomAndData() {
    const table = getPositionsTable();
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');

    if (table && container && tableHasData(table)) {
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
