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
                // Sync to chrome.storage.local for dashboard access
                try {
                    const b64 = uint8ToBase64(new Uint8Array(saved));
                    chrome.storage.local.set({ pp_trade_db_b64: b64 });
                } catch (e) {}
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

            CREATE TABLE IF NOT EXISTS transfers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                type TEXT NOT NULL,
                amount REAL NOT NULL,
                UNIQUE(date, type, amount)
            );
            CREATE INDEX IF NOT EXISTS idx_transfers_date ON transfers(date);

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

    function uint8ToBase64(u8) {
        let binary = "";
        const chunk = 8192;
        for (let i = 0; i < u8.length; i += chunk) {
            binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    async function persistDB() {
        if (!_db) return;
        const data = _db.export();
        await saveDBToIDB(data.buffer);
        // Also save to chrome.storage.local so dashboard page can access it
        try {
            const b64 = uint8ToBase64(data);
            chrome.storage.local.set({ pp_trade_db_b64: b64 }, () => {
                if (chrome.runtime.lastError) {
                    console.warn("[Perpetualpulse] storage.local save error:", chrome.runtime.lastError);
                }
            });
        } catch (e) {
            console.warn("[Perpetualpulse] Failed to save DB to chrome.storage:", e);
        }
    }

    // ---------- Data Fetch ----------
    async function fetchExportCSV(authToken, accountIndex, type, startMs, endMs, { maxRetries = 4 } = {}) {
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

        // Fetch from S3 — file is generated async, retry with backoff on 404
        let csvResp = null;
        const S3_RETRIES = maxRetries;
        const S3_DELAYS = [0, 2000, 5000, 10000]; // immediate, 2s, 5s, 10s
        for (let attempt = 0; attempt < S3_RETRIES; attempt++) {
            if (attempt > 0) {
                console.log(`[Perpetualpulse] S3 retry ${attempt}/${S3_RETRIES - 1} after ${S3_DELAYS[attempt]}ms...`);
                await new Promise((r) => setTimeout(r, S3_DELAYS[attempt]));
            }
            csvResp = await fetch(data.data_url);
            if (csvResp.ok) break;
            if (csvResp.status !== 404) {
                console.warn(`[Perpetualpulse] S3 fetch failed: ${csvResp.status}`);
                return null;
            }
        }
        if (!csvResp || !csvResp.ok) {
            console.log("[Perpetualpulse] S3 file not available after retries (404) — skipping range");
            return null;
        }
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
        // CSV: Market,Side,Date,Position Size,Payment,Rate
        const parts = line.split(",");
        if (parts.length < 6) return null;
        return {
            market: parts[0],
            date: parts[2],
            payment: parseFloat(parts[4]) || 0,
            annual_rate: parseFloat(parts[5]) || 0,
            position_size: parseFloat(parts[3]) || 0,
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

    function parseTransferRow(line) {
        const parts = line.split(",");
        if (parts.length < 3) return null;
        return { date: parts[0], type: parts[1], amount: parseFloat(parts[2]) || 0 };
    }

    function insertTransfers(rows) {
        if (!_db || rows.length === 0) return 0;
        const stmt = _db.prepare(
            `INSERT OR IGNORE INTO transfers (date, type, amount) VALUES (?, ?, ?)`
        );
        let added = 0;
        for (const line of rows) {
            const r = parseTransferRow(line);
            if (!r || !r.date || r.amount === 0) continue;
            stmt.run([r.date, r.type, r.amount]);
            added += _db.getRowsModified();
        }
        stmt.free();
        return added;
    }

    function insertTransferObjects(transfers) {
        if (!_db || !transfers.length) return 0;
        const stmt = _db.prepare(
            `INSERT OR IGNORE INTO transfers (date, type, amount) VALUES (?, ?, ?)`
        );
        let added = 0;
        for (const t of transfers) {
            if (!t.date || !t.amount) continue;
            stmt.run([t.date, t.type, t.amount]);
            added += _db.getRowsModified();
        }
        stmt.free();
        return added;
    }

    // Fetch transfer history via page bridge (MAIN world has cookies for auth)
    async function fetchTransferHistory(authToken, accountIndex) {
        return new Promise((resolve) => {
            const id = "pp-tf-" + Math.random().toString(36).slice(2);
            const handler = (e) => {
                if (e.source !== window || e.data?.type !== "pp-fetch-transfers-result" || e.data.id !== id) return;
                window.removeEventListener("message", handler);

                const raw = e.data.transfers || [];
                console.log(`[Perpetualpulse] Got ${raw.length} raw transfers from page bridge`);

                const transfers = [];
                for (const t of raw) {
                    let type = t.type || "Unknown";
                    let amount = 0;
                    const ts = t.timestamp || t.created_at || t.date || "";
                    const date = ts ? new Date(typeof ts === "number" ? ts * 1000 : ts).toISOString() : "";

                    if (t.l1_tx_hash || type.toLowerCase().includes("deposit")) {
                        type = "Deposit";
                        amount = parseFloat(t.amount || t.collateral || 0);
                    } else if (type.toLowerCase().includes("withdraw")) {
                        type = "Withdrawal";
                        amount = -Math.abs(parseFloat(t.amount || t.collateral || 0));
                    } else if (type.toLowerCase().includes("inflow") || type.toLowerCase().includes("transfer_in")) {
                        type = "TransferIn";
                        amount = parseFloat(t.amount || t.collateral || 0);
                    } else if (type.toLowerCase().includes("outflow") || type.toLowerCase().includes("transfer_out")) {
                        type = "TransferOut";
                        amount = -Math.abs(parseFloat(t.amount || t.collateral || 0));
                    } else {
                        amount = parseFloat(t.amount || t.collateral || t.value || 0);
                    }

                    if (date && amount !== 0) transfers.push({ date, type, amount });
                }
                resolve(transfers);
            };
            window.addEventListener("message", handler);
            window.postMessage({ type: "pp-fetch-transfers", id, accountIndex });
            // Timeout
            setTimeout(() => { window.removeEventListener("message", handler); resolve([]); }, 60000);
        });
    }

    // ---------- FIFO PnL Reconstruction ----------
    function reconstructPnL() {
        if (!_db) return 0;

        // Check if there are any NULL pnl trades to reconstruct
        const nullCount = _db.exec("SELECT COUNT(*) FROM trades WHERE closed_pnl IS NULL")[0].values[0][0];
        if (nullCount === 0) return 0;

        console.log(`[Perpetualpulse] Reconstructing PnL for ${nullCount} trades via FIFO...`);

        // Load all trades ordered by date
        const rows = _db.exec(`
            SELECT rowid, market, side, date, size, price, closed_pnl
            FROM trades ORDER BY date ASC
        `);
        if (!rows.length) return 0;

        const trades = rows[0].values;
        const positions = {}; // market -> { direction, fills: [{size, price}] }

        const getPos = (market) => {
            if (!positions[market]) positions[market] = { direction: null, fills: [] };
            return positions[market];
        };

        const closeFIFO = (pos, size, exitPrice) => {
            let remaining = size;
            let realized = 0;
            while (remaining > 1e-12 && pos.fills.length > 0) {
                const oldest = pos.fills[0];
                const qty = Math.min(remaining, oldest.size);
                if (pos.direction === "long") {
                    realized += qty * (exitPrice - oldest.price);
                } else {
                    realized += qty * (oldest.price - exitPrice);
                }
                oldest.size -= qty;
                remaining -= qty;
                if (oldest.size <= 1e-12) pos.fills.shift();
            }
            if (pos.fills.length === 0) pos.direction = null;
            return realized;
        };

        // Classify side
        const classifyOld = (side, pos) => {
            if (side === "Long") return (!pos.direction || pos.direction === "long") ? "open_long" : "close_short";
            if (side === "Short") return (!pos.direction || pos.direction === "short") ? "open_short" : "close_long";
            return null;
        };

        const classifyNew = (side) => {
            const map = {
                "Open Long": "open_long", "Open Short": "open_short",
                "Close Long": "close_long", "Close Short": "close_short",
                "Long > Short": "flip_to_short", "Short > Long": "flip_to_long",
                "Buy": "open_long", "Sell": "close_long",
            };
            return map[side] || null;
        };

        const updates = []; // [rowid, pnl]

        for (const [rowid, market, side, date, size, price, closedPnl] of trades) {
            const pos = getPos(market);
            const isOldFormat = side === "Long" || side === "Short";
            const action = isOldFormat ? classifyOld(side, pos) : classifyNew(side);

            let realized = 0;

            if (action === "open_long" || action === "open_short") {
                const dir = action === "open_long" ? "long" : "short";
                if (!pos.direction) pos.direction = dir;
                pos.fills.push({ size, price });
            } else if (action === "close_long" && pos.direction === "long") {
                realized = closeFIFO(pos, size, price);
            } else if (action === "close_short" && pos.direction === "short") {
                realized = closeFIFO(pos, size, price);
            } else if (action === "flip_to_short" && pos.direction === "long") {
                const closeSize = Math.min(size, pos.fills.reduce((s, f) => s + f.size, 0));
                realized = closeFIFO(pos, closeSize, price);
                const rem = size - closeSize;
                if (rem > 1e-12) { pos.direction = "short"; pos.fills.push({ size: rem, price }); }
                else if (!pos.fills.length) pos.direction = "short";
            } else if (action === "flip_to_long" && pos.direction === "short") {
                const closeSize = Math.min(size, pos.fills.reduce((s, f) => s + f.size, 0));
                realized = closeFIFO(pos, closeSize, price);
                const rem = size - closeSize;
                if (rem > 1e-12) { pos.direction = "long"; pos.fills.push({ size: rem, price }); }
                else if (!pos.fills.length) pos.direction = "long";
            }

            // Only update rows that have NULL pnl and we computed something
            if (closedPnl === null && Math.abs(realized) > 0.001) {
                updates.push([rowid, Math.round(realized * 1e6) / 1e6]);
            }
        }

        // Batch update
        if (updates.length > 0) {
            const stmt = _db.prepare("UPDATE trades SET closed_pnl = ? WHERE rowid = ?");
            for (const [rowid, pnl] of updates) {
                stmt.run([pnl, rowid]);
            }
            stmt.free();
            console.log(`[Perpetualpulse] Reconstructed PnL for ${updates.length} trades`);
        }

        return updates.length;
    }

    // ---------- Sync Logic ----------
    function getQuarterRanges(startDate, endDate) {
        // Lighter export API requires KST calendar-quarter-aligned boundaries
        // Quarters: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec (in KST)
        const KST_OFFSET_MS = 9 * 3600000;
        const ranges = [];

        // Convert startDate to KST to find which calendar quarter it falls in
        const startKST = new Date(startDate.getTime() + KST_OFFSET_MS);
        let year = startKST.getUTCFullYear();
        // Snap to calendar quarter start: Jan(0), Apr(3), Jul(6), Oct(9)
        let month = Math.floor(startKST.getUTCMonth() / 3) * 3; // 0-based

        while (true) {
            // Quarter start: 1st of quarter month at 00:00:00.000 KST (= prev day 15:00 UTC)
            const qStartUTC = new Date(Date.UTC(year, month, 1) - KST_OFFSET_MS);
            // Quarter end month (0-based): month+2
            const endM = month + 2;
            // Last day of end month at 23:59:59.999 KST
            // = first day of (endM+1) at 00:00 KST minus 1ms
            const qEndUTC = new Date(Date.UTC(year, endM + 1, 1) - KST_OFFSET_MS - 1);

            if (qStartUTC.getTime() > endDate.getTime()) break;

            // Use actual startDate for first range (don't go before account creation)
            const effectiveStart = Math.max(qStartUTC.getTime(), startDate.getTime());
            ranges.push([effectiveStart, Math.min(qEndUTC.getTime(), endDate.getTime())]);

            // Advance to next quarter
            month += 3;
            if (month >= 12) { month -= 12; year++; }
        }
        return ranges;
    }

    function getMonthlyRanges(startDate, endDate) {
        // Monthly KST-aligned ranges for funding (which has stricter size limits)
        const KST_OFFSET_MS = 9 * 3600000;
        const ranges = [];
        const startKST = new Date(startDate.getTime() + KST_OFFSET_MS);
        let year = startKST.getUTCFullYear();
        let month = startKST.getUTCMonth();

        while (true) {
            const mStartUTC = new Date(Date.UTC(year, month, 1) - KST_OFFSET_MS);
            const mEndUTC = new Date(Date.UTC(year, month + 1, 1) - KST_OFFSET_MS - 1);

            if (mStartUTC.getTime() > endDate.getTime()) break;
            const effectiveStart = Math.max(mStartUTC.getTime(), startDate.getTime());
            ranges.push([effectiveStart, Math.min(mEndUTC.getTime(), endDate.getTime())]);

            month++;
            if (month >= 12) { month = 0; year++; }
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
                // First sync — start from account creation (Jan 17, 2025 KST)
                startMs = await loadMeta("first_trade_ms") || new Date("2025-01-16T15:00:00Z").getTime(); // Jan 17 00:00 KST
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

            // Sync funding using monthly ranges (quarterly exceeds max allowed limit)
            const fundingMonths = getMonthlyRanges(new Date(startMs), new Date(endMs));
            for (const [mStart, mEnd] of fundingMonths) {
                try {
                    const data = await fetchExportCSV(authToken, accountIndex, "funding", mStart, mEnd, { maxRetries: 1 });
                    if (data) {
                        const added = insertFunding(data.rows);
                        if (added > 0) console.log(`[Perpetualpulse] +${added} funding entries`);
                    }
                } catch (e) {
                    // Funding export may fail for some ranges
                }
                await new Promise((r) => setTimeout(r, 300));
            }

            // Sync transfers via REST API (paginated)
            try {
                const transfers = await fetchTransferHistory(authToken, accountIndex);
                if (transfers.length > 0) {
                    const added = insertTransferObjects(transfers);
                    console.log(`[Perpetualpulse] +${added} new transfers (${transfers.length} total fetched)`);
                }
            } catch (e) {
                console.warn("[Perpetualpulse] Transfer sync failed:", e.message);
            }

            // Reconstruct PnL for trades missing closed_pnl (pre-May 2025)
            if (totalAdded > 0 || !lastDate) {
                reconstructPnL();
            }

            // Persist and log
            await persistDB();
            _lastSyncTime = Date.now();
            await saveMeta("last_sync", _lastSyncTime);

            const totalTrades = _db.exec("SELECT COUNT(*) FROM trades")[0].values[0][0];
            const totalFunding = _db.exec("SELECT COUNT(*) FROM funding")[0].values[0][0];
            const dateRange = _db.exec("SELECT MIN(date), MAX(date), COUNT(DISTINCT DATE(date)) FROM trades");
            const [minDate, maxDate, uniqueDays] = dateRange.length > 0 ? dateRange[0].values[0] : [null, null, 0];
            console.log(`[Perpetualpulse] Sync complete: ${totalTrades} trades, ${totalFunding} funding entries (+${totalAdded} new)`);
            if (minDate) {
                console.log(`[Perpetualpulse] Dataset: ${uniqueDays} days | ${minDate.slice(0, 10)} → ${maxDate.slice(0, 10)} | ${totalTrades} rows`);
            }

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

    // ---------- Message bridge for MAIN world console API ----------
    // Content scripts and MAIN world share postMessage but NOT window properties.
    // page-bridge.js (MAIN) exposes window._PP_TradeDB that proxies calls here.
    const _tradeDBApi = window._PP_TradeDB; // ref in this isolated world
    window.addEventListener("message", async (e) => {
        if (e.source !== window || e.data?.type !== "pp-tradedb-call") return;
        const { id, method, args = [] } = e.data;
        if (!_tradeDBApi || typeof _tradeDBApi[method] !== "function") {
            window.postMessage({ type: "pp-tradedb-result", id, result: `unknown method: ${method}` });
            return;
        }
        try {
            const result = await _tradeDBApi[method](...args);
            window.postMessage({ type: "pp-tradedb-result", id, result });
        } catch (err) {
            window.postMessage({ type: "pp-tradedb-result", id, result: `error: ${err.message}` });
        }
    });

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
