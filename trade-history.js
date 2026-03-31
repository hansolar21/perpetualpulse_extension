// trade-history.js — Trade history sync & analytics for Lighter.xyz
// Uses the export API + SQLite (sql.js) for local storage and queries
// Runs in content script context on app.lighter.xyz

(function () {
    "use strict";

    // Only run on Lighter
    if (!location.hostname.includes("lighter.xyz")) return;

    console.log("[Perpetualpulse] Trade history module loading");

    const EXPORT_API = "https://mainnet.zklighter.elliot.ai/api/v1/export";
    const DB_NAME = "pp_trade_history";
    const DB_STORE = "sqlite_db";
    const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
    const QUARTER_MS = 90 * 24 * 60 * 60 * 1000; // ~3 months

    let _db = null;
    let _sqlReady = null; // promise for SQL.js init
    let _syncing = false;
    let _lastSyncTime = 0;

    // ---------- Auth (via page-bridge.js in MAIN world) ----------
    function getAuth() {
        return new Promise((resolve) => {
            const id = "pp-req-" + Math.random().toString(36).slice(2);
            const handler = (e) => {
                if (e.data?.type === "pp-auth-response" && e.data.id === id) {
                    window.removeEventListener("message", handler);
                    resolve({ token: e.data.token, accountIndex: e.data.accountIndex });
                }
            };
            window.addEventListener("message", handler);
            window.postMessage({ type: "pp-get-auth", id });

            // Timeout after 2s
            setTimeout(() => {
                window.removeEventListener("message", handler);
                resolve({ token: null, accountIndex: null });
            }, 2000);
        });
    }

    // ---------- IndexedDB (persist SQLite DB) ----------
    function openIDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(DB_STORE)) {
                    db.createObjectStore(DB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function loadDBFromIDB() {
        const idb = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = idb.transaction(DB_STORE, "readonly");
            const store = tx.objectStore(DB_STORE);
            const req = store.get("db");
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function saveDBToIDB(data) {
        const idb = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = idb.transaction(DB_STORE, "readwrite");
            const store = tx.objectStore(DB_STORE);
            const req = store.put(data, "db");
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async function saveMeta(key, value) {
        const idb = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = idb.transaction(DB_STORE, "readwrite");
            const store = tx.objectStore(DB_STORE);
            store.put(value, "meta_" + key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function loadMeta(key) {
        const idb = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = idb.transaction(DB_STORE, "readonly");
            const store = tx.objectStore(DB_STORE);
            const req = store.get("meta_" + key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    }

    // ---------- SQL.js Init ----------
    async function initSQL() {
        if (_sqlReady) return _sqlReady;

        _sqlReady = (async () => {
            // Load sql.js from extension
            const wasmUrl = chrome.runtime.getURL("lib/sql-wasm.wasm");

            // sql.js loaded via manifest content_scripts
            if (typeof initSqlJs === "undefined") {
                console.warn("[Perpetualpulse] sql.js not loaded");
                return null;
            }

            const SQL = await initSqlJs({
                locateFile: () => wasmUrl,
            });

            // Try to load existing DB from IndexedDB
            const saved = await loadDBFromIDB();
            if (saved) {
                _db = new SQL.Database(new Uint8Array(saved));
                console.log("[Perpetualpulse] Loaded existing trade DB from IndexedDB");
            } else {
                _db = new SQL.Database();
                createSchema();
                console.log("[Perpetualpulse] Created new trade DB");
            }

            return _db;
        })();

        return _sqlReady;
    }

    function createSchema() {
        if (!_db) return;
        _db.run(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                market TEXT NOT NULL,
                side TEXT NOT NULL,
                date TEXT NOT NULL,
                trade_value REAL NOT NULL,
                size REAL NOT NULL,
                price REAL NOT NULL,
                closed_pnl REAL,
                fee REAL DEFAULT 0,
                role TEXT,
                type TEXT,
                UNIQUE(market, date, trade_value, size, price, side)
            );
            CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market);
            CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(date);

            CREATE TABLE IF NOT EXISTS funding (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                market TEXT NOT NULL,
                date TEXT NOT NULL,
                payment REAL NOT NULL,
                annual_rate REAL,
                position_size REAL,
                UNIQUE(market, date, payment)
            );
            CREATE INDEX IF NOT EXISTS idx_funding_date ON funding(date);

            CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sync_time TEXT NOT NULL,
                type TEXT NOT NULL,
                rows_added INTEGER DEFAULT 0,
                start_date TEXT,
                end_date TEXT
            );
        `);
    }

    async function persistDB() {
        if (!_db) return;
        const data = _db.export();
        await saveDBToIDB(data.buffer);
    }

    // ---------- Data Fetch ----------
    async function fetchExportCSV(authToken, accountIndex, type, startMs, endMs) {
        let params = `account_index=${accountIndex}&type=${type}&start_timestamp=${startMs}&end_timestamp=${endMs}`;
        if (type === "trade") params += "&side=all&role=all&trade_type=all";

        const url = `${EXPORT_API}?${params}`;
        const resp = await fetch(url, {
            headers: {
                Authorization: authToken,
                PreferAuthServer: "true",
                Origin: "https://app.lighter.xyz",
            },
        });

        const data = await resp.json();
        if (data.code === 22504 || data.code === 20001) return null; // no data / invalid range
        if (data.code !== 200 || !data.data_url) {
            console.warn("[Perpetualpulse] Export API error:", data);
            return null;
        }

        // Fetch from S3
        const csvResp = await fetch(data.data_url);
        if (!csvResp.ok) return null;
        const csvText = await csvResp.text();
        const lines = csvText.trim().split("\n");
        if (lines.length <= 1) return null; // headers only

        return { header: lines[0], rows: lines.slice(1) };
    }

    function parseTradeRow(line) {
        // Market,Side,Date,Trade Value,Size,Price,Closed PnL,Fee,Role,Type
        const parts = line.split(",");
        if (parts.length < 10) return null;
        return {
            market: parts[0],
            side: parts[1],
            date: parts[2],
            trade_value: parseFloat(parts[3]) || 0,
            size: parseFloat(parts[4]) || 0,
            price: parseFloat(parts[5]) || 0,
            closed_pnl: parts[6] === "-" ? null : parseFloat(parts[6]) || 0,
            fee: parseFloat(parts[7]) || 0,
            role: parts[8],
            type: parts[9],
        };
    }

    function parseFundingRow(line) {
        const parts = line.split(",");
        if (parts.length < 5) return null;
        return {
            market: parts[0],
            date: parts[1],
            payment: parseFloat(parts[2]) || 0,
            annual_rate: parseFloat(parts[3]) || 0,
            position_size: parseFloat(parts[4]) || 0,
        };
    }

    function insertTrades(rows) {
        if (!_db || rows.length === 0) return 0;
        const stmt = _db.prepare(
            `INSERT OR IGNORE INTO trades (market, side, date, trade_value, size, price, closed_pnl, fee, role, type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        let added = 0;
        for (const line of rows) {
            const r = parseTradeRow(line);
            if (!r) continue;
            stmt.run([r.market, r.side, r.date, r.trade_value, r.size, r.price, r.closed_pnl, r.fee, r.role, r.type]);
            added += _db.getRowsModified();
        }
        stmt.free();
        return added;
    }

    function insertFunding(rows) {
        if (!_db || rows.length === 0) return 0;
        const stmt = _db.prepare(
            `INSERT OR IGNORE INTO funding (market, date, payment, annual_rate, position_size)
             VALUES (?, ?, ?, ?, ?)`
        );
        let added = 0;
        for (const line of rows) {
            const r = parseFundingRow(line);
            if (!r) continue;
            stmt.run([r.market, r.date, r.payment, r.annual_rate, r.position_size]);
            added += _db.getRowsModified();
        }
        stmt.free();
        return added;
    }

    // ---------- Sync Logic ----------
    function getQuarterRanges(startDate, endDate) {
        // Lighter export API requires KST-aligned quarter boundaries
        const ranges = [];
        // Start from the 1st of the start month at 00:00 KST
        let year = startDate.getUTCFullYear();
        let month = startDate.getUTCMonth(); // 0-based

        while (true) {
            // Quarter start: 1st of month at 00:00 KST (= prev day 15:00 UTC)
            const startKST = new Date(Date.UTC(year, month, 1) - 9 * 3600000);
            // Quarter end: last day of month+2 at 23:59:59.999 KST
            const endMonth = month + 2;
            const endYear = year + Math.floor(endMonth / 12);
            const endM = endMonth % 12;
            // First day of next month minus 1ms = last moment of end month
            const endKST = new Date(Date.UTC(endYear, endM + 1, 1) - 9 * 3600000 - 1);

            if (startKST.getTime() > endDate.getTime()) break;

            const effectiveStart = startKST.getTime() < startDate.getTime() ? startDate.getTime() : startKST.getTime();
            const effectiveEnd = endKST.getTime() > endDate.getTime() ? endDate.getTime() : endKST.getTime();

            ranges.push([effectiveStart, effectiveEnd]);

            // Advance to next quarter
            month += 3;
            if (month >= 12) { month -= 12; year++; }
        }
        return ranges;
    }

    async function syncTradeHistory() {
        if (_syncing) return;
        _syncing = true;

        try {
            // Retry auth up to 6 times (30s total) — page needs time to make API calls
            let auth = { token: null, accountIndex: null };
            for (let attempt = 0; attempt < 6; attempt++) {
                auth = await getAuth();
                if (auth.token) break;
                console.log(`[Perpetualpulse] Waiting for auth token (attempt ${attempt + 1}/6)...`);
                await new Promise((r) => setTimeout(r, 5000));
            }
            if (!auth.token) {
                console.log("[Perpetualpulse] Not logged in, skipping trade sync");
                return;
            }
            const authToken = auth.token;

            // Determine account index
            let accountIndex = auth.accountIndex || await loadMeta("account_index");
            if (!accountIndex) {
                console.log("[Perpetualpulse] Could not detect account index, skipping sync");
                return;
            }
            await saveMeta("account_index", accountIndex);

            await initSQL();
            if (!_db) return;

            // Find the latest trade we have
            let lastDate = null;
            try {
                const result = _db.exec("SELECT MAX(date) FROM trades");
                if (result.length > 0 && result[0].values[0][0]) {
                    lastDate = result[0].values[0][0];
                }
            } catch (e) {}

            // Determine start date for sync
            let startMs;
            if (lastDate) {
                // Start from 1 day before last trade (overlap to catch any missed)
                startMs = new Date(lastDate).getTime() - 86400000;
                console.log(`[Perpetualpulse] Incremental sync from ${lastDate}`);
            } else {
                // First sync — start from account creation (~Jan 2025)
                startMs = await loadMeta("first_trade_ms") || new Date("2025-01-17").getTime();
                console.log("[Perpetualpulse] Full sync from", new Date(startMs).toISOString());
            }

            const endMs = Date.now();
            const quarters = getQuarterRanges(new Date(startMs), new Date(endMs));
            let totalAdded = 0;

            for (const [qStart, qEnd] of quarters) {
                console.log(`[Perpetualpulse] Fetching trades ${new Date(qStart).toISOString().slice(0, 10)} → ${new Date(qEnd).toISOString().slice(0, 10)}`);

                const data = await fetchExportCSV(authToken, accountIndex, "trade", qStart, qEnd);
                if (data) {
                    const added = insertTrades(data.rows);
                    totalAdded += added;
                    console.log(`[Perpetualpulse] +${added} trades (${data.rows.length} fetched)`);
                }

                // Rate limit
                await new Promise((r) => setTimeout(r, 500));
            }

            // Also sync funding
            for (const [qStart, qEnd] of quarters) {
                try {
                    const data = await fetchExportCSV(authToken, accountIndex, "funding", qStart, qEnd);
                    if (data) insertFunding(data.rows);
                } catch (e) {
                    // Funding export may fail for some ranges
                }
                await new Promise((r) => setTimeout(r, 500));
            }

            // Persist and log
            await persistDB();
            _lastSyncTime = Date.now();
            await saveMeta("last_sync", _lastSyncTime);

            const totalTrades = _db.exec("SELECT COUNT(*) FROM trades")[0].values[0][0];
            const totalFunding = _db.exec("SELECT COUNT(*) FROM funding")[0].values[0][0];
            console.log(`[Perpetualpulse] Sync complete: ${totalTrades} trades, ${totalFunding} funding entries (+${totalAdded} new)`);

            _db.run(
                `INSERT INTO sync_log (sync_time, type, rows_added) VALUES (datetime('now'), 'auto', ?)`,
                [totalAdded]
            );
            await persistDB();
        } catch (e) {
            console.error("[Perpetualpulse] Sync error:", e);
        } finally {
            _syncing = false;
        }
    }

    // ---------- Query API (exposed to other scripts) ----------
    window._PP_TradeDB = {
        // Run a raw SQL query
        query: async (sql, params = []) => {
            await initSQL();
            if (!_db) return [];
            try {
                const result = _db.exec(sql, params);
                if (result.length === 0) return [];
                return result[0].values.map((row) => {
                    const obj = {};
                    result[0].columns.forEach((col, i) => (obj[col] = row[i]));
                    return obj;
                });
            } catch (e) {
                console.error("[Perpetualpulse] Query error:", e);
                return [];
            }
        },

        // Get P&L by market
        pnlByMarket: async () => {
            return window._PP_TradeDB.query(`
                SELECT market,
                    COUNT(*) as trades,
                    ROUND(SUM(trade_value), 2) as volume,
                    ROUND(SUM(COALESCE(closed_pnl, 0)), 2) as realized_pnl,
                    ROUND(SUM(fee), 2) as fees,
                    SUM(CASE WHEN role='Maker' THEN 1 ELSE 0 END) as maker_fills,
                    SUM(CASE WHEN role='Taker' THEN 1 ELSE 0 END) as taker_fills
                FROM trades
                GROUP BY market
                ORDER BY volume DESC
            `);
        },

        // Get daily P&L
        dailyPnL: async (days = 30) => {
            return window._PP_TradeDB.query(`
                SELECT DATE(date) as day,
                    COUNT(*) as trades,
                    ROUND(SUM(trade_value), 2) as volume,
                    ROUND(SUM(COALESCE(closed_pnl, 0)), 2) as realized_pnl,
                    ROUND(SUM(fee), 2) as fees
                FROM trades
                WHERE date >= datetime('now', '-${days} days')
                GROUP BY day
                ORDER BY day DESC
            `);
        },

        // Get monthly summary
        monthlySummary: async () => {
            return window._PP_TradeDB.query(`
                SELECT strftime('%Y-%m', date) as month,
                    COUNT(*) as trades,
                    ROUND(SUM(trade_value), 2) as volume,
                    ROUND(SUM(COALESCE(closed_pnl, 0)), 2) as realized_pnl,
                    ROUND(SUM(fee), 2) as fees
                FROM trades
                GROUP BY month
                ORDER BY month DESC
            `);
        },

        // Get win rate by market
        winRate: async () => {
            return window._PP_TradeDB.query(`
                SELECT market,
                    COUNT(*) as closing_trades,
                    SUM(CASE WHEN closed_pnl > 0 THEN 1 ELSE 0 END) as wins,
                    SUM(CASE WHEN closed_pnl < 0 THEN 1 ELSE 0 END) as losses,
                    ROUND(100.0 * SUM(CASE WHEN closed_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
                    ROUND(AVG(CASE WHEN closed_pnl > 0 THEN closed_pnl END), 2) as avg_win,
                    ROUND(AVG(CASE WHEN closed_pnl < 0 THEN closed_pnl END), 2) as avg_loss
                FROM trades
                WHERE closed_pnl IS NOT NULL AND closed_pnl != 0
                GROUP BY market
                ORDER BY closing_trades DESC
            `);
        },

        // Sync status
        status: async () => {
            await initSQL();
            if (!_db) return { trades: 0, funding: 0, lastSync: null };
            const trades = _db.exec("SELECT COUNT(*) FROM trades")[0]?.values[0][0] || 0;
            const funding = _db.exec("SELECT COUNT(*) FROM funding")[0]?.values[0][0] || 0;
            const lastSync = await loadMeta("last_sync");
            return { trades, funding, lastSync };
        },

        // Force sync
        sync: () => syncTradeHistory(),

        // Force full re-sync (clears DB)
        fullResync: async () => {
            await initSQL();
            if (_db) {
                _db.run("DELETE FROM trades");
                _db.run("DELETE FROM funding");
                _db.run("DELETE FROM sync_log");
                await persistDB();
            }
            return syncTradeHistory();
        },
    };

    // ---------- Init ----------
    // Auto-sync on page load (with delay to not block rendering)
    setTimeout(async () => {
        await initSQL();
        const lastSync = await loadMeta("last_sync");
        if (!lastSync || Date.now() - lastSync > SYNC_INTERVAL_MS) {
            syncTradeHistory();
        } else {
            console.log("[Perpetualpulse] Trade DB up to date (last sync:", new Date(lastSync).toISOString(), ")");
        }
    }, 5000);
})();
