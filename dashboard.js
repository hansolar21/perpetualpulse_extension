// dashboard.js — Trade analytics dashboard (ECharts)
(function () {
    "use strict";

    let _db = null;
    const charts = [];

    const C = {
        green: "#00c853", red: "#ff1744", blue: "#448aff", purple: "#7c4dff",
        amber: "#ffab00", cyan: "#00e5ff", pink: "#f50057", lime: "#76ff03",
        orange: "#ff6d00", teal: "#1de9b6", indigo: "#536dfe", rose: "#ff4081",
        bg: "#0b0e11", bg2: "#12161c", bg3: "#1a1f28", border: "#252a35",
        text: "#c8ccd4", dim: "#6b7280",
    };
    const PALETTE = [C.blue, C.green, C.purple, C.amber, C.cyan, C.pink, C.lime, C.orange, C.teal, C.indigo, C.rose, C.red];

    function makeChart(id, { autoScaleY = true } = {}) {
        const el = document.getElementById(id);
        const chart = echarts.init(el, null, { renderer: "canvas" });
        charts.push(chart);
        if (autoScaleY) attachYAutoScale(chart);
        return chart;
    }

    function dataZoomOpts() {
        return [
            { type: "inside", xAxisIndex: 0, filterMode: "none" },
            { type: "slider", xAxisIndex: 0, height: 25, bottom: 8, borderColor: C.border,
              backgroundColor: C.bg2, fillerColor: C.blue + "20",
              dataBackground: { lineStyle: { color: C.dim }, areaStyle: { color: C.blue + "10" } },
              textStyle: { color: C.dim, fontSize: 10 }, handleStyle: { color: C.blue } },
        ];
    }

    // dataZoom that auto-scales Y axis on zoom
    function dataZoomAutoY() {
        return [
            { type: "inside", xAxisIndex: 0, filterMode: "none" },
            { type: "slider", xAxisIndex: 0, height: 25, bottom: 8, borderColor: C.border,
              backgroundColor: C.bg2, fillerColor: C.blue + "20",
              dataBackground: { lineStyle: { color: C.dim }, areaStyle: { color: C.blue + "10" } },
              textStyle: { color: C.dim, fontSize: 10 }, handleStyle: { color: C.blue } },
        ];
    }

    // Attach y-axis auto-rescale to a chart
    function attachYAutoScale(chart) {
        chart.on("datazoom", () => {
            const opt = chart.getOption();
            if (!opt.dataZoom || !opt.series) return;
            const dz = opt.dataZoom[0];
            const start = dz.start ?? 0;
            const end = dz.end ?? 100;

            // For each y-axis, find visible range
            const yAxes = opt.yAxis || [];
            const newYAxis = [];
            for (let ai = 0; ai < yAxes.length; ai++) {
                let mn = Infinity, mx = -Infinity;
                for (const s of opt.series) {
                    if ((s.yAxisIndex || 0) !== ai) continue;
                    const data = s.data || [];
                    const startIdx = Math.floor(data.length * start / 100);
                    const endIdx = Math.ceil(data.length * end / 100);
                    for (let i = startIdx; i < endIdx; i++) {
                        const v = typeof data[i] === "object" ? data[i]?.value : data[i];
                        if (v != null && isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
                    }
                }
                if (mn < Infinity) {
                    const pad = Math.max((mx - mn) * 0.08, 1);
                    newYAxis.push({ min: mn - pad, max: mx + pad });
                } else {
                    newYAxis.push({});
                }
            }
            chart.setOption({ yAxis: newYAxis }, { lazyUpdate: true });
        });
    }

    const MONO = '"SF Mono", "Fira Code", "JetBrains Mono", "Consolas", monospace';
    function baseGrid(extra = {}) { return { top: 40, right: 20, bottom: 60, left: 70, ...extra }; }
    function tooltipBase() { return { trigger: "axis", backgroundColor: C.bg3 + "f0", borderColor: C.border, borderWidth: 1, textStyle: { color: C.text, fontSize: 11, fontFamily: MONO } }; }

    // Tooltip with colored dots
    function fmtTooltip(params) {
        let s = params[0].axisValue;
        for (const p of params) {
            const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:4px"></span>`;
            s += `<br/>${dot}${p.seriesName}: <b>${fmt(p.value)}</b>`;
        }
        return s;
    }

    // ---- DB ----
    function base64ToUint8(b64) {
        const binary = atob(b64); const u8 = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i); return u8;
    }
    async function loadDB() {
        const result = await new Promise((r) => chrome.storage.local.get("pp_trade_db_b64", r));
        if (!result.pp_trade_db_b64) return null;
        const SQL = await initSqlJs({ locateFile: () => chrome.runtime.getURL("lib/sql-wasm.wasm") });
        return new SQL.Database(base64ToUint8(result.pp_trade_db_b64));
    }
    function query(sql) {
        if (!_db) return [];
        try {
            const result = _db.exec(sql);
            if (!result.length) return [];
            return result[0].values.map((row) => { const obj = {}; result[0].columns.forEach((col, i) => (obj[col] = row[i])); return obj; });
        } catch (e) { console.error("Query:", sql, e); return []; }
    }

    function fmt(n, d = 2) {
        if (n == null || isNaN(n)) return "—";
        const s = n < 0 ? "-" : "", a = Math.abs(n);
        if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(1) + "M";
        if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(1) + "K";
        return s + "$" + a.toFixed(d);
    }
    function pnlClass(n) { return n > 0 ? "positive" : n < 0 ? "negative" : ""; }

    // ================ RENDERERS ================

    function renderSummary() {
        const t = query(`SELECT COUNT(*) as trades, COALESCE(SUM(trade_value),0) as volume,
            COALESCE(SUM(COALESCE(closed_pnl,0)),0) as pnl, COALESCE(SUM(fee),0) as fees FROM trades`)[0] || {};
        const f = query(`SELECT COALESCE(SUM(payment),0) as total FROM funding`)[0] || {};
        const w = query(`SELECT COUNT(*) as total, SUM(CASE WHEN closed_pnl>0 THEN 1 ELSE 0 END) as wins
            FROM trades WHERE closed_pnl IS NOT NULL AND closed_pnl!=0`)[0] || {};

        const funding = f.total || 0;
        const net = (t.pnl || 0) - (t.fees || 0) + funding;
        const winRate = w.total > 0 ? ((w.wins / w.total) * 100).toFixed(1) + "%" : "—";

        const set = (id, val, cls) => { const el = document.getElementById(id); el.textContent = val; if (cls) el.className = "card-value " + cls; };
        set("stat-trades", (t.trades || 0).toLocaleString());
        set("stat-pnl", fmt(t.pnl), pnlClass(t.pnl));
        set("stat-fees", fmt(t.fees));
        set("stat-funding", fmt(funding), pnlClass(funding));
        set("stat-net", fmt(net), pnlClass(net));
        set("stat-volume", fmt(t.volume));
        set("stat-winrate", winRate);

        const range = query("SELECT MIN(date) as mn, MAX(date) as mx, COUNT(DISTINCT DATE(date)) as days FROM trades")[0] || {};
        document.getElementById("status-text").textContent =
            `${(t.trades || 0).toLocaleString()} trades | ${range.days || 0} days | ${(range.mn || "").slice(0, 10)} → ${(range.mx || "").slice(0, 10)} | funding: ${fmt(funding)}`;
    }

    // ---- Equity Curve with Market Overlay ----
    let _equityChart = null;
    let _equityDays = [];
    let _equityBaseVals = [];
    let _activeMarkets = new Set();
    let _marketDailyPnl = {};

    function computeEquityData() {
        const data = query(`SELECT DATE(date) as day, SUM(COALESCE(closed_pnl,0)) as pnl, SUM(fee) as fees
            FROM trades GROUP BY day ORDER BY day`);
        const fd = query(`SELECT DATE(date) as day, SUM(payment) as funding FROM funding GROUP BY day`);
        const fmap = {}; for (const r of fd) fmap[r.day] = r.funding;

        let cum = 0;
        _equityDays = []; _equityBaseVals = [];
        for (const r of data) {
            cum += r.pnl - r.fees + (fmap[r.day] || 0);
            _equityDays.push(r.day);
            _equityBaseVals.push(Math.round(cum * 100) / 100);
        }

        // Per-market funding
        const marketFunding = {};
        const mf = query(`SELECT market, DATE(date) as day, SUM(payment) as funding FROM funding GROUP BY market, day`);
        for (const r of mf) {
            if (!marketFunding[r.market]) marketFunding[r.market] = {};
            marketFunding[r.market][r.day] = r.funding;
        }

        const markets = query(`SELECT DISTINCT market FROM trades ORDER BY market`);
        _marketDailyPnl = {};
        for (const m of markets) {
            const md = query(`SELECT DATE(date) as day, SUM(COALESCE(closed_pnl,0)) - SUM(fee) as net
                FROM trades WHERE market='${m.market}' GROUP BY day ORDER BY day`);
            const mfMap = marketFunding[m.market] || {};
            let mcum = 0;
            const dayMap = {};
            for (const r of md) { mcum += r.net + (mfMap[r.day] || 0); dayMap[r.day] = Math.round(mcum * 100) / 100; }
            _marketDailyPnl[m.market] = dayMap;
        }
    }

    function getMarketSeries(market) {
        const dayMap = _marketDailyPnl[market] || {};
        let lastVal = 0;
        return _equityDays.map((d) => { if (dayMap[d] !== undefined) lastVal = dayMap[d]; return lastVal; });
    }

    function updateEquityChart() {
        const hasOverlays = _activeMarkets.size > 0;

        const series = [{
            name: "TOTAL NET PNL", type: "line", data: _equityBaseVals, smooth: 0.3, symbol: "none",
            lineStyle: { color: C.green, width: 3 },
            areaStyle: hasOverlays ? undefined : { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: C.green + "20" }, { offset: 1, color: C.green + "02" }]) },
            yAxisIndex: 0, z: 10,
        }];

        let i = 0;
        for (const market of _activeMarkets) {
            const color = PALETTE[(i + 1) % PALETTE.length];
            series.push({
                name: market, type: "line", data: getMarketSeries(market), smooth: 0.3, symbol: "none",
                lineStyle: { color, width: 1.2, opacity: 0.8 }, yAxisIndex: 0, z: 2,
            });
            i++;
        }

        _equityChart.setOption({
            tooltip: { ...tooltipBase(), formatter: fmtTooltip },
            legend: { data: series.map((s) => s.name), textStyle: { color: C.dim, fontSize: 10, fontFamily: MONO }, top: 5, type: "scroll",
                icon: "roundRect", itemWidth: 14, itemHeight: 3 },
            grid: baseGrid({ top: 35 }),
            xAxis: { type: "category", data: _equityDays, axisLabel: { color: C.dim, fontSize: 10, fontFamily: MONO }, axisLine: { lineStyle: { color: C.border } } },
            yAxis: [
                { type: "value", axisLabel: { color: C.dim, formatter: (v) => fmt(v), fontFamily: MONO }, splitLine: { lineStyle: { color: C.border } } },
            ],
            dataZoom: dataZoomAutoY(),
            series,
        }, { replaceMerge: ["series"] });
    }

    function renderEquityCurve() {
        computeEquityData();
        _equityChart = makeChart("chart-equity");

        updateEquityChart();

        // Build market sidebar
        const marketPnl = query(`SELECT market, SUM(COALESCE(closed_pnl,0)) - SUM(fee) as net_pnl
            FROM trades GROUP BY market ORDER BY ABS(SUM(COALESCE(closed_pnl,0)) - SUM(fee)) DESC`);
        const list = document.getElementById("market-list");

        // Select All button
        const selectAll = document.createElement("div");
        selectAll.className = "market-item";
        selectAll.style.fontWeight = "600";
        selectAll.style.borderBottom = "1px solid " + C.border;
        selectAll.style.marginBottom = "4px";
        selectAll.innerHTML = `<span>Select All</span><span class="pnl" style="color:${C.dim}">⊞</span>`;
        let allSelected = false;
        selectAll.addEventListener("click", () => {
            allSelected = !allSelected;
            for (const item of list.querySelectorAll(".market-item[data-market]")) {
                const mkt = item.dataset.market;
                if (allSelected) { _activeMarkets.add(mkt); item.classList.add("active"); }
                else { _activeMarkets.delete(mkt); item.classList.remove("active"); }
            }
            selectAll.querySelector(".pnl").textContent = allSelected ? "⊟" : "⊞";
            updateEquityChart();
        });
        list.appendChild(selectAll);

        for (const m of marketPnl) {
            const el = document.createElement("div");
            el.className = "market-item";
            el.dataset.market = m.market;
            const pnlColor = m.net_pnl >= 0 ? C.green : C.red;
            el.innerHTML = `<span>${m.market}</span><span class="pnl" style="color:${pnlColor}">${fmt(m.net_pnl)}</span>`;
            el.addEventListener("click", () => {
                if (_activeMarkets.has(m.market)) { _activeMarkets.delete(m.market); el.classList.remove("active"); }
                else { _activeMarkets.add(m.market); el.classList.add("active"); }
                updateEquityChart();
            });
            list.appendChild(el);
        }

        document.getElementById("market-search").addEventListener("input", (e) => {
            const q = e.target.value.toLowerCase();
            for (const item of list.querySelectorAll(".market-item[data-market]")) {
                item.style.display = item.dataset.market.toLowerCase().includes(q) ? "" : "none";
            }
        });
    }

    // ---- Position Exposure Chart ----
    function renderExposure() {
        const trades = query(`SELECT date, market, side, trade_value, size, price FROM trades ORDER BY date ASC`);

        // Try to get transfers for equity calculation
        const transfers = query(`SELECT date, type, amount FROM transfers ORDER BY date ASC`);
        const hasTransfers = transfers.length > 0;

        const positions = {};
        const dailySnaps = {};
        let currentDay = null;

        // Compute running equity from transfers + realized PnL
        let equity = 0;
        const dailyEquity = {};
        const transfersByDay = {};
        for (const t of transfers) {
            const day = (t.date || "").slice(0, 10);
            if (!transfersByDay[day]) transfersByDay[day] = 0;
            transfersByDay[day] += t.amount;
        }

        // Track daily realized PnL for equity calculation
        const dailyRealizedPnl = {};
        const realizedData = query(`SELECT DATE(date) as day, SUM(COALESCE(closed_pnl,0)) - SUM(fee) as net
            FROM trades GROUP BY day ORDER BY day`);
        for (const r of realizedData) dailyRealizedPnl[r.day] = r.net;

        const snapDay = (day) => {
            let longN = 0, shortN = 0;
            for (const [, pos] of Object.entries(positions)) {
                if (pos.size <= 0.0001) continue;
                if (pos.direction === "long") longN += pos.notional;
                else shortN += pos.notional;
            }
            dailySnaps[day] = { long: longN, short: -shortN, gross: longN + shortN, net: longN - shortN };

            // Update equity
            equity += (transfersByDay[day] || 0) + (dailyRealizedPnl[day] || 0);
            dailyEquity[day] = equity;
        };

        for (const t of trades) {
            const day = (t.date || "").slice(0, 10);
            if (day !== currentDay && currentDay) snapDay(currentDay);
            currentDay = day;

            const mkt = t.market;
            if (!positions[mkt]) positions[mkt] = { direction: null, size: 0, notional: 0 };
            const pos = positions[mkt];
            const side = t.side;
            const isOpen = side === "Open Long" || side === "Open Short" || side === "Buy" ||
                (side === "Long" && (!pos.direction || pos.direction === "long")) ||
                (side === "Short" && (!pos.direction || pos.direction === "short"));
            const isClose = side === "Close Long" || side === "Close Short" || side === "Sell" ||
                (side === "Long" && pos.direction === "short") ||
                (side === "Short" && pos.direction === "long");
            const isFlip = side === "Long > Short" || side === "Short > Long";

            if (isOpen) {
                const dir = (side === "Open Long" || side === "Long" || side === "Buy" || side === "Short > Long") ? "long" : "short";
                if (!pos.direction) pos.direction = dir;
                pos.size += t.size;
                pos.notional += t.trade_value;
            } else if (isClose) {
                const closeFrac = Math.min(t.size / (pos.size || 1), 1);
                pos.size = Math.max(0, pos.size - t.size);
                pos.notional = Math.max(0, pos.notional * (1 - closeFrac));
                if (pos.size < 0.0001) { pos.direction = null; pos.size = 0; pos.notional = 0; }
            } else if (isFlip) {
                const oldSize = pos.size; pos.size = 0; pos.notional = 0;
                const remaining = t.size - oldSize;
                if (remaining > 0) { pos.direction = side === "Long > Short" ? "short" : "long"; pos.size = remaining; pos.notional = remaining * t.price; }
                else pos.direction = null;
            }
        }
        if (currentDay) snapDay(currentDay);

        const days = Object.keys(dailySnaps).sort();
        const longVals = days.map((d) => Math.round(dailySnaps[d].long));
        const shortVals = days.map((d) => Math.round(dailySnaps[d].short));
        const netVals = days.map((d) => Math.round(dailySnaps[d].net));
        const grossVals = days.map((d) => Math.round(dailySnaps[d].gross));

        // Build cumulative PnL aligned to exposure days
        const pnlData = query(`SELECT DATE(date) as day, SUM(COALESCE(closed_pnl,0)) as pnl, SUM(fee) as fees
            FROM trades GROUP BY day ORDER BY day`);
        const fdData = query(`SELECT DATE(date) as day, SUM(payment) as funding FROM funding GROUP BY day`);
        const fmap2 = {}; for (const r of fdData) fmap2[r.day] = r.funding;
        let cumPnl = 0;
        const cumPnlMap = {};
        for (const r of pnlData) {
            cumPnl += r.pnl - r.fees + (fmap2[r.day] || 0);
            cumPnlMap[r.day] = Math.round(cumPnl * 100) / 100;
        }
        // Forward-fill PnL for days with exposure but no trades
        let lastPnl = 0;
        const pnlVals = days.map((d) => { if (cumPnlMap[d] !== undefined) lastPnl = cumPnlMap[d]; return lastPnl; });

        const seriesList = [
            { name: "Net Exposure", type: "line", data: netVals, smooth: 0.2, symbol: "none",
                color: C.blue, itemStyle: { color: C.blue },
                lineStyle: { color: C.blue, width: 2 } },
            { name: "Gross Exposure", type: "line", data: grossVals, smooth: 0.2, symbol: "none",
                color: C.amber, itemStyle: { color: C.amber },
                lineStyle: { color: C.amber, width: 1.5 },
                areaStyle: { color: C.amber + "10" } },
            { name: "Long", type: "line", data: longVals, smooth: 0.2, symbol: "none",
                color: C.green, itemStyle: { color: C.green },
                lineStyle: { color: C.green, width: 1.2 } },
            { name: "Short", type: "line", data: shortVals, smooth: 0.2, symbol: "none",
                color: C.red, itemStyle: { color: C.red },
                lineStyle: { color: C.red, width: 1.2 } },
            { name: "Total Net PnL", type: "line", data: pnlVals, smooth: 0.3, symbol: "none",
                color: C.green, itemStyle: { color: C.green },
                lineStyle: { color: C.green, width: 2.5 }, yAxisIndex: 1 },
        ];

        const legendNames = ["Net Exposure", "Gross Exposure", "Long", "Short", "Total Net PnL"];
        // Long and Short hidden by default (click legend to toggle)
        const legendSelected = { "Long": false, "Short": false, "Net Exposure": true, "Gross Exposure": true, "Total Net PnL": true };

        // Add leverage and equity if we have transfer data
        if (hasTransfers) {
            const equityVals = days.map((d) => Math.round(dailyEquity[d] || 0));
            const leverageVals = days.map((d) => {
                const eq = dailyEquity[d] || 0;
                return eq > 0 ? Math.round((dailySnaps[d].gross / eq) * 100) / 100 : 0;
            });

            seriesList.push(
                { name: "Equity", type: "line", data: equityVals, smooth: 0.2, symbol: "none",
                    color: C.purple, itemStyle: { color: C.purple },
                    lineStyle: { color: C.purple, width: 2 }, yAxisIndex: 0 },
                { name: "Leverage", type: "line", data: leverageVals, smooth: 0.2, symbol: "none",
                    color: C.cyan, itemStyle: { color: C.cyan },
                    lineStyle: { color: C.cyan, width: 2 }, yAxisIndex: 2 },
            );
            legendNames.push("Equity", "Leverage");
        }

        const yAxes = [
            { type: "value", name: "Exposure", nameTextStyle: { color: C.dim, fontSize: 10 },
                axisLabel: { color: C.dim, formatter: (v) => fmt(v), fontFamily: MONO }, splitLine: { lineStyle: { color: C.border } } },
            { type: "value", position: "right", name: "P&L", nameTextStyle: { color: C.green, fontSize: 10 },
                axisLabel: { color: C.dim, formatter: (v) => fmt(v), fontFamily: MONO }, splitLine: { show: false } },
        ];
        if (hasTransfers) {
            yAxes.push({ type: "value", position: "right", offset: 60, name: "Leverage",
                nameTextStyle: { color: C.cyan, fontSize: 10 },
                axisLabel: { color: C.dim, formatter: "{value}x", fontFamily: MONO }, splitLine: { show: false } });
        }

        makeChart("chart-exposure").setOption({
            tooltip: { ...tooltipBase(), formatter: (params) => {
                let s = params[0].axisValue;
                for (const p of params) {
                    const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:4px"></span>`;
                    const val = p.seriesName === "Leverage" ? p.value + "x" : fmt(p.value);
                    s += `<br/>${dot}${p.seriesName}: <b>${val}</b>`;
                }
                return s;
            }},
            legend: { data: legendNames, selected: legendSelected, textStyle: { color: C.dim, fontFamily: MONO, fontSize: 10 }, top: 5,
                icon: "roundRect", itemWidth: 14, itemHeight: 3 },
            grid: baseGrid({ top: 40, right: hasTransfers ? 100 : 80 }),
            xAxis: { type: "category", data: days, axisLabel: { color: C.dim, fontSize: 10, fontFamily: MONO }, axisLine: { lineStyle: { color: C.border } } },
            yAxis: yAxes,
            dataZoom: dataZoomAutoY(),
            series: seriesList,
        });
    }

    // ---- Deposits & Withdrawals ----
    function renderTransfers() {
        const data = query(`SELECT DATE(date) as day, type, SUM(amount) as amount
            FROM transfers GROUP BY day, type ORDER BY day`);
        if (data.length === 0) {
            document.getElementById("chart-transfers").innerHTML = '<p style="color:#8892a4;text-align:center;padding:60px">No transfer data yet. Sync from Lighter to fetch.</p>';
            return;
        }

        // Running balance
        let balance = 0;
        const dayMap = {};
        for (const r of data) {
            if (!dayMap[r.day]) dayMap[r.day] = { deposits: 0, withdrawals: 0 };
            if (r.amount > 0) dayMap[r.day].deposits += r.amount;
            else dayMap[r.day].withdrawals += r.amount;
        }
        const days = Object.keys(dayMap).sort();
        const deposits = [], withdrawals = [], cumBalance = [];
        for (const d of days) {
            deposits.push(Math.round(dayMap[d].deposits * 100) / 100);
            withdrawals.push(Math.round(dayMap[d].withdrawals * 100) / 100);
            balance += dayMap[d].deposits + dayMap[d].withdrawals;
            cumBalance.push(Math.round(balance * 100) / 100);
        }

        makeChart("chart-transfers").setOption({
            tooltip: { ...tooltipBase(), formatter: fmtTooltip },
            legend: { data: ["Deposits", "Withdrawals", "Net Deposited"], textStyle: { color: C.dim }, top: 5, icon: "roundRect", itemWidth: 14, itemHeight: 3 },
            grid: baseGrid({ top: 40, right: 70 }),
            xAxis: { type: "category", data: days, axisLabel: { color: C.dim, fontSize: 10 }, axisLine: { lineStyle: { color: C.border } } },
            yAxis: [
                { type: "value", axisLabel: { color: C.dim, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: C.border } } },
                { type: "value", position: "right", name: "Cumulative", nameTextStyle: { color: C.purple },
                    axisLabel: { color: C.dim, formatter: (v) => fmt(v) }, splitLine: { show: false } },
            ],
            dataZoom: dataZoomOpts(),
            series: [
                { name: "Deposits", type: "bar", data: deposits, itemStyle: { color: C.green }, barMaxWidth: 12, stack: "tf" },
                { name: "Withdrawals", type: "bar", data: withdrawals, itemStyle: { color: C.red }, barMaxWidth: 12, stack: "tf" },
                { name: "Net Deposited", type: "line", data: cumBalance, smooth: 0.3, symbol: "none",
                    lineStyle: { color: C.purple, width: 2 }, yAxisIndex: 1 },
            ],
        });
    }

    // ---- Daily P&L ----
    function renderDailyPnL() {
        const data = query(`SELECT DATE(date) as day, SUM(COALESCE(closed_pnl,0)) as pnl, SUM(fee) as fees
            FROM trades GROUP BY day ORDER BY day`);
        const fd = query(`SELECT DATE(date) as day, SUM(payment) as funding FROM funding GROUP BY day`);
        const fmap = {}; for (const r of fd) fmap[r.day] = r.funding;

        const days = [], vals = [], colors = [];
        for (const r of data) {
            const net = r.pnl - r.fees + (fmap[r.day] || 0);
            days.push(r.day); vals.push(Math.round(net * 100) / 100);
            colors.push(net >= 0 ? C.green : C.red);
        }

        makeChart("chart-daily-pnl").setOption({
            tooltip: { ...tooltipBase(), formatter: (p) => `${p[0].axisValue}<br/>Daily P&L: <b>${fmt(p[0].value)}</b>` },
            grid: baseGrid(),
            xAxis: { type: "category", data: days, axisLabel: { color: C.dim, fontSize: 10 }, axisLine: { lineStyle: { color: C.border } } },
            yAxis: { type: "value", axisLabel: { color: C.dim, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: C.border } } },
            dataZoom: dataZoomAutoY(),
            series: [{ type: "bar", data: vals, itemStyle: { color: (p) => colors[p.dataIndex] }, barMaxWidth: 8 }],
        });
    }

    function renderMarketPnL() {
        const data = query(`SELECT market, SUM(COALESCE(closed_pnl,0)) - SUM(fee) as net_pnl
            FROM trades GROUP BY market ORDER BY net_pnl DESC`);
        makeChart("chart-market-pnl").setOption({
            tooltip: { ...tooltipBase(), trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p) => `${p[0].name}: <b>${fmt(p[0].value)}</b>` },
            grid: { top: 10, right: 30, bottom: 10, left: 80, containLabel: true },
            xAxis: { type: "value", axisLabel: { color: C.dim, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: C.border } } },
            yAxis: { type: "category", data: data.map((r) => r.market).reverse(), axisLabel: { color: C.text, fontSize: 11 }, axisLine: { show: false } },
            series: [{ type: "bar", data: data.map((r) => r.net_pnl).reverse(), itemStyle: { color: (p) => p.value >= 0 ? C.green : C.red, borderRadius: [0, 3, 3, 0] }, barMaxWidth: 14 }],
        });
    }

    function renderMarketVolume() {
        const data = query(`SELECT market, SUM(trade_value) as volume FROM trades GROUP BY market ORDER BY volume DESC LIMIT 15`);
        makeChart("chart-market-vol").setOption({
            tooltip: { ...tooltipBase(), trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p) => `${p[0].name}: <b>${fmt(p[0].value)}</b>` },
            grid: { top: 10, right: 30, bottom: 10, left: 80, containLabel: true },
            xAxis: { type: "value", axisLabel: { color: C.dim, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: C.border } } },
            yAxis: { type: "category", data: data.map((r) => r.market).reverse(), axisLabel: { color: C.text, fontSize: 11 }, axisLine: { show: false } },
            series: [{ type: "bar", data: data.map((r) => r.volume).reverse(), itemStyle: { color: (p) => PALETTE[p.dataIndex % PALETTE.length], borderRadius: [0, 3, 3, 0] }, barMaxWidth: 14 }],
        });
    }

    function renderPnLDecomp() {
        // Realized PnL by market
        const trades = query(`SELECT market, SUM(COALESCE(closed_pnl,0)) as realized, SUM(fee) as fees
            FROM trades GROUP BY market`);
        const funding = query(`SELECT market, SUM(payment) as funding FROM funding GROUP BY market`);
        const fmap = {}; for (const r of funding) fmap[r.market] = r.funding || 0;

        // Merge and compute net
        const rows = trades.map(r => ({
            market: r.market,
            realized: r.realized || 0,
            fees: r.fees || 0,
            funding: fmap[r.market] || 0,
            net: (r.realized || 0) - (r.fees || 0) + (fmap[r.market] || 0),
        }));
        // Sort by net ascending (worst at top when reversed for horizontal bar)
        rows.sort((a, b) => a.net - b.net);
        // Take top 20 worst and top 20 best
        const worst20 = rows.slice(0, 20);
        const best20 = rows.slice(-20);
        const shown = [...worst20, ...best20.filter(r => !worst20.includes(r))];
        shown.sort((a, b) => a.net - b.net);
        const markets = shown.map(r => r.market).reverse();

        makeChart("chart-pnl-decomp").setOption({
            tooltip: { ...tooltipBase(), trigger: "axis", axisPointer: { type: "shadow" },
                formatter: (params) => {
                    const m = params[0].name;
                    const r = shown.find(x => x.market === m);
                    if (!r) return m;
                    return `<b>${m}</b><br/>` +
                        `Realized: <span style="color:${r.realized >= 0 ? C.green : C.red}">${fmt(r.realized)}</span><br/>` +
                        `Fees: <span style="color:${C.red}">${fmt(-r.fees)}</span><br/>` +
                        `Funding: <span style="color:${r.funding >= 0 ? C.green : C.red}">${fmt(r.funding)}</span><br/>` +
                        `<b>Net: <span style="color:${r.net >= 0 ? C.green : C.red}">${fmt(r.net)}</span></b>`;
                }
            },
            legend: { data: ["Realized", "Funding", "Net"], textStyle: { color: C.text, fontFamily: MONO }, top: 5, itemWidth: 14, itemHeight: 3, icon: "roundRect" },
            grid: { top: 35, right: 30, bottom: 10, left: 80, containLabel: true },
            xAxis: { type: "value", axisLabel: { color: C.dim, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: C.border } } },
            yAxis: { type: "category", data: markets, axisLabel: { color: C.text, fontSize: 10 }, axisLine: { show: false } },
            series: [
                { name: "Realized", type: "bar", stack: "decomp", data: shown.map(r => r.realized).reverse(),
                  itemStyle: { color: C.blue, borderRadius: 0 }, barMaxWidth: 12 },
                { name: "Funding", type: "bar", stack: "decomp", data: shown.map(r => r.funding).reverse(),
                  itemStyle: { color: C.amber, borderRadius: 0 }, barMaxWidth: 12 },
                { name: "Net", type: "scatter", data: shown.map(r => r.net).reverse(), symbol: "diamond", symbolSize: 8,
                  itemStyle: { color: "#fff", borderColor: C.bg, borderWidth: 1 } },
            ],
        });

        // Decomp table
        renderDecompTable(rows);
    }

    function renderDecompTable(rows) {
        const tbody = document.querySelector("#table-decomp tbody");
        tbody.innerHTML = "";
        // Find max absolute value for inline bars
        const maxAbs = Math.max(...rows.map(r => Math.max(Math.abs(r.realized), Math.abs(r.funding), Math.abs(r.net))), 1);
        let sortCol = "net", sortAsc = true;

        function render(data) {
            tbody.innerHTML = "";
            for (const r of data) {
                const ratio = r.realized !== 0 ? (r.funding / Math.abs(r.realized) * 100).toFixed(0) + "%" : "—";
                const tr = document.createElement("tr");
                // Inline breakdown bar
                const realW = Math.abs(r.realized) / maxAbs * 100;
                const fundW = Math.abs(r.funding) / maxAbs * 100;
                const realColor = r.realized >= 0 ? C.green : C.red;
                const fundColor = r.funding >= 0 ? C.green : C.red;
                const bar = `<div style="display:flex;gap:2px;align-items:center;min-width:120px">` +
                    `<div style="width:${realW}%;height:10px;background:${realColor};border-radius:1px" title="Realized ${fmt(r.realized)}"></div>` +
                    `<div style="width:${fundW}%;height:10px;background:${fundColor};opacity:0.6;border-radius:1px" title="Funding ${fmt(r.funding)}"></div>` +
                    `</div>`;
                tr.innerHTML = `<td>${r.market}</td>` +
                    `<td class="${pnlClass(r.realized)}">${fmt(r.realized)}</td>` +
                    `<td class="${pnlClass(-r.fees)}">${fmt(r.fees)}</td>` +
                    `<td class="${pnlClass(r.funding)}">${fmt(r.funding)}</td>` +
                    `<td class="${pnlClass(r.net)}"><b>${fmt(r.net)}</b></td>` +
                    `<td class="${pnlClass(r.funding)}">${ratio}</td>` +
                    `<td>${bar}</td>`;
                tbody.appendChild(tr);
            }
        }

        function sortAndRender() {
            const sorted = [...rows].sort((a, b) => {
                const va = sortCol === "market" ? a.market : (a[sortCol] || 0);
                const vb = sortCol === "market" ? b.market : (b[sortCol] || 0);
                if (sortCol === "market") return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
                return sortAsc ? va - vb : vb - va;
            });
            render(sorted);
        }

        // Click handlers on sortable headers
        document.querySelectorAll("#table-decomp th.sortable").forEach(th => {
            th.style.cursor = "pointer";
            th.addEventListener("click", () => {
                const col = th.dataset.col;
                if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = col === "market"; }
                // Update sort indicators
                document.querySelectorAll("#table-decomp th.sortable").forEach(h => h.textContent = h.textContent.replace(/ [▲▼]/, ""));
                th.textContent += sortAsc ? " ▲" : " ▼";
                sortAndRender();
            });
        });

        sortAndRender();
    }

    function renderMakerTaker() {
        const data = query(`SELECT role, COUNT(*) as cnt, SUM(trade_value) as volume FROM trades WHERE role IS NOT NULL GROUP BY role`);
        makeChart("chart-maker-taker").setOption({
            tooltip: { trigger: "item", backgroundColor: C.bg3, borderColor: C.border, textStyle: { color: C.text },
                formatter: (p) => `${p.name}<br/>Volume: <b>${fmt(p.value)}</b><br/>Fills: ${data[p.dataIndex].cnt.toLocaleString()}` },
            series: [{ type: "pie", radius: ["40%", "70%"], center: ["50%", "50%"],
                data: data.map((r, i) => ({ name: r.role, value: r.volume, itemStyle: { color: [C.blue, C.amber, C.purple][i] } })),
                label: { color: C.text, formatter: "{b}\n{d}%" },
                emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.5)" } } }],
        });
    }

    function renderWinRate() {
        const data = query(`SELECT market, COUNT(*) as total, SUM(CASE WHEN closed_pnl>0 THEN 1 ELSE 0 END) as wins,
            ROUND(100.0*SUM(CASE WHEN closed_pnl>0 THEN 1 ELSE 0 END)/COUNT(*),1) as win_rate
            FROM trades WHERE closed_pnl IS NOT NULL AND closed_pnl!=0 GROUP BY market HAVING total>=10 ORDER BY win_rate DESC`);
        makeChart("chart-winrate").setOption({
            tooltip: { ...tooltipBase(), trigger: "axis", axisPointer: { type: "shadow" },
                formatter: (p) => { const r = data[data.length - 1 - p[0].dataIndex]; return `${r.market}: <b>${r.win_rate}%</b> (${r.wins}/${r.total})`; } },
            grid: { top: 10, right: 30, bottom: 10, left: 80, containLabel: true },
            xAxis: { type: "value", min: 0, max: 100, axisLabel: { color: C.dim, formatter: "{value}%" }, splitLine: { lineStyle: { color: C.border } } },
            yAxis: { type: "category", data: data.map((r) => r.market).reverse(), axisLabel: { color: C.text, fontSize: 11 }, axisLine: { show: false } },
            series: [{ type: "bar", data: data.map((r) => r.win_rate).reverse(),
                itemStyle: { color: (p) => p.value >= 50 ? C.green : C.red, borderRadius: [0, 3, 3, 0] },
                barMaxWidth: 14, label: { show: true, position: "right", color: C.dim, fontSize: 10, formatter: "{c}%" } }],
        });
    }

    function renderBestWorst() {
        const best = query(`SELECT market, side, date, trade_value, closed_pnl FROM trades WHERE closed_pnl IS NOT NULL AND closed_pnl!=0 ORDER BY closed_pnl DESC LIMIT 25`);
        const worst = query(`SELECT market, side, date, trade_value, closed_pnl FROM trades WHERE closed_pnl IS NOT NULL AND closed_pnl!=0 ORDER BY closed_pnl ASC LIMIT 25`);
        const fillTable = (id, rows) => {
            const tbody = document.querySelector(`#${id} tbody`); tbody.innerHTML = "";
            for (const r of rows) {
                const tr = document.createElement("tr");
                tr.innerHTML = `<td>${r.market}</td><td>${r.side}</td><td>${(r.date || "").slice(0, 10)}</td><td>${fmt(r.trade_value)}</td><td class="${pnlClass(r.closed_pnl)}">${fmt(r.closed_pnl)}</td>`;
                tbody.appendChild(tr);
            }
        };
        fillTable("table-best", best);
        fillTable("table-worst", worst);
    }

    function renderMonthlyTable() {
        const data = query(`SELECT strftime('%Y-%m', date) as month, COUNT(*) as trades, SUM(trade_value) as volume,
            SUM(COALESCE(closed_pnl,0)) as pnl, SUM(fee) as fees, SUM(CASE WHEN role='Maker' THEN 1 ELSE 0 END) as maker,
            COUNT(*) as total FROM trades GROUP BY month ORDER BY month DESC`);
        const fd = query(`SELECT strftime('%Y-%m', date) as month, SUM(payment) as funding FROM funding GROUP BY month`);
        const fmap = {}; for (const r of fd) fmap[r.month] = r.funding;
        const tbody = document.querySelector("#table-monthly tbody"); tbody.innerHTML = "";
        for (const r of data) {
            const funding = fmap[r.month] || 0, net = r.pnl - r.fees + funding;
            const makerPct = r.total > 0 ? ((r.maker / r.total) * 100).toFixed(1) + "%" : "—";
            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${r.month}</td><td>${r.trades.toLocaleString()}</td><td>${fmt(r.volume)}</td><td class="${pnlClass(r.pnl)}">${fmt(r.pnl)}</td><td>${fmt(r.fees)}</td><td class="${pnlClass(funding)}">${fmt(funding)}</td><td class="${pnlClass(net)}">${fmt(net)}</td><td>${makerPct}</td>`;
            tbody.appendChild(tr);
        }
    }

    function renderHourlyBox() {
        const raw = query(`SELECT CAST(strftime('%H', date) AS INTEGER) as hour, closed_pnl
            FROM trades WHERE closed_pnl IS NOT NULL AND closed_pnl!=0 ORDER BY hour`);
        const byHour = {};
        for (let h = 0; h < 24; h++) byHour[h] = [];
        for (const r of raw) byHour[r.hour].push(r.closed_pnl);

        const boxData = [], scatterData = [], hourLabels = [], hourSums = [];
        for (let h = 0; h < 24; h++) {
            const kst = (h + 9) % 24;
            hourLabels.push(`${String(h).padStart(2, "0")} UTC / ${String(kst).padStart(2, "0")} KST`);
            const vals = byHour[h].slice().sort((a, b) => a - b);
            hourSums.push(vals.reduce((s, v) => s + v, 0));
            if (vals.length === 0) { boxData.push([0, 0, 0, 0, 0]); continue; }
            const q1Idx = Math.floor(vals.length * 0.25), q2Idx = Math.floor(vals.length * 0.5), q3Idx = Math.floor(vals.length * 0.75);
            const iqr = vals[q3Idx] - vals[q1Idx];
            const lo = Math.max(vals[0], vals[q1Idx] - 1.5 * iqr), hi = Math.min(vals[vals.length - 1], vals[q3Idx] + 1.5 * iqr);
            boxData.push([lo, vals[q1Idx], vals[q2Idx], vals[q3Idx], hi]);
            let sampled = vals;
            if (sampled.length > 150) { const step = Math.ceil(sampled.length / 150); sampled = sampled.filter((_, i) => i % step === 0); }
            for (const v of sampled) scatterData.push([h + (Math.random() - 0.5) * 0.3, v]);
        }

        makeChart("chart-hourly-box").setOption({
            tooltip: { trigger: "item", backgroundColor: C.bg3, borderColor: C.border, textStyle: { color: C.text },
                formatter: (p) => {
                    if (p.seriesType === "scatter") return `Trade: <b>${fmt(p.value[1])}</b>`;
                    const d = p.value;
                    return `${p.name}<br/>Max: ${fmt(d[5])}<br/>Q3: ${fmt(d[4])}<br/>Median: ${fmt(d[3])}<br/>Q1: ${fmt(d[2])}<br/>Min: ${fmt(d[1])}<br/>Net: <b>${fmt(hourSums[p.dataIndex])}</b>`;
                } },
            grid: baseGrid({ bottom: 50 }),
            xAxis: { type: "category", data: hourLabels, axisLabel: { color: C.dim, fontSize: 9, rotate: 45 }, axisLine: { lineStyle: { color: C.border } } },
            yAxis: { type: "value", axisLabel: { color: C.dim, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: C.border } } },
            dataZoom: [{ type: "inside", yAxisIndex: 0 }],
            series: [
                { type: "boxplot", data: boxData,
                    itemStyle: { color: (p) => hourSums[p.dataIndex] >= 0 ? C.green + "25" : C.red + "25",
                        borderColor: (p) => hourSums[p.dataIndex] >= 0 ? C.green : C.red, borderWidth: 1.5 },
                    boxWidth: ["40%", "60%"] },
                { type: "scatter", data: scatterData, symbolSize: 3,
                    itemStyle: { color: (p) => p.value[1] >= 0 ? C.green + "50" : C.red + "50" } },
            ],
        });
    }

    function renderHeatmap() {
        const data = query(`SELECT CAST(strftime('%w', date) AS INTEGER) as dow, CAST(strftime('%H', date) AS INTEGER) as hour, COUNT(*) as cnt FROM trades GROUP BY dow, hour`);
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const heatData = []; let maxCnt = 1;
        for (const r of data) { maxCnt = Math.max(maxCnt, r.cnt); heatData.push([r.hour, r.dow, r.cnt]); }
        makeChart("chart-heatmap").setOption({
            tooltip: { backgroundColor: C.bg3, borderColor: C.border, textStyle: { color: C.text },
                formatter: (p) => `${days[p.value[1]]} ${String(p.value[0]).padStart(2, "0")}:00 UTC<br/>${p.value[2]} trades` },
            grid: { top: 10, right: 80, bottom: 30, left: 60 },
            xAxis: { type: "category", data: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")),
                axisLabel: { color: C.dim, fontSize: 10 }, axisLine: { lineStyle: { color: C.border } }, splitArea: { show: true, areaStyle: { color: [C.bg2, C.bg] } } },
            yAxis: { type: "category", data: days, axisLabel: { color: C.text }, axisLine: { show: false } },
            visualMap: { min: 0, max: maxCnt, calculable: true, orient: "vertical", right: 10, top: 10, bottom: 30,
                inRange: { color: [C.bg2, C.red + "60", C.amber + "60", C.green + "60", C.green] }, textStyle: { color: C.dim } },
            series: [{ type: "heatmap", data: heatData, emphasis: { itemStyle: { shadowBlur: 5, shadowColor: C.blue } } }],
        });
    }

    function renderFunding() {
        const data = query(`SELECT DATE(date) as day, SUM(payment) as payment FROM funding GROUP BY day ORDER BY day`);
        if (data.length === 0) { document.getElementById("chart-funding").innerHTML = '<p style="color:#8892a4;text-align:center;padding:60px">No funding data</p>'; return; }
        let cum = 0;
        const days = [], cumVals = [], dailyVals = [], dailyColors = [];
        for (const r of data) {
            cum += r.payment; days.push(r.day);
            cumVals.push(Math.round(cum * 100) / 100); dailyVals.push(Math.round(r.payment * 100) / 100);
            dailyColors.push(r.payment >= 0 ? C.green : C.red);
        }
        makeChart("chart-funding").setOption({
            tooltip: { ...tooltipBase(), formatter: fmtTooltip },
            legend: { data: ["Cumulative", "Daily"], textStyle: { color: C.dim }, top: 5, icon: "roundRect", itemWidth: 14, itemHeight: 3 },
            grid: baseGrid({ right: 70 }),
            xAxis: { type: "category", data: days, axisLabel: { color: C.dim, fontSize: 10 }, axisLine: { lineStyle: { color: C.border } } },
            yAxis: [
                { type: "value", axisLabel: { color: C.dim, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: C.border } } },
                { type: "value", position: "right", name: "Daily", nameTextStyle: { color: C.dim }, axisLabel: { color: C.dim, formatter: (v) => fmt(v) }, splitLine: { show: false } },
            ],
            dataZoom: dataZoomOpts(),
            series: [
                { name: "Cumulative", type: "line", data: cumVals, smooth: 0.3, symbol: "none", yAxisIndex: 0,
                    lineStyle: { color: C.purple, width: 2 },
                    areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: C.purple + "30" }, { offset: 1, color: C.purple + "05" }]) } },
                { name: "Daily", type: "bar", data: dailyVals, yAxisIndex: 1, itemStyle: { color: (p) => dailyColors[p.dataIndex] }, barMaxWidth: 6 },
            ],
        });
    }

    // ---- Init ----
    async function init() {
        try {
            _db = await loadDB();
            if (!_db) { document.getElementById("status-text").textContent = "No trade data. Open app.lighter.xyz first to sync."; return; }
            renderSummary();
            renderEquityCurve();
            renderExposure();
            renderTransfers();
            renderDailyPnL();
            renderMarketPnL();
            renderMarketVolume();
            renderPnLDecomp();
            renderMakerTaker();
            renderWinRate();
            renderBestWorst();
            renderMonthlyTable();
            renderHourlyBox();
            renderHeatmap();
            renderFunding();
        } catch (e) {
            console.error("Dashboard init error:", e);
            document.getElementById("status-text").textContent = "Error: " + e.message;
        }
    }

    window.addEventListener("resize", () => { for (const c of charts) c.resize(); });
    document.getElementById("btn-refresh").addEventListener("click", () => {
        chrome.tabs.create({ url: "https://app.lighter.xyz/trade/BTC", active: false }, (tab) => {
            document.getElementById("status-text").textContent = "Syncing...";
            setTimeout(() => { chrome.tabs.remove(tab.id); location.reload(); }, 30000);
        });
    });
    init();
})();
