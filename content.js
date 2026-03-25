// ==UserScript==
// @name         Perpetualpulse Trading Metrics
// @version      1.8
// @description  Injects long/short summary, leverage stats, and live funding rates into lighter.xyz
// ==/UserScript==

console.log("[Perpetualpulse] content.js injected");
console.log("[Perpetualpulse] patch loaded at", performance.now());

window._patch_test = 1;

// Extension accent color — slight bluish hue to distinguish injected content
const EXT_COLOR = "rgba(160, 195, 255, 0.95)";
const EXT_COLOR_DIM = "rgba(160, 195, 255, 0.70)";
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

// ---------- Risk Constants (fetched from Lighter bundle) ----------
let _riskConstants = null; // { beta: {market_id: val}, vol: {...}, drift: {...} }
let _symbolToMarketId = {}; // symbol -> market_id
let _riskConstantsFetched = false;

// Standard normal CDF approximation (Abramowitz & Stegun)
function normCDF(x, mean = 0, std = 1) {
    const z = (x - mean) / std;
    const a = 1 / (1 + 0.2316419 * Math.abs(z));
    let s = 0.3989423 * Math.exp(-z * z / 2) * a *
        (0.3193815 + a * (-0.3565638 + a * (1.781478 + a * (-1.821256 + a * 1.330274))));
    if (z > 0) s = 1 - s;
    return s;
}

// Per-position liquidation probability
function positionLiqProb(sign, markPrice, liqPrice, volatility, drift) {
    if (!liqPrice) return 0;
    const pctToLiq = (liqPrice - markPrice) / (markPrice || 1);
    let prob = normCDF(pctToLiq, drift, volatility);
    if (sign < 0) prob = 1 - prob;
    return prob;
}

async function fetchRiskConstants() {
    if (_riskConstantsFetched) return _riskConstants;
    _riskConstantsFetched = true;
    try {
        // Get the bundle URL from the page
        const scripts = document.querySelectorAll('script[src*="/assets/index-"]');
        let bundleUrl = null;
        for (const s of scripts) {
            if (s.src.includes('/assets/index-')) { bundleUrl = s.src; break; }
        }
        if (!bundleUrl) {
            // Fallback: fetch the HTML and find it
            const html = await (await fetch(location.origin)).text();
            const m = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
            if (m) bundleUrl = location.origin + m[1];
        }
        if (!bundleUrl) { console.warn("[Perpetualpulse] Could not find bundle URL"); return null; }

        const js = await (await fetch(bundleUrl)).text();

        // Parse constants: kLe (beta), xLe (volatility), wLe (drift)
        function parseObj(name) {
            const re = new RegExp(name + '=\\{([^}]+)\\}');
            const m = js.match(re);
            if (!m) return {};
            const obj = {};
            for (const pair of m[1].split(',')) {
                const [k, v] = pair.split(':');
                if (k !== undefined && v !== undefined) {
                    const nv = Number(v);
                    obj[Number(k)] = isNaN(nv) ? 1 : nv; // 'mr' defaults resolve to 1
                }
            }
            return obj;
        }

        _riskConstants = {
            beta: parseObj('kLe'),
            vol: parseObj('xLe'),
            drift: parseObj('wLe'),
        };
        console.log("[Perpetualpulse] Risk constants loaded:", Object.keys(_riskConstants.beta).length, "markets");
    } catch (e) {
        console.warn("[Perpetualpulse] Failed to fetch risk constants:", e);
    }
    return _riskConstants;
}

async function fetchSymbolToMarketId() {
    if (Object.keys(_symbolToMarketId).length > 0) return _symbolToMarketId;
    try {
        // Use the funding-rates API which has symbol + market_id
        const resp = await fetch("https://mainnet.zklighter.elliot.ai/api/v1/funding-rates");
        const data = await resp.json();
        const rates = data.funding_rates || [];
        for (const r of rates) {
            if (r.exchange === "lighter" && r.symbol && r.market_id !== undefined) {
                _symbolToMarketId[r.symbol.toUpperCase()] = r.market_id;
            }
        }
    } catch (e) {
        console.warn("[Perpetualpulse] Failed to fetch symbol->market_id mapping:", e);
    }
    return _symbolToMarketId;
}

function computeRiskMetrics(positions, equity) {
    // positions: [{ symbol, sign (+1/-1), notional, markPrice, liqPrice }]
    if (!_riskConstants || positions.length === 0 || !equity) return null;

    const DEFAULT_VOL = 0.05;
    const DEFAULT_DRIFT = 0;

    let totalLong = 0, totalShort = 0;
    let longBetaSum = 0, shortBetaSum = 0;
    let varCurrent = 0, varTotal = 0;
    let survivalProduct = 1;

    for (const p of positions) {
        const mid = _symbolToMarketId[p.symbol.toUpperCase()];
        if (mid === undefined) continue;

        const beta = _riskConstants.beta[mid] ?? 1;
        const vol = _riskConstants.vol[mid] ?? DEFAULT_VOL;
        const drift = _riskConstants.drift[mid] ?? DEFAULT_DRIFT;
        const notional = p.notional;

        if (p.sign > 0) {
            totalLong += notional;
            longBetaSum += notional * beta;
        } else {
            totalShort += notional;
            shortBetaSum += notional * beta;
        }

        varCurrent += notional * Math.min(vol * 1.65, 1);
        varTotal += notional;

        const liqProb = positionLiqProb(p.sign, p.markPrice, p.liqPrice, vol, drift);
        survivalProduct *= (1 - liqProb);
    }

    const netPosition = totalLong - totalShort;
    const netBetaNum = longBetaSum - shortBetaSum;
    const netBeta = netPosition ? netBetaNum / netPosition : 0;
    const valueAtRisk = varTotal ? varCurrent / varTotal : 0;
    const probLiq = 1 - survivalProduct;

    return { netBeta, valueAtRisk, probLiq };
}

// ---------- Funding Rate Cache (WebSocket + REST fallback) ----------
let _fundingRates = {};  // symbol -> { lighter: rate, binance: rate, ... }
let _wsFundingRates = {}; // market_id -> current_funding_rate (from WS)
let _fundingLastFetch = 0;
const FUNDING_CACHE_MS = 30_000; // REST fallback refresh every 30s
let _fundingWs = null;
let _fundingWsRetries = 0;
const FUNDING_WS_MAX_RETRIES = 10;

// market_id -> symbol reverse map (built from _symbolToMarketId)
function getMarketIdToSymbol() {
    const map = {};
    for (const [sym, mid] of Object.entries(_symbolToMarketId)) {
        map[mid] = sym;
    }
    return map;
}

function connectFundingWebSocket() {
    if (_fundingWs && (_fundingWs.readyState === WebSocket.OPEN || _fundingWs.readyState === WebSocket.CONNECTING)) return;

    try {
        _fundingWs = new WebSocket("wss://mainnet.zklighter.elliot.ai/stream?encoding=json&readonly=true");

        _fundingWs.onopen = () => {
            console.log("[Perpetualpulse] Funding WS connected");
            _fundingWsRetries = 0;
            // Subscribe to market stats (includes current_funding_rate)
            _fundingWs.send(JSON.stringify({ type: "subscribe", channel: "market_stats/all", flush_interval: "5000" }));
        };

        _fundingWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === "ping") {
                    _fundingWs.send(JSON.stringify({ type: "pong" }));
                    return;
                }
                // Handle both subscribed/market_stats and update/market_stats
                if (msg.type === "subscribed/market_stats" || msg.type === "update/market_stats") {
                    const stats = msg.market_stats || {};
                    for (const [marketId, data] of Object.entries(stats)) {
                        if (data.current_funding_rate !== undefined) {
                            _wsFundingRates[marketId] = Number(data.current_funding_rate);
                        }
                    }
                }
            } catch (e) {
                // ignore parse errors
            }
        };

        _fundingWs.onclose = () => {
            _fundingWs = null;
            if (_fundingWsRetries < FUNDING_WS_MAX_RETRIES) {
                const delay = Math.min(3000 * Math.pow(1.5, _fundingWsRetries), 30000);
                _fundingWsRetries++;
                console.log(`[Perpetualpulse] Funding WS closed, reconnecting in ${Math.round(delay)}ms (attempt ${_fundingWsRetries})`);
                setTimeout(connectFundingWebSocket, delay);
            }
        };

        _fundingWs.onerror = () => {
            // onclose will fire after this
        };
    } catch (e) {
        console.warn("[Perpetualpulse] Failed to open funding WS:", e);
    }
}

async function fetchFundingRates() {
    // Start WS if not running
    connectFundingWebSocket();

    // Also fetch REST as fallback / for other exchange rates
    if (Date.now() - _fundingLastFetch < FUNDING_CACHE_MS && Object.keys(_fundingRates).length > 0) {
        return _fundingRates;
    }
    try {
        const resp = await fetch("https://mainnet.zklighter.elliot.ai/api/v1/funding-rates");
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

    // Prefer live WS current_funding_rate (predicted next rate)
    // WS values are already in percentage form (e.g. 0.0048 = 0.0048%)
    // Convert to raw decimal to match REST format (divide by 100)
    const marketId = _symbolToMarketId[sym];
    if (marketId !== undefined && _wsFundingRates[marketId] !== undefined) {
        return _wsFundingRates[marketId] / 100;
    }

    // Fallback to REST settled rate (already raw decimal, e.g. 4.8e-05 = 0.0048%)
    const rates = _fundingRates[sym];
    if (!rates) return null;
    return rates.lighter ?? rates.binance ?? rates.bybit ?? Object.values(rates)[0] ?? null;
}

function formatFundingRate(rate) {
    if (rate === null || rate === undefined) return "";
    const pct = (rate * 100).toFixed(4);
    const sign = rate >= 0 ? "+" : "";
    return `${sign}${pct}%`;
}

// ---------- Info Icon / Tooltip ----------
function createInfoIcon(tooltipText) {
    const info = document.createElement("span");
    info.innerText = "ⓘ";
    info.title = tooltipText;
    info.style.cssText = `cursor:help;font-size:11px;opacity:0.6;color:${EXT_COLOR_DIM};margin-left:3px;`;
    info.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    return info;
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

function formatRow(label, value, id = "", isFirst = false, tooltip = null) {
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
    valueSpan.style.cssText = `color: ${EXT_COLOR} !important;`;
    valueSpan.setAttribute("data-real", value);

    const isMasked = !!maskedRows[id];
    applyMask(valueSpan, value, isMasked);

    valueSpan.style.cursor = "pointer";
    valueSpan.addEventListener("mousedown", function (e) {
        maskedRows[id] = !(valueSpan.getAttribute("data-masked") === "1");
        applyMask(valueSpan, value, maskedRows[id]);
        e.stopPropagation();
        e.preventDefault();
    }, true);

    labelDiv.appendChild(labelSpan);
    if (tooltip) {
        labelDiv.appendChild(createInfoIcon(tooltip));
    }
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

    const info = createInfoIcon("Paste into TradingView to see a consolidated chart of your current positions. TradingView only supports 10 combined tickers. This equation implies a 1x leverage relative to your equity.");

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
            _feedbackUntil = Date.now() + 2100;
            labelSpan.innerText = eq || "Copied!";
            setTimeout(() => { labelSpan.innerText = "Copy TradingView equation"; }, 2000);
        } catch (err) {
            console.error("[Perpetualpulse] Copy TV equation failed:", err);
        }
    };
    row.addEventListener("mousedown", handler, true);
    leftWrap.addEventListener("mousedown", handler, true);
    labelSpan.addEventListener("mousedown", handler, true);
    icon.addEventListener("mousedown", handler, true);

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

// Column width adjustments — modify inline width on flex-based th/td
// Size: 120px -> 90px, Funding: 70px -> 100px (net zero change)
const COL_WIDTHS = { "size": "90px", "funding": "100px" };

function adjustColumnWidths() {
    const table = getPositionsTable();
    if (!table) return;

    const ths = table.querySelectorAll("thead th");
    const colMap = {}; // header text -> index
    ths.forEach((th, i) => {
        const text = (th.textContent || "").trim().toLowerCase();
        if (text.startsWith("size")) colMap["size"] = i;
        if (text.startsWith("funding")) colMap["funding"] = i;
    });

    function setWidth(el, w) {
        if (!el) return;
        el.style.width = w;
        el.style.minWidth = w;
    }

    // Apply to headers
    for (const [col, w] of Object.entries(COL_WIDTHS)) {
        const idx = colMap[col];
        if (idx !== undefined && ths[idx]) setWidth(ths[idx], w);
    }

    // Apply to all body rows
    const rows = table.querySelectorAll("tbody tr");
    rows.forEach(row => {
        const tds = row.querySelectorAll("td");
        for (const [col, w] of Object.entries(COL_WIDTHS)) {
            const idx = colMap[col];
            if (idx !== undefined && tds[idx]) setWidth(tds[idx], w);
        }
    });
}

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
            rateEl.style.fontSize = "inherit";
            rateEl.style.fontFamily = "inherit";
            rateEl.style.marginRight = "4px";
            rateEl.style.whiteSpace = "nowrap";
            rateEl.textContent = formatFundingRate(rate);

            // Insert before existing content
            fundingTd.insertBefore(rateEl, fundingTd.firstChild);
        }
    });
}

// ---------- Core injection ----------
async function injectMetrics() {
    _injecting = true;
    try {
    const container = document.querySelector('div.flex.flex-col.gap-1\\.5.overflow-auto');
    if (!container) { _injecting = false; return; }
    container.querySelectorAll('[data-injected="ls-info"]').forEach((el) => el.remove());

    const table = getPositionsTable();
    if (!table) return;

    // Fetch funding rates + risk constants (cached, non-blocking after first load)
    await Promise.all([fetchFundingRates(), fetchRiskConstants(), fetchSymbolToMarketId()]);
    adjustColumnWidths();

    // Inject funding rates into position rows
    injectFundingRatesIntoTable(table);

    // Find column indices from headers
    const ths = table.querySelectorAll("thead th");
    let markPriceIdx = -1, liqPriceIdx = -1;
    ths.forEach((th, i) => {
        const text = (th.textContent || "").trim().toLowerCase();
        if (text.includes("mark")) markPriceIdx = i;
        if (text.includes("liq")) liqPriceIdx = i;
    });

    let longSum = 0,
        shortSum = 0;
    let longCount = 0,
        shortCount = 0;
    const riskPositions = []; // for risk metric computation

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

        // Collect data for risk metrics
        if (isLong || isShort) {
            const symbol = getSymbolFromMarketCell(td0);
            const markPrice = markPriceIdx >= 0 && tds[markPriceIdx] ? parseUSD(tds[markPriceIdx].innerText) : 0;
            const liqPrice = liqPriceIdx >= 0 && tds[liqPriceIdx] ? parseUSD(tds[liqPriceIdx].innerText) : 0;
            riskPositions.push({
                symbol,
                sign: isLong ? 1 : -1,
                notional: value,
                markPrice,
                liqPrice,
            });
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

    // Compute risk metrics
    const risk = computeRiskMetrics(riskPositions, portVal);

    const fmtPct = (n) => `${(n * 100).toFixed(2)}%`;

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
    ];

    // Risk metrics (only show if constants loaded)
    if (risk) {
        newRows.push(
            formatRow("Value at Risk:", fmtPct(risk.valueAtRisk), "ls-line-var", false,
                "Expected maximum loss over 24 hours at 95% confidence, based on per-market historical volatility."),
            formatRow("Risk of Liq:", fmtPct(risk.probLiq), "ls-line-liq", false,
                "Probability of liquidation in the next 24 hours, based on per-position distance to liquidation price and market volatility."),
            formatRow("Net Beta:", fmtPct(risk.netBeta), "ls-line-beta", false,
                "Weighted portfolio beta relative to BTC. >100% = more volatile than BTC, <100% = less volatile. Negative = inversely correlated."),
        );
    }

    newRows.push(
        formatCopyEquationRow(
            () => {
                const tableEl = getPositionsTable();
                return copyTradingViewEquationFromTable(tableEl, 4);
            },
            "ls-line-tv"
        ),
    );

    newRows.forEach((row) => container.appendChild(row));
    } finally { _injecting = false; }
}

let _injectPending = false;
let _injecting = false; // guard to ignore mutations we cause
let _feedbackUntil = 0; // suppress re-injection during copy feedback
function observeTable(table) {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    observer = new MutationObserver((mutations) => {
        // Skip all mutations while we're actively injecting
        if (_injecting || Date.now() < _feedbackUntil) return;

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
