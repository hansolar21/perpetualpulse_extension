// market-columns.js — Lighter market selector: adds Spread and 7D Funding columns.
// Lighter's table is virtualized and owned by React, so injected cells are only ever
// appended to the end of a row and are re-checked on every tick.
// Live prices come from the market_stats socket in content.js (_marketStats).

(function () {
    "use strict";

    const API_BASE = _PP_lighterBackend.api;
    const TICK_MS = 500;
    const STATS_STALE_MS = 15_000;
    const CONNECT_INTERVAL_MS = 30_000; // opening a socket counts against the REST rate limit

    // Standard accounts get 60 REST requests a minute, shared with Lighter's own app on
    // this IP, so history is fetched one market at a time for visible rows only.
    const FETCH_INTERVAL_MS = 2_000;
    const RATE_LIMIT_PAUSE_MS = 5 * 60_000;
    const FAILURE_RETRY_MS = 5 * 60_000;
    // History never expires, since settled funding can't change. A market that has fallen
    // behind shows what's stored and catches up slowly, at a lower priority than first loads.
    const CATCH_UP_INTERVAL_MS = 10_000;
    const CATCH_UP_RETRY_MS = 30 * 60_000;
    const BEHIND_HOURS = 2; // the newest hour may not have settled yet
    // Market IDs differ between Lighter sites, so each keeps its own cache
    const CACHE_KEY = _PP_lighterBackend.isMainnet ? "pp_funding_7d" : "pp_funding_7d_robinhood";
    const WINDOW_HOURS = 168;
    const HOUR_S = 3_600;
    const ACTIVE_FUNDING_MAX_AGE_MS = 2 * 3_600_000;

    const COL_SPREAD = "spread";
    const COL_FUNDING = "funding";
    const COL_WIDTHS = { [COL_SPREAD]: 84, [COL_FUNDING]: 84 };
    const MIN_MARKET_WIDTH = 150;
    const COLORS = { green: "rgb(38, 194, 129)", red: "rgb(234, 84, 85)", amber: "rgb(255, 171, 0)", dim: "rgba(255,255,255,0.45)" };

    let fundingCache = {}; // market_id -> { hours: [[tsSeconds, signedRate], ...], fetchedAt }
    let cacheLoaded = false;
    let cacheSaveTimer = null;
    const failedAt = {}; // market_id -> ms
    let lastFetchAt = 0;
    let fetching = false;
    let pausedUntil = 0;
    let lastConnectAt = 0;
    const marketWidths = {}; // column set -> shrunken Market column width, when the table overflows

    // Lighter only mounts the rows in view and sorts them from its own data, so a sort on an
    // added column shows copies of every row in a list laid over the real one. Clicks on a
    // copy are replayed on the real row, so Lighter still handles them.
    // The order is set by a click and stays put until the next one. Last Price and 24h update
    // live from the socket; the columns it can't reproduce come from an occasional re-read.
    const SORT_REREAD_MS = 60_000;
    const SORT_DRIFT_CHECK_MS = 2_000;
    const SORT_SCAN_DELAY_MS = 60; // the longest a step waits for Lighter to mount rows
    const SORT_SCAN_POLL_MS = 10;
    const SORT_MOVE_TRANSITION = "transform 180ms ease-out";
    const SORT_GLIDE_ROWS = 3;
    const SORT_CLICK_WAIT_MS = 1_500; // long enough to outlast a scan already running
    const SORT_BUTTON_SETTLE_MS = 150;
    const DEFAULT_ROW_HEIGHT = 32;
    const TRANSLATE_Y = /translateY\((\d+(?:\.\d+)?)px\)/;
    const sortState = { col: null, dir: 1 };
    let view = null;

    // ---------- Formatting ----------
    function spreadBps(stats) {
        const bid = Number(stats?.bid), ask = Number(stats?.ask);
        if (!(bid > 0) || !(ask > bid)) return null;
        return ((ask - bid) / ((ask + bid) / 2)) * 10_000;
    }

    function formatBps(bps) {
        if (bps === null) return { text: "—", color: COLORS.dim };
        const text = bps < 1 ? bps.toFixed(2) : bps < 10 ? bps.toFixed(1) : bps.toFixed(0);
        return { text, color: bps >= 50 ? COLORS.red : bps >= 10 ? COLORS.amber : "" };
    }

    function hoursBehind(entry) {
        const last = entry?.hours?.at(-1)?.[0];
        if (last === undefined) return Infinity;
        return Math.floor((Date.now() / 1000 - last) / HOUR_S);
    }

    function fundingSummary(entry) {
        if (!entry?.hours?.length) return null;
        const cutoff = Date.now() / 1000 - WINDOW_HOURS * HOUR_S;
        const hours = entry.hours.filter(([ts]) => ts > cutoff);
        if (!hours.length) return null;
        return {
            sum: hours.reduce((total, [, rate]) => total + rate, 0),
            count: hours.length,
            // Measured at the old end: stored data that's merely behind still goes back 7 days
            isNewMarket: hours[0][0] - cutoff > BEHIND_HOURS * HOUR_S,
            behind: hoursBehind(entry),
        };
    }

    function formatFunding(summary) {
        if (!summary) return { text: "—", color: COLORS.dim, title: "" };
        const { sum, count, isNewMarket, behind } = summary;
        const value = `${sum > 0 ? "+" : ""}${sum.toFixed(2)}%`;
        const notes = [`Sum of ${count}h of hourly funding.`];
        if (isNewMarket) notes.push("Market has under 7 days of history.");
        if (behind >= BEHIND_HOURS) notes.push(`Missing the latest ${behind}h, updating.`);
        notes.push("Positive: longs paid shorts.");
        return {
            text: isNewMarket ? `${value}*` : value,
            color: sum > 0 ? COLORS.green : sum < 0 ? COLORS.red : "",
            title: notes.join(" "),
        };
    }

    // ---------- Funding history ----------
    function loadCache() {
        chrome.storage.local.get(CACHE_KEY, (data) => {
            fundingCache = data?.[CACHE_KEY] || {};
            cacheLoaded = true;
        });
    }

    function saveCacheSoon() {
        if (cacheSaveTimer) return;
        cacheSaveTimer = setTimeout(() => {
            cacheSaveTimer = null;
            try { chrome.storage.local.set({ [CACHE_KEY]: fundingCache }); } catch (e) {} // extension was reloaded
        }, 5_000);
    }

    function isActivePerp(stats) {
        // Spot markets have no funding timestamp, and delisted perps stop settling
        return stats && Date.now() - Number(stats.fundingTs || 0) < ACTIVE_FUNDING_MAX_AGE_MS;
    }

    function canFetch(stats) {
        return isActivePerp(stats) && Date.now() - (failedAt[stats.marketId] || 0) >= FAILURE_RETRY_MS;
    }

    function needsFirstLoad(stats) {
        return canFetch(stats) && !fundingCache[stats.marketId];
    }

    function needsCatchUp(stats) {
        if (!canFetch(stats)) return false;
        const entry = fundingCache[stats.marketId];
        return !!entry && hoursBehind(entry) >= BEHIND_HOURS && Date.now() - entry.fetchedAt >= CATCH_UP_RETRY_MS;
    }

    // Asks only for the hours not stored yet. Still one request per market, however few hours.
    async function fetchFunding(marketId) {
        const end = Math.floor(Date.now() / 1000);
        const windowStart = end - WINDOW_HOURS * HOUR_S;
        const stored = fundingCache[marketId]?.hours || [];
        const start = Math.max(stored.at(-1)?.[0] ?? windowStart, windowStart);
        const hoursWanted = Math.min(Math.ceil((end - start) / HOUR_S) + 1, WINDOW_HOURS);
        const url = `${API_BASE}/fundings?market_id=${marketId}&resolution=1h&start_timestamp=${start}&end_timestamp=${end}&count_back=${hoursWanted}`;
        fetching = true;
        lastFetchAt = Date.now();
        try {
            const resp = await fetch(url);
            if (resp.status === 429 || resp.status === 405) {
                pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
                console.warn("[Perpetualpulse] Rate limited, pausing funding history requests");
                return;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const merged = new Map(stored);
            for (const f of data.fundings || []) {
                merged.set(f.timestamp, f.direction === "short" ? -Number(f.rate) : Number(f.rate));
            }
            fundingCache[marketId] = {
                hours: [...merged].filter(([ts]) => ts > windowStart).sort((a, b) => a[0] - b[0]),
                fetchedAt: Date.now(),
            };
            saveCacheSoon();
        } catch (e) {
            failedAt[marketId] = Date.now();
        } finally {
            fetching = false;
        }
    }

    // Each hourly settlement arrives over the socket, so cached markets stay current
    // without REST as long as no hour was missed.
    function appendSettledFunding() {
        if (!cacheLoaded || !socketIsLive()) return;
        let changed = false;
        for (const stats of Object.values(_marketStats)) {
            const entry = fundingCache[stats.marketId];
            if (!entry?.hours?.length || stats.fundingRate === undefined || !stats.fundingTs) continue;
            const settledAt = Math.floor(Number(stats.fundingTs) / 1000 / HOUR_S) * HOUR_S;
            const last = entry.hours[entry.hours.length - 1][0];
            if (settledAt !== last + HOUR_S) continue;
            entry.hours.push([settledAt, Number(stats.fundingRate)]);
            if (entry.hours.length > WINDOW_HOURS) entry.hours.shift();
            entry.fetchedAt = Date.now();
            changed = true;
        }
        if (changed) saveCacheSoon();
    }

    // ---------- DOM ----------
    function socketIsLive() {
        return _fundingWs?.readyState === WebSocket.OPEN && Date.now() - _marketStatsUpdatedAt < STATS_STALE_MS;
    }

    function rowSymbol(row) {
        return (row.children[0]?.innerText || "").split("\n")[0].trim().toUpperCase();
    }

    function setCell(cell, { text, color, title = "" }) {
        if (cell.textContent !== text) cell.textContent = text;
        if (cell.style.color !== color) cell.style.color = color;
        if (cell.title !== title) cell.title = title;
    }

    // Keep exactly the wanted injected columns, in order, at the end of a row.
    function syncColumns(row, template, columns, build) {
        const existing = [...row.querySelectorAll(":scope > [data-pp-col]")];
        const current = existing.map((el) => el.dataset.ppCol).join();
        if (current !== columns.join()) {
            existing.forEach((el) => el.remove());
            for (const col of columns) {
                const cell = template.cloneNode(false);
                cell.dataset.ppCol = col;
                cell.style.width = `${COL_WIDTHS[col]}px`;
                row.appendChild(build ? build(cell, col) : cell);
            }
        }
        return Object.fromEntries([...row.querySelectorAll(":scope > [data-pp-col]")].map((el) => [el.dataset.ppCol, el]));
    }

    function findScroller(el) {
        for (let node = el; node && node !== document.body; node = node.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
        }
        return null;
    }

    // The added columns come out of the Market column, which has the most spare room.
    function fitMarketWidth(columnsKey, table, headerRow) {
        const scroller = findScroller(table);
        const excess = scroller ? scroller.scrollWidth - scroller.clientWidth : 0;
        if (excess > 0) {
            const current = headerRow.children[0].getBoundingClientRect().width;
            marketWidths[columnsKey] = Math.max(MIN_MARKET_WIDTH, Math.floor(current - excess));
        }
        return marketWidths[columnsKey] ?? null;
    }

    // React only rewrites this style when its own value changes, so it is safe to override.
    function setMarketWidth(cell, width) {
        if (!cell) return;
        if (width === null) {
            if (cell.dataset.ppBaseWidth !== undefined) {
                cell.style.width = cell.dataset.ppBaseWidth;
                delete cell.dataset.ppBaseWidth;
            }
            return;
        }
        if (cell.dataset.ppBaseWidth === undefined) cell.dataset.ppBaseWidth = cell.style.width;
        const value = `${width}px`;
        if (cell.style.width !== value) cell.style.width = value;
    }

    const HEADER_LABELS = {
        [COL_SPREAD]: { text: "Spread bps", title: "Best bid/ask spread in basis points" },
        [COL_FUNDING]: { text: "7D Funding", title: "Cumulative hourly funding over 7 days. Positive: longs paid shorts. * = under 7 days of history." },
    };

    function buildHeaderCell(cell, col) {
        cell.style.cursor = "pointer";
        const label = document.createElement("span");
        label.className = "truncate";
        label.textContent = HEADER_LABELS[col].text;
        label.title = HEADER_LABELS[col].title;
        const resort = document.createElement("span");
        resort.textContent = "↻";
        resort.title = "Values have changed since this order was set. Click to re-sort.";
        resort.dataset.ppResort = "";
        resort.style.cssText = "display:none;flex-shrink:0;padding:0 4px;color:rgb(255,255,255);";
        resort.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!view?.rows.length) return;
            applyOrder(view);
            view.overlay.scrollTop = 0;
        });
        cell.append(label, resort);
        cell.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleSort(col);
            tick(); // don't wait for the next one
        });
        return cell;
    }

    function renderRowCells(cells, stats, live) {
        setCell(cells[COL_SPREAD], formatBps(live ? spreadBps(stats) : null));
        if (!cells[COL_FUNDING]) return;
        const entry = stats ? fundingCache[stats.marketId] : null;
        const summary = fundingSummary(entry);
        const waiting = !entry || (!summary && entry.hours.length > 0);
        const loading = waiting && isActivePerp(stats) && !failedAt[stats.marketId];
        setCell(cells[COL_FUNDING], loading
            ? { text: "…", color: COLORS.dim, title: "Loading funding history" }
            : formatFunding(summary));
    }

    // ---------- Sorting by an added column ----------
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function toggleSort(col) {
        if (sortState.col !== col) {
            sortState.col = col;
            sortState.dir = -1; // highest first
        } else if (sortState.dir < 0) {
            sortState.dir = 1;
        } else {
            sortState.col = null;
            closeView();
        }
        if (view?.rows.length) {
            applyOrder(view);
            view.overlay.scrollTop = 0;
        }
    }

    function stopSort() {
        sortState.col = null;
        closeView();
    }

    function closeView() {
        if (!view) return;
        view.overlay.remove();
        view.tbody.style.opacity = "";
        view.tbody.style.pointerEvents = "";
        view.scroller.style.scrollbarColor = "";
        view = null;
    }

    function sortValue(stats) {
        if (sortState.col === COL_SPREAD) return spreadBps(stats);
        return fundingSummary(stats ? fundingCache[stats.marketId] : null)?.sum ?? null;
    }

    function rankRows(v) {
        return v.rows
            .map((row) => ({ row, value: sortValue(_marketStats[row.symbol]) }))
            .sort((a, b) => {
                if (a.value === null || b.value === null) {
                    if (a.value === b.value) return a.row.index - b.row.index;
                    return a.value === null ? 1 : -1; // markets with no value stay last
                }
                return (a.value - b.value) * sortState.dir || a.row.index - b.row.index;
            });
    }

    function applyOrder(v) {
        const ranked = rankRows(v);
        placeRows(v, ranked.map(({ row }) => row));
        v.orderedValues = ranked.filter(({ value }) => value !== null).length;
        v.drifted = false;
    }

    function hasDrifted(v) {
        const ranked = rankRows(v);
        return ranked.some(({ row }, i) => row !== v.display[i]);
    }

    // Values that weren't there when the order was set can still be placed: funding history as
    // it loads, and spreads if the socket wasn't up yet. Changes to known values wait for a click.
    function hasNewValues(v) {
        const count = v.rows.filter((row) => sortValue(_marketStats[row.symbol]) !== null).length;
        return count > v.orderedValues && (sortState.col === COL_FUNDING || v.orderedValues === 0);
    }

    function placeRows(v, ordered) {
        v.display = ordered;
        // Only short moves glide: a row crossing the list would leave it empty until it arrived,
        // and rows have no background, so their text would pass through each other.
        const glideLimit = SORT_GLIDE_ROWS * v.rowHeight;
        ordered.forEach((row, i) => {
            const target = i * v.rowHeight;
            const current = Number(row.el.style.transform.match(TRANSLATE_Y)?.[1] ?? Infinity);
            row.el.style.transition = Math.abs(target - current) <= glideLimit ? SORT_MOVE_TRANSITION : "none";
            row.el.style.transform = `translateY(${target}px)`;
        });
    }

    function keepOrder(v, previous) {
        const position = new Map(previous.map((row, i) => [row.symbol, i]));
        const place = (row) => position.get(row.symbol) ?? Infinity;
        placeRows(v, [...v.rows].sort((a, b) => place(a) - place(b) || a.index - b.index));
    }

    function rowHeightOf(tbody) {
        const second = tbody.querySelector('[data-index="1"]');
        const match = second?.style.transform.match(TRANSLATE_Y);
        return match ? Number(match[1]) : DEFAULT_ROW_HEIGHT;
    }

    function viewKey(tbody, headerRow) {
        const first = tbody.querySelector('[data-index="0"]');
        return `${tbody.style.height}|${headerRow.children.length}|${first ? rowSymbol(first) : ""}`;
    }

    function copyRow(row) {
        const el = row.cloneNode(true);
        for (const node of [el, ...el.querySelectorAll("[data-testid]")]) node.removeAttribute("data-testid");
        el.removeAttribute("data-index");
        return el;
    }

    function createView(table, tbody, scroller, ensureCells) {
        const overlay = document.createElement("div");
        overlay.className = scroller.className;
        overlay.dataset.ppSortView = "";
        overlay.style.cssText = "position:absolute;left:0;right:0;bottom:0;z-index:4;";
        const inner = document.createElement("div");
        inner.className = table.className;
        inner.style.cssText = "display:block;position:relative;";
        overlay.appendChild(inner);
        overlay.addEventListener("click", onViewClick);
        scroller.parentElement.appendChild(overlay);
        // The rows on screen carry straight over, so nothing disappears while the list is read
        const rows = [...tbody.children].filter((row) => Number.isInteger(Number(row.dataset.index))).map((row) => {
            ensureCells(row);
            return { symbol: rowSymbol(row), el: copyRow(row), index: Number(row.dataset.index) };
        });
        inner.append(...rows.map((row) => row.el));
        inner.style.height = tbody.style.height;
        tbody.style.opacity = "0";
        tbody.style.pointerEvents = "none";
        scroller.style.scrollbarColor = "transparent transparent"; // the hidden list moves during a read
        return { overlay, inner, tbody, scroller, rows, display: [], key: null, scanning: false, clicking: false, startTop: scroller.scrollTop,
            scannedAt: 0, driftCheckedAt: 0, drifted: false, orderedValues: 0, rowHeight: DEFAULT_ROW_HEIGHT };
    }

    // Walks the hidden real list to read every row, since only those in view exist.
    function updateCopy(el, fresh) {
        [...fresh.children].forEach((cell, i) => {
            const current = el.children[i];
            if (!current) el.appendChild(cell);
            else if (current.innerHTML !== cell.innerHTML) current.replaceWith(cell);
        });
    }

    async function scanRows(v, headerRow, ensureCells, layout) {
        v.scanning = true;
        const { scroller, tbody } = v;
        const found = new Map();
        const collect = () => {
            for (const row of tbody.children) {
                const index = Number(row.dataset.index);
                if (!Number.isInteger(index) || found.has(index)) continue;
                ensureCells(row); // the scan outruns the tick that adds these
                found.set(index, { symbol: rowSymbol(row), el: copyRow(row), index });
            }
        };
        // Lighter mounts rows within a frame or so, so move on as soon as they change
        const mountedRange = () => `${tbody.firstElementChild?.dataset.index}-${tbody.lastElementChild?.dataset.index}`;
        const wait = async (before) => {
            const deadline = Date.now() + SORT_SCAN_DELAY_MS;
            while (mountedRange() === before && Date.now() < deadline) await sleep(SORT_SCAN_POLL_MS);
        };
        if (scroller.scrollTop !== 0) {
            const before = mountedRange();
            scroller.scrollTop = 0;
            await wait(before);
        }
        const step = Math.max(scroller.clientHeight, DEFAULT_ROW_HEIGHT);
        for (;;) {
            if (view !== v) return;
            collect();
            if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
            const before = mountedRange();
            scroller.scrollTop += step;
            await wait(before);
        }
        const before = mountedRange();
        scroller.scrollTop = 0;
        await wait(before);
        if (view !== v) return;

        const previous = v.display;
        v.rowHeight = rowHeightOf(tbody);
        // Rows already showing are updated in place, so icons don't redraw and rows can glide
        const shown = new Map(v.rows.map((row) => [row.symbol, row.el]));
        v.rows = [...found.values()];
        for (const row of v.rows) {
            const el = shown.get(row.symbol);
            if (!el) {
                v.inner.appendChild(row.el);
                continue;
            }
            updateCopy(el, row.el);
            row.el = el;
            shown.delete(row.symbol);
        }
        for (const el of shown.values()) el.remove();
        v.inner.style.height = `${v.rows.length * v.rowHeight}px`;
        v.key = viewKey(tbody, headerRow);
        v.scannedAt = Date.now();
        v.scanning = false;
        renderView(v, layout);
        // A re-read of the same markets is not a new sort; a different tab or filter is.
        const symbols = new Set(v.rows.map((row) => row.symbol));
        const sameMarkets = previous.length === v.rows.length && previous.every((row) => symbols.has(row.symbol));
        if (previous.length && (sameMarkets || v.overlay.matches(":hover"))) {
            keepOrder(v, previous);
        } else {
            applyOrder(v);
            v.overlay.scrollTop = 0;
        }
    }

    function innermost(cell) {
        let el = cell;
        while (el.children.length === 1) el = el.children[0];
        return el;
    }

    function renderLastPrice(cell, mid) {
        const el = innermost(cell);
        const shown = el.textContent.trim();
        if (!(Number(mid) > 0) || !/^[\d,.]+$/.test(shown)) return;
        const decimals = (shown.split(".")[1] || "").length; // Lighter sets each market's precision
        const text = Number(mid).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        if (shown !== text) el.textContent = text;
    }

    function renderChange(cell, change) {
        if (change === undefined || !Number.isFinite(Number(change))) return;
        const el = innermost(cell);
        const rounded = Math.round(Number(change) * 100) / 100;
        const text = `${rounded > 0 ? "+" : ""}${rounded}%`;
        if (el.textContent.trim() === text) return;
        const wasNegative = el.textContent.trim().startsWith("-");
        el.textContent = text;
        if (wasNegative !== rounded < 0) el.style.color = rounded < 0 ? COLORS.red : rounded > 0 ? COLORS.green : "";
    }

    function renderView(v, layout) {
        const live = socketIsLive();
        for (const row of v.rows) {
            const stats = _marketStats[row.symbol];
            const cells = {};
            for (const cell of row.el.querySelectorAll(":scope > [data-pp-col]")) cells[cell.dataset.ppCol] = cell;
            renderRowCells(cells, stats, live);
            if (!live || !stats) continue;
            if (layout.priceColumn >= 0) renderLastPrice(row.el.children[layout.priceColumn], stats.mid);
            if (layout.changeColumn >= 0) renderChange(row.el.children[layout.changeColumn], stats.change24h);
        }
    }

    async function onViewClick(e) {
        e.stopPropagation();
        const v = view;
        const clicked = e.target.closest("tr");
        const symbol = v?.rows.find((r) => r.el === clicked)?.symbol;
        if (!symbol || v.clicking) return;

        // A button (the favorite star) acts on its real counterpart; only the row body selects
        const button = e.target.closest("button");
        const buttonIndex = button ? [...clicked.querySelectorAll("button")].indexOf(button) : -1;

        // Moving the real list looks like a list change to updateView, so it stands down until done
        v.clicking = true;
        try {
            const deadline = Date.now() + SORT_CLICK_WAIT_MS;
            while (v.scanning && Date.now() < deadline) await sleep(SORT_SCAN_DELAY_MS);
            if (v.scanning) return;

            // Lighter keeps re-sorting its own hidden list, so match by name: try where the row
            // was when last read, then walk the list. Never act on a different market.
            const findReal = () => [...v.tbody.children].find((r) => rowSymbol(r) === symbol);
            const row = v.rows.find((r) => r.symbol === symbol);
            let real = findReal();
            if (!real && row) {
                v.scroller.scrollTop = row.index * v.rowHeight;
                await sleep(SORT_SCAN_DELAY_MS);
                real = findReal();
            }
            if (!real) {
                v.scroller.scrollTop = 0;
                await sleep(SORT_SCAN_DELAY_MS);
                real = findReal();
            }
            while (!real && Date.now() < deadline && v.scroller.scrollTop + v.scroller.clientHeight < v.scroller.scrollHeight - 1) {
                v.scroller.scrollTop += v.scroller.clientHeight;
                await sleep(SORT_SCAN_DELAY_MS);
                real = findReal();
            }
            if (!real) {
                v.key = null;
                return;
            }
            if (buttonIndex < 0) {
                real.click();
                return;
            }
            real.querySelectorAll("button")[buttonIndex]?.click();
            // Lighter pins favorites to the top of its list, so every row may have moved
            await sleep(SORT_BUTTON_SETTLE_MS);
            v.key = null;
        } finally {
            v.clicking = false;
            if (view === v) v.scroller.scrollTop = 0;
        }
    }

    function updateView(table, tbody, scroller, headerRow, ensureCells, layout) {
        if (view && (view.tbody !== tbody || !view.overlay.isConnected)) closeView();
        const isNew = !view;
        if (isNew) view = createView(table, tbody, scroller, ensureCells);
        const v = view;

        const parentTop = scroller.parentElement.getBoundingClientRect().top;
        const headerBottom = headerRow.getBoundingClientRect().bottom;
        v.overlay.style.top = `${headerBottom - parentTop}px`;
        v.inner.style.width = `${tbody.clientWidth}px`;
        if (isNew) v.overlay.scrollTop = v.startTop;
        if (v.scanning || v.clicking) return;

        const hovering = v.overlay.matches(":hover"); // a row must not move under the pointer
        const now = Date.now();
        if (v.key !== viewKey(tbody, headerRow) || (!hovering && now - v.scannedAt >= SORT_REREAD_MS)) {
            scanRows(v, headerRow, ensureCells, layout);
            return;
        }
        renderView(v, layout);
        if (!hovering && hasNewValues(v)) applyOrder(v);
        if (now - v.driftCheckedAt >= SORT_DRIFT_CHECK_MS) {
            v.driftCheckedAt = now;
            v.drifted = hasDrifted(v);
        }
    }

    // Sorting by funding needs every market's history; otherwise only rows in view do.
    function sortedRowsToFetch(v) {
        if (sortState.col === COL_FUNDING) return v.display;
        const first = Math.floor(v.overlay.scrollTop / v.rowHeight);
        return v.display.slice(first, first + Math.ceil(v.overlay.clientHeight / v.rowHeight) + 1);
    }

    const SORTED_LABELS = { [COL_SPREAD]: "Spread", [COL_FUNDING]: "7D" };

    function updateHeaderLabels(headerRow) {
        for (const cell of headerRow.querySelectorAll(":scope > [data-pp-col]")) {
            const col = cell.dataset.ppCol;
            const sorted = sortState.col === col;
            let text = HEADER_LABELS[col].text;
            if (sorted) {
                text = `${SORTED_LABELS[col]} ${sortState.dir > 0 ? "▲" : "▼"}`;
                if (col === COL_FUNDING && view?.rows.length) {
                    const perps = view.rows.filter((row) => isActivePerp(_marketStats[row.symbol]));
                    const loaded = perps.filter((row) => fundingCache[_marketStats[row.symbol].marketId]).length;
                    if (loaded < perps.length) text += ` ${loaded}/${perps.length}`;
                }
            }
            const label = cell.firstElementChild;
            if (label && label.textContent !== text) label.textContent = text;
            const resort = cell.querySelector("[data-pp-resort]");
            const showResort = sorted && !!view?.drifted;
            if (resort && (resort.style.display !== "none") !== showResort) resort.style.display = showResort ? "inline" : "none";
        }
    }

    function isSortMenuClick(target) {
        const button = target.closest?.("button");
        return !!button && /^sort/i.test(button.textContent.trim() || button.getAttribute("aria-label") || "");
    }

    // The selector's keyboard and sort controls act on Lighter's hidden order, so hand back first.
    function bindSortControls() {
        document.addEventListener("keydown", (e) => {
            if (!sortState.col || !view) return;
            if (e.key === "ArrowUp" || e.key === "ArrowDown") stopSort();
            if (e.key === "Enter") {
                stopSort();
                e.preventDefault();
                e.stopPropagation(); // would select a highlighted row the user can't see
            }
        }, true);
        document.addEventListener("click", (e) => {
            if (!sortState.col) return;
            const nativeHeader = e.target.closest?.('th[role="columnheader"]');
            if ((nativeHeader && !nativeHeader.dataset.ppCol) || isSortMenuClick(e.target)) stopSort();
        }, true);
    }

    function updateTable(lastPriceHeader) {
        const headerRow = lastPriceHeader.parentElement;
        const table = lastPriceHeader.closest("table");
        const tbody = table?.querySelector("tbody");
        if (!headerRow || !tbody) return;

        const nativeHeaders = [...headerRow.children].filter((el) => !el.dataset.ppCol);
        const hasFunding = nativeHeaders.some((el) => /funding/i.test(el.textContent));
        const columns = hasFunding ? [COL_SPREAD, COL_FUNDING] : [COL_SPREAD];
        syncColumns(headerRow, lastPriceHeader, columns, buildHeaderCell);
        const marketWidth = fitMarketWidth(columns.join(), table, headerRow);
        setMarketWidth(headerRow.children[0], marketWidth);

        const priceColumn = nativeHeaders.indexOf(lastPriceHeader);
        const live = socketIsLive();
        const visibleStats = [];
        const layout = {
            priceColumn,
            changeColumn: nativeHeaders.findIndex((el) => /^24h/i.test(el.textContent.trim())),
        };
        if (sortState.col && !columns.includes(sortState.col)) stopSort();
        if (document.querySelector('input[placeholder*="Search" i]')?.value) stopSort();
        const sorting = !!sortState.col;

        for (const row of tbody.children) {
            const template = row.children[priceColumn];
            if (!template) continue;
            const stats = _marketStats[rowSymbol(row)];
            const cells = syncColumns(row, template, columns);
            setMarketWidth(row.children[0], marketWidth);

            renderRowCells(cells, stats, live);
            if (stats) visibleStats.push(stats);
        }

        let wanted = visibleStats;
        if (sorting) {
            updateView(table, tbody, findScroller(table), headerRow, (row) => {
                if (row.children[priceColumn]) syncColumns(row, row.children[priceColumn], columns);
                setMarketWidth(row.children[0], marketWidth);
            }, layout);
            wanted = view ? sortedRowsToFetch(view).map((row) => _marketStats[row.symbol]).filter(Boolean) : [];
        }
        updateHeaderLabels(headerRow);

        if (!cacheLoaded || !columns.includes(COL_FUNDING) || fetching) return;
        const now = Date.now();
        if (now < pausedUntil) return;
        const first = wanted.find(needsFirstLoad);
        if (first) {
            if (now - lastFetchAt >= FETCH_INTERVAL_MS) fetchFunding(first.marketId);
            return;
        }
        const behind = wanted.find(needsCatchUp);
        if (behind && now - lastFetchAt >= CATCH_UP_INTERVAL_MS) fetchFunding(behind.marketId);
    }

    function tick() {
        const lastPriceHeader = document.querySelector('th[role="columnheader"] span[title="Last Price"]')?.closest("th");
        if (!lastPriceHeader) {
            closeView();
            return;
        }
        if (Date.now() - lastConnectAt >= CONNECT_INTERVAL_MS) {
            lastConnectAt = Date.now();
            connectFundingWebSocket();
        }
        updateTable(lastPriceHeader);
    }

    loadCache();
    bindSortControls();
    setInterval(tick, TICK_MS);
    setInterval(appendSettledFunding, 60_000);
})();
