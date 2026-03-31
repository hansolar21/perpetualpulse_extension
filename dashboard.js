// dashboard.js — Trade analytics dashboard for Perpetualpulse
// Runs as an extension page with direct access to IndexedDB + sql.js

(function () {
    "use strict";

    const DB_NAME = "pp_trade_history";
    const DB_STORE = "sqlite_db";

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

    async function loadDB() {
        const idb = await openIDB();
        const data = await new Promise((resolve, reject) => {
            const tx = idb.transaction(DB_STORE, "readonly");
            const req = tx.objectStore(DB_STORE).get("db");
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        if (!data) return null;

        const wasmUrl = chrome.runtime.getURL("lib/sql-wasm.wasm");
        const SQL = await initSqlJs({ locateFile: () => wasmUrl });
        return new SQL.Database(new Uint8Array(data));
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

        const winData = query(`
            SELECT COUNT(*) as total,
                SUM(CASE WHEN closed_pnl > 0 THEN 1 ELSE 0 END) as wins
            FROM trades WHERE closed_pnl IS NOT NULL AND closed_pnl != 0
        `)[0] || {};

        const net = (totals.pnl || 0) - (totals.fees || 0);
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
        document.getElementById("status-text").textContent =
            `${(totals.trades || 0).toLocaleString()} trades | ${range.days || 0} days | ${(range.mn || "").slice(0, 10)} → ${(range.mx || "").slice(0, 10)}`;
    }

    // ---- Equity Curve ----
    function renderEquityCurve() {
        const data = query(`
            SELECT DATE(date) as day, SUM(COALESCE(closed_pnl, 0)) as pnl, SUM(fee) as fees
            FROM trades GROUP BY day ORDER BY day
        `);

        let cumPnl = 0, cumNet = 0;
        const labels = [], pnlData = [], netData = [];
        for (const row of data) {
            cumPnl += row.pnl;
            cumNet += row.pnl - row.fees;
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

        const tbody = document.querySelector("#table-monthly tbody");
        tbody.innerHTML = "";
        for (const r of data) {
            const net = r.pnl - r.fees;
            const makerPct = r.total > 0 ? ((r.maker / r.total) * 100).toFixed(1) + "%" : "—";
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${r.month}</td>
                <td>${r.trades.toLocaleString()}</td>
                <td>${fmt(r.volume)}</td>
                <td class="${pnlClass(r.pnl)}">${fmt(r.pnl)}</td>
                <td>${fmt(r.fees)}</td>
                <td class="${pnlClass(net)}">${fmt(net)}</td>
                <td>${makerPct}</td>
            `;
            tbody.appendChild(tr);
        }
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
            renderMonthlyTable();
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
