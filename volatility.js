// volatility.js

const VOL_INTERVAL = "1h";
const VOL_LOOKBACK = 7 * 24; // 7d of hourly closes

function lighterToBinanceSymbol(lighterSym) {
    const known = {
        "TRUMP": "TRUMPUSDT",
        // Add more special mappings as needed
    };
    if (known[lighterSym]) {
        console.log("[Vol] Ticker", lighterSym, "→(exception)", known[lighterSym]);
        return known[lighterSym];
    }
    // k-prefixed meme coins (kBONK → 1000BONKUSDT)
    if (/^k[A-Z]+$/.test(lighterSym)) {
        const bSym = "1000" + lighterSym.slice(1) + "USDT";
        console.log("[Vol] Ticker", lighterSym, "→(k-prefixed)", bSym);
        return bSym;
    }
    const bSym = lighterSym + "USDT";
    console.log("[Vol] Ticker", lighterSym, "→", bSym);
    return bSym;
}

async function getBinanceVol(lighterSym, interval = VOL_INTERVAL, limit = VOL_LOOKBACK) {
    const binanceSym = lighterToBinanceSymbol(lighterSym);
    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=${interval}&limit=${limit}`;
    console.log("[Vol] Fetching:", url);
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            console.warn("[Vol] Fetch failed for", binanceSym, resp.status, resp.statusText);
            return null;
        }
        const data = await resp.json();
        if (!Array.isArray(data) || !data.length) {
            console.warn("[Vol] No data for", binanceSym, data);
            return null;
        }
        const closes = data.map(row => parseFloat(row[4]));
        if (closes.length < 2) {
            console.warn("[Vol] Not enough close data for", binanceSym, closes);
            return null;
        }
        const logReturns = [];
        for (let i = 1; i < closes.length; ++i) {
            logReturns.push(Math.log(closes[i] / closes[i - 1]));
        }
        const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
        const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / logReturns.length;
        const annVol = Math.sqrt(variance) * Math.sqrt(24 * 365);
        const pctVol = annVol * 100;
        console.log(`[Vol] Calculated vol for ${binanceSym}: ${pctVol.toFixed(2)}%`);
        return pctVol;
    } catch (e) {
        console.error("[Vol] Error for", binanceSym, e);
        return null;
    }
}

async function injectVolatilityColumn() {
    const table = document.querySelector('table[data-testid="positions-table"]');
    if (!table) {
        console.warn("[Vol] Table not found");
        return;
    }

    // Header: find "TP / SL" th, insert after it
    const thead = table.querySelector("thead");
    if (!thead) {
        console.warn("[Vol] Thead not found");
        return;
    }
    const headerRow = thead.querySelector("tr");
    const ths = headerRow.querySelectorAll("th");
    let tpIdx = Array.from(ths).findIndex(th => /TP\s*\/\s*SL/i.test(th.innerText));
    if (tpIdx === -1) {
        console.warn("[Vol] TP/SL column not found");
        return;
    }

    // Prevent double-injection
    if (headerRow.querySelector("th[data-injected='vol-col']")) {
        console.log("[Vol] Column already injected");
        return;
    }

    const volTh = document.createElement("th");
    volTh.innerText = "7d Vol";
    volTh.setAttribute("data-injected", "vol-col");
    headerRow.insertBefore(volTh, ths[tpIdx + 1] || null);

    // Gather all visible symbols in body
    const tbody = table.querySelector("tbody");
    if (!tbody) {
        console.warn("[Vol] Tbody not found");
        return;
    }
    const rows = tbody.querySelectorAll("tr");
    let symbols = [];
    rows.forEach((row, i) => {
        const tds = row.querySelectorAll("td");
        let symbol = tds[0]?.querySelector("span")?.innerText?.trim();
        console.log(`[Vol] Row ${i} symbol:`, symbol);
        if (symbol && !symbols.includes(symbol)) symbols.push(symbol);
    });
    console.log("[Vol] All symbols detected:", symbols);

    // Fetch all vols in parallel
    const vols = {};
    await Promise.all(symbols.map(async (sym) => {
        const v = await getBinanceVol(sym);
        vols[sym] = v;
    }));

    // Inject cell into each row after TP/SL column
    rows.forEach((row, i) => {
        const tds = row.querySelectorAll("td");
        let symbol = tds[0]?.querySelector("span")?.innerText?.trim();
        const cell = document.createElement("td");
        cell.setAttribute("data-injected", "vol-col");
        cell.style.textAlign = "right";
        cell.style.fontVariantNumeric = "tabular-nums";
        if (symbol && vols[symbol] !== undefined && vols[symbol] !== null) {
            cell.innerText = vols[symbol].toFixed(2) + "%";
        } else {
            cell.innerText = "-";
        }
        row.insertBefore(cell, tds[tpIdx + 1] || null);
        console.log(`[Vol] Injected cell for row ${i} (${symbol}):`, cell.innerText);
    });
    console.log("[Vol] Injection complete.");
}

// Wait for positions table to load and be populated
function waitForPositionsTableAndInjectVolCol(maxTries = 40) {
    let tries = 0;
    function attempt() {
        const table = document.querySelector('table[data-testid="positions-table"]');
        const rows = table?.querySelectorAll('tbody tr');
        if (table && rows && rows.length > 0) {
            window.injectVolatilityColumn();
        } else if (tries++ < maxTries) {
            setTimeout(attempt, 500);
        } else {
            console.warn("[Vol] Could not find populated positions table after max tries.");
        }
    }
    attempt();
}

// Export for dev, but auto-run for SPA/extension
window.injectVolatilityColumn = injectVolatilityColumn;
waitForPositionsTableAndInjectVolCol();
