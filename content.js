// ==UserScript==
// @name         Perpetualpulse Trading Metrics
// @version      1.3
// @description  Injects long/short summary and leverage stats into lighter.xyz, now with persistent masking
// ==/UserScript==

console.log("[Perpetualpulse] content.js injected");

const maxTries = 40;
let attempt = 0;
let observer = null;

// Tracks which value rows are masked by id (true = masked)
const maskedRows = {};

// Util: Obscure or reveal value text (asterisk toggle)
function applyMask(span, realText, isMasked) {
    if (isMasked) {
        span.innerText = "******";
        span.setAttribute("data-masked", "1");
    } else {
        span.innerText = realText;
        span.setAttribute("data-masked", "0");
    }
}

// For each row, use persistent mask state keyed by id
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

    // Use persistent masked state
    const isMasked = !!maskedRows[id];
    applyMask(valueSpan, value, isMasked);

    // Toggle mask and update state on click
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

function parseUSD(str) {
    return parseFloat(str.replace(/[$,%x]/gi, '')) || 0;
}

function getPortfolioValue() {
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) return 0;
    const labels = container.querySelectorAll('span.text-xs.text-gray-3');
    for (let label of labels) {
        if (label.innerText.trim().toLowerCase() === "portfolio value:") {
            const valueEl = label.closest('div').nextElementSibling;
            return parseUSD(valueEl?.innerText || '');
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

function injectMetrics() {
    // Remove prior injection to avoid duplicates
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
    const lsRatio = shortSum > 0 ? (longSum / shortSum).toFixed(2) : "∞";

    const newRows = [
        formatRow("Long vs Short:", `$${longSum.toLocaleString()} / $${shortSum.toLocaleString()}`, "ls-line-1", true),
        formatRow("L/S Ratio:", `${lsRatio} (Longs = ${longRatio})`, "ls-line-2"),
        formatRow("Long vs Portfolio:", `${longPVx.toFixed(2)}x (${longCount} pairs at ${avg(longLevs).toFixed(1)}x)`, "ls-line-3"),
        formatRow("Short vs Portfolio:", `${shortPVx.toFixed(2)}x (${shortCount} pairs at ${avg(shortLevs).toFixed(1)}x)`, "ls-line-4")
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
    console.log(`[Perpetualpulse] Attempt ${attempt + 1} to locate DOM and data...`);
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
