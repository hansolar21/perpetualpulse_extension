// dashboard.js — Trade analytics dashboard for Perpetualpulse
// Runs as an extension page with direct access to IndexedDB + sql.js

(function () {
    "use strict";

    let _db = null;
    const COLORS = {
        green: "#10b981",
        red: "#ef4444",
        blue: "#3b82f6",
        purple: "#8b5cf6",
        amber: "#f59e0b",
        cyan: "#06b6d4",
        pink: "#ec4899",
        lime: "#84cc16",
        orange: "#f97316",
        teal: "#14b8a6",
        indigo: "#6366f1",
        rose: "#f43f5e",
    };
    const PALETTE = Object.values(COLORS);

    // ---- Chart.js defaults ----
    Chart.defaults.color = "#8892a4";
    Chart.defaults.borderColor = "#1e2a3a";
    Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.plugins.legend.labels.padding = 16;
    Chart.defaults.plugins.tooltip.backgroundColor = "#1a2235";
    Chart.defaults.plugins.tooltip.borderColor = "#1e2a3a";
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 6;

    // ---- Zoom/Pan config for time series ----
    const zoomPanPlugin = {
        zoom: {
            wheel: { enabled: true, modifierKey: null },
            pinch: { enabled: true },
            drag: { enabled: true, modifierKey: "shift" },
            mode: "x",
        },
        pan: {
            enabled: true,
            mode: "x",
        },
    };

    // ---- IndexedDB ----
    function openIDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(DB_STORE)) {
                    req.result.createObjectStore(DB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function base64ToUint8(b64) {
        const binary = atob(b64);
        const u8 = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
        return u8;
    }

    async function loadDB() {
        // Read from chrome.storage.local (shared across extension contexts)
        const result = await new Promise((resolve) => {
            chrome.storage.local.get("pp_trade_db_b64", (r) => resolve(r));
        });

        if (!result.pp_trade_db_b64) return null;

        const wasmUrl = chrome.runtime.getURL("lib/sql-wasm.wasm");
        const SQL = await initSqlJs({ locateFile: () => wasmUrl });
        return new SQL.Database(base64ToUint8(result.pp_trade_db_b64));
    }

    function query(sql) {
        if (!_db) return [];
        try {
            const result = _db.exec(sql);
            if (!result.length) return [];
            return result[0].values.map((row) => {
                const obj = {};
                result[0].columns.forEach((col, i) => (obj[col] = row[i]));
                return obj;
            });
        } catch (e) {
            console.error("Query error:", sql, e);
            return [];
        }
    }

    // ---- Formatting ----
    function fmt(n, decimals = 2) {
        if (n == null || isNaN(n)) return "—";
        const sign = n >= 0 ? "" : "-";
        const abs = Math.abs(n);
        if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(1) + "M";
        if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "K";
        return sign + "$" + abs.toFixed(decimals);
    }

    function pnlClass(n) {
        if (n > 0) return "positive";
        if (n < 0) return "negative";
        return "";
    }

    // ---- Summary Cards ----
    function renderSummary() {
        const totals = query(`
            SELECT COUNT(*) as trades,
                COALESCE(SUM(trade_value), 0) as volume,
                COALESCE(SUM(COALESCE(closed_pnl, 0)), 0) as pnl,
                COALESCE(SUM(fee), 0) as fees
            FROM trades
        `)[0] || {};

        const fundingTotal = query(`
            SELECT COALESCE(SUM(payment), 0) as total FROM funding
        `)[0] || {};

        const winData = query(`
            SELECT COUNT(*) as total,
                SUM(CASE WHEN closed_pnl > 0 THEN 1 ELSE 0 END) as wins
            FROM trades WHERE closed_pnl IS NOT NULL AND closed_pnl != 0
        `)[0] || {};

        const funding = fundingTotal.total || 0;
        const net = (totals.pnl || 0) - (totals.fees || 0) + funding;
        const winRate = winData.total > 0 ? ((winData.wins / winData.total) * 100).toFixed(1) + "%" : "—";

        const set = (id, val, cls) => {
            const el = document.getElementById(id);
            el.textContent = val;
            if (cls) el.className = "card-value " + cls;
        };

        set("stat-trades", (totals.trades || 0).toLocaleString());
        set("stat-pnl", fmt(totals.pnl), pnlClass(totals.pnl));
        set("stat-fees", fmt(totals.fees));
        set("stat-net", fmt(net), pnlClass(net));
        set("stat-volume", fmt(totals.volume));
        set("stat-winrate", winRate);

        // Status bar
        const range = query("SELECT MIN(date) as mn, MAX(date) as mx, COUNT(DISTINCT DATE(date)) as days FROM trades")[0] || {};
        const fundingStr = funding !== 0 ? ` | funding: ${fmt(funding)}` : "";
        document.getElementById("status-text").textContent =
            `${(totals.trades || 0).toLocaleString()} trades | ${range.days || 0} days | ${(range.mn || "").slice(0, 10)} → ${(range.mx || "").slice(0, 10)}${fundingStr}`;
    }

    // ---- Equity Curve ----
    function renderEquityCurve() {
        const data = query(`
            SELECT DATE(date) as day, SUM(COALESCE(closed_pnl, 0)) as pnl, SUM(fee) as fees
            FROM trades GROUP BY day ORDER BY day
        `);

        // Get daily funding
        const fundingData = query(`
            SELECT DATE(date) as day, SUM(payment) as funding
            FROM funding GROUP BY day ORDER BY day
        `);
        const fundingMap = {};
        for (const f of fundingData) fundingMap[f.day] = f.funding;

        let cumPnl = 0, cumNet = 0;
        const labels = [], pnlData = [], netData = [];
        for (const row of data) {
            const dailyFunding = fundingMap[row.day] || 0;
            cumPnl += row.pnl;
            cumNet += row.pnl - row.fees + dailyFunding;
            labels.push(row.day);
            pnlData.push(cumPnl);
            netData.push(cumNet);
        }

        new Chart(document.getElementById("chart-equity"), {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Gross P&L",
                        data: pnlData,
                        borderColor: COLORS.blue,
                        backgroundColor: COLORS.blue + "20",
                        fill: true,
                        tension: 0.3,
                        pointRadius: 0,
                        borderWidth: 2,
                    },
                    {
                        label: "Net P&L (after fees)",
                        data: netData,
                        borderColor: COLORS.green,
                        backgroundColor: COLORS.green + "10",
                        fill: true,
                        tension: 0.3,
                        pointRadius: 0,
                        borderWidth: 2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: "index" },
                scales: {
                    x: { type: "time", time: { unit: "week" }, grid: { display: false } },
                    y: {
                        grid: { color: "#1e2a3a" },
                        ticks: { callback: (v) => fmt(v) },
                    },
                },
                plugins: {
                    zoom: zoomPanPlugin,
                    tooltip: {
                        callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.raw)}` },
                    },
                },
            },
        });
    }

    // ---- Daily P&L Bar ----
    function renderDailyPnL() {
        const data = query(`
            SELECT DATE(date) as day,
                SUM(COALESCE(closed_pnl, 0)) as pnl,
                SUM(fee) as fees
            FROM trades GROUP BY day ORDER BY day
        `);

        const labels = data.map((r) => r.day);
        const netPnl = data.map((r) => r.pnl - r.fees);
        const bgColors = netPnl.map((v) => (v >= 0 ? COLORS.green + "cc" : COLORS.red + "cc"));

        new Chart(document.getElementById("chart-daily-pnl"), {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: "Daily Net P&L",
                    data: netPnl,
                    backgroundColor: bgColors,
                    borderRadius: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { type: "time", time: { unit: "week" }, grid: { display: false } },
                    y: {
                        grid: { color: "#1e2a3a" },
                        ticks: { callback: (v) => fmt(v) },
                    },
                },
                plugins: {
                    zoom: zoomPanPlugin,
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => fmt(ctx.raw) } },
                },
            },
        });
    }

    // ---- P&L by Market ----
    function renderMarketPnL() {
        const data = query(`
            SELECT market, SUM(COALESCE(closed_pnl, 0)) - SUM(fee) as net_pnl
            FROM trades GROUP BY market ORDER BY net_pnl DESC
        `);

        new Chart(document.getElementById("chart-market-pnl"), {
            type: "bar",
            data: {
                labels: data.map((r) => r.market),
                datasets: [{
                    label: "Net P&L",
                    data: data.map((r) => r.net_pnl),
                    backgroundColor: data.map((r) => (r.net_pnl >= 0 ? COLORS.green + "cc" : COLORS.red + "cc")),
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: "y",
                scales: {
                    x: { grid: { color: "#1e2a3a" }, ticks: { callback: (v) => fmt(v) } },
                    y: { grid: { display: false } },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => fmt(ctx.raw) } },
                },
            },
        });
    }

    // ---- Volume by Market ----
    function renderMarketVolume() {
        const data = query(`
            SELECT market, SUM(trade_value) as volume
            FROM trades GROUP BY market ORDER BY volume DESC LIMIT 15
        `);

        new Chart(document.getElementById("chart-market-vol"), {
            type: "bar",
            data: {
                labels: data.map((r) => r.market),
                datasets: [{
                    label: "Volume",
                    data: data.map((r) => r.volume),
                    backgroundColor: PALETTE.slice(0, data.length).map((c) => c + "cc"),
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: "y",
                scales: {
                    x: { grid: { color: "#1e2a3a" }, ticks: { callback: (v) => fmt(v) } },
                    y: { grid: { display: false } },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => fmt(ctx.raw) } },
                },
            },
        });
    }

    // ---- Maker vs Taker ----
    function renderMakerTaker() {
        const data = query(`
            SELECT role, COUNT(*) as cnt, SUM(trade_value) as volume
            FROM trades WHERE role IS NOT NULL GROUP BY role
        `);

        new Chart(document.getElementById("chart-maker-taker"), {
            type: "doughnut",
            data: {
                labels: data.map((r) => `${r.role} (${r.cnt.toLocaleString()})`),
                datasets: [{
                    data: data.map((r) => r.volume),
                    backgroundColor: [COLORS.blue + "cc", COLORS.amber + "cc", COLORS.purple + "cc"],
                    borderColor: "#111827",
                    borderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const r = data[ctx.dataIndex];
                                return `${r.role}: ${fmt(r.volume)} (${r.cnt.toLocaleString()} fills)`;
                            },
                        },
                    },
                },
            },
        });
    }

    // ---- Win Rate by Market ----
    function renderWinRate() {
        const data = query(`
            SELECT market,
                COUNT(*) as total,
                SUM(CASE WHEN closed_pnl > 0 THEN 1 ELSE 0 END) as wins,
                ROUND(100.0 * SUM(CASE WHEN closed_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate
            FROM trades
            WHERE closed_pnl IS NOT NULL AND closed_pnl != 0
            GROUP BY market HAVING total >= 10
            ORDER BY win_rate DESC
        `);

        new Chart(document.getElementById("chart-winrate"), {
            type: "bar",
            data: {
                labels: data.map((r) => r.market),
                datasets: [{
                    label: "Win Rate %",
                    data: data.map((r) => r.win_rate),
                    backgroundColor: data.map((r) =>
                        r.win_rate >= 50 ? COLORS.green + "cc" : COLORS.red + "cc"
                    ),
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: "y",
                scales: {
                    x: { min: 0, max: 100, grid: { color: "#1e2a3a" }, ticks: { callback: (v) => v + "%" } },
                    y: { grid: { display: false } },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const r = data[ctx.dataIndex];
                                return `${r.win_rate}% (${r.wins}/${r.total})`;
                            },
                        },
                    },
                },
            },
        });
    }

    // ---- Best & Worst Trades ----
    function renderBestWorst() {
        const best = query(`
            SELECT market, side, date, trade_value, closed_pnl
            FROM trades WHERE closed_pnl IS NOT NULL AND closed_pnl != 0
            ORDER BY closed_pnl DESC LIMIT 15
        `);
        const worst = query(`
            SELECT market, side, date, trade_value, closed_pnl
            FROM trades WHERE closed_pnl IS NOT NULL AND closed_pnl != 0
            ORDER BY closed_pnl ASC LIMIT 15
        `);

        const fillTable = (id, rows) => {
            const tbody = document.querySelector(`#${id} tbody`);
            tbody.innerHTML = "";
            for (const r of rows) {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${r.market}</td>
                    <td>${r.side}</td>
                    <td>${(r.date || "").slice(0, 10)}</td>
                    <td>${fmt(r.trade_value)}</td>
                    <td class="${pnlClass(r.closed_pnl)}">${fmt(r.closed_pnl)}</td>
                `;
                tbody.appendChild(tr);
            }
        };
        fillTable("table-best", best);
        fillTable("table-worst", worst);
    }

    // ---- Monthly Table ----
    function renderMonthlyTable() {
        const data = query(`
            SELECT strftime('%Y-%m', date) as month,
                COUNT(*) as trades,
                SUM(trade_value) as volume,
                SUM(COALESCE(closed_pnl, 0)) as pnl,
                SUM(fee) as fees,
                SUM(CASE WHEN role='Maker' THEN 1 ELSE 0 END) as maker,
                COUNT(*) as total
            FROM trades GROUP BY month ORDER BY month DESC
        `);

        // Monthly funding
        const fundingData = query(`
            SELECT strftime('%Y-%m', date) as month, SUM(payment) as funding
            FROM funding GROUP BY month
        `);
        const fundingMap = {};
        for (const f of fundingData) fundingMap[f.month] = f.funding;

        const tbody = document.querySelector("#table-monthly tbody");
        tbody.innerHTML = "";
        for (const r of data) {
            const funding = fundingMap[r.month] || 0;
            const net = r.pnl - r.fees + funding;
            const makerPct = r.total > 0 ? ((r.maker / r.total) * 100).toFixed(1) + "%" : "—";
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${r.month}</td>
                <td>${r.trades.toLocaleString()}</td>
                <td>${fmt(r.volume)}</td>
                <td class="${pnlClass(r.pnl)}">${fmt(r.pnl)}</td>
                <td>${fmt(r.fees)}</td>
                <td class="${pnlClass(funding)}">${fmt(funding)}</td>
                <td class="${pnlClass(net)}">${fmt(net)}</td>
                <td>${makerPct}</td>
            `;
            tbody.appendChild(tr);
        }
    }

    // ---- Hourly P&L Box Plot ----
    function renderHourlyBox() {
        // Get per-trade PnL grouped by hour
        const raw = query(`
            SELECT CAST(strftime('%H', date) AS INTEGER) as hour, closed_pnl
            FROM trades
            WHERE closed_pnl IS NOT NULL AND closed_pnl != 0
            ORDER BY hour
        `);

        // Group by hour
        const byHour = {};
        for (let h = 0; h < 24; h++) byHour[h] = [];
        for (const r of raw) {
            byHour[r.hour].push(r.closed_pnl);
        }

        // Build box plot data + scatter overlay
        const labels = Array.from({ length: 24 }, (_, h) => {
            const kst = (h + 9) % 24;
            return `${String(h).padStart(2, "0")} UTC\n${String(kst).padStart(2, "0")} KST`;
        });

        // Box plot dataset
        const boxData = labels.map((_, h) => {
            const vals = byHour[h];
            if (vals.length === 0) return null;
            // Clamp outliers for box plot visualization (keep scatter for full range)
            return vals;
        });

        // Scatter: sample up to 200 points per hour for visibility
        const scatterData = [];
        for (let h = 0; h < 24; h++) {
            let vals = byHour[h];
            // Sample if too many
            if (vals.length > 200) {
                const step = Math.ceil(vals.length / 200);
                vals = vals.filter((_, i) => i % step === 0);
            }
            for (const v of vals) {
                scatterData.push({ x: h, y: v });
            }
        }

        // Compute aggregate for coloring
        const hourSums = labels.map((_, h) => byHour[h].reduce((s, v) => s + v, 0));

        new Chart(document.getElementById("chart-hourly-box"), {
            type: "boxplot",
            data: {
                labels,
                datasets: [
                    {
                        label: "P&L Distribution",
                        data: boxData,
                        backgroundColor: hourSums.map((s) =>
                            s >= 0 ? COLORS.green + "40" : COLORS.red + "40"
                        ),
                        borderColor: hourSums.map((s) =>
                            s >= 0 ? COLORS.green + "aa" : COLORS.red + "aa"
                        ),
                        borderWidth: 1.5,
                        outlierRadius: 0, // hide outlier dots (we use scatter)
                        itemRadius: 0,
                        medianColor: "#e2e8f0",
                        meanRadius: 0,
                    },
                    {
                        type: "scatter",
                        label: "Individual Trades",
                        data: scatterData,
                        backgroundColor: scatterData.map((d) =>
                            d.y >= 0 ? COLORS.green + "30" : COLORS.red + "30"
                        ),
                        pointRadius: 1.5,
                        pointHoverRadius: 4,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            maxRotation: 0,
                            font: { size: 10 },
                        },
                    },
                    y: {
                        grid: { color: "#1e2a3a" },
                        ticks: { callback: (v) => fmt(v) },
                        // Clamp y-axis to show the interesting range
                        suggestedMin: -5000,
                        suggestedMax: 5000,
                    },
                },
                plugins: {
                    zoom: zoomPanPlugin,
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                if (ctx.dataset.type === "scatter") {
                                    return `Trade: ${fmt(ctx.raw.y)}`;
                                }
                                return ctx.dataset.label;
                            },
                        },
                    },
                },
            },
        });
    }

    // ---- Hourly Heatmap ----
    function renderHeatmap() {
        const data = query(`
            SELECT CAST(strftime('%w', date) AS INTEGER) as dow,
                CAST(strftime('%H', date) AS INTEGER) as hour,
                COUNT(*) as cnt
            FROM trades GROUP BY dow, hour
        `);

        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const hours = Array.from({ length: 24 }, (_, i) => i);
        const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
        let maxCnt = 1;

        for (const r of data) {
            matrix[r.dow][r.hour] = r.cnt;
            if (r.cnt > maxCnt) maxCnt = r.cnt;
        }

        // Use a bar chart with stacked — each hour gets 7 segments
        const datasets = days.map((day, di) => ({
            label: day,
            data: hours.map((h) => matrix[di][h]),
            backgroundColor: hours.map((h) => {
                const intensity = matrix[di][h] / maxCnt;
                const alpha = Math.max(0.05, intensity);
                return `rgba(59, 130, 246, ${alpha})`;
            }),
        }));

        new Chart(document.getElementById("chart-heatmap"), {
            type: "bar",
            data: {
                labels: hours.map((h) => h + ":00"),
                datasets,
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: { stacked: true, grid: { color: "#1e2a3a" } },
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            title: (items) => `${items[0].label} UTC`,
                            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw} trades`,
                        },
                    },
                },
            },
        });
    }

    // ---- Cumulative Funding ----
    function renderFunding() {
        const data = query(`
            SELECT DATE(date) as day, SUM(payment) as payment
            FROM funding GROUP BY day ORDER BY day
        `);

        if (data.length === 0) {
            document.getElementById("chart-funding").parentElement.innerHTML =
                '<p style="color:#8892a4;text-align:center;padding:40px">No funding data available</p>';
            return;
        }

        let cum = 0;
        const labels = [], cumData = [];
        for (const r of data) {
            cum += r.payment;
            labels.push(r.day);
            cumData.push(cum);
        }

        new Chart(document.getElementById("chart-funding"), {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: "Cumulative Funding",
                    data: cumData,
                    borderColor: COLORS.purple,
                    backgroundColor: COLORS.purple + "20",
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0,
                    borderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { type: "time", time: { unit: "week" }, grid: { display: false } },
                    y: { grid: { color: "#1e2a3a" }, ticks: { callback: (v) => fmt(v) } },
                },
                plugins: {
                    zoom: zoomPanPlugin,
                    tooltip: { callbacks: { label: (ctx) => fmt(ctx.raw) } },
                },
            },
        });
    }

    // ---- Init ----
    async function init() {
        try {
            _db = await loadDB();
            if (!_db) {
                document.getElementById("status-text").textContent =
                    "No trade data. Open app.lighter.xyz first to sync.";
                return;
            }

            renderSummary();
            renderEquityCurve();
            renderDailyPnL();
            renderMarketPnL();
            renderMarketVolume();
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

    // Sync button
    document.getElementById("btn-refresh").addEventListener("click", () => {
        // Open Lighter in background to trigger sync, then reload
        chrome.tabs.create({ url: "https://app.lighter.xyz/trade/BTC", active: false }, (tab) => {
            document.getElementById("status-text").textContent = "Syncing... (opened Lighter tab)";
            // Wait and reload after sync
            setTimeout(() => {
                chrome.tabs.remove(tab.id);
                location.reload();
            }, 30000);
        });
    });

    init();
})();
