// page-bridge.js — Runs in MAIN world (page context)
// Intercepts auth tokens from Lighter API requests + reads localStorage

(function () {
    "use strict";

    let _capturedAuth = null;
    let _capturedAccountIndex = null;

    // --- Intercept fetch to capture Authorization header ---
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
        try {
            const [url, opts] = args;
            const urlStr = typeof url === "string" ? url : url?.url || "";

            if (urlStr.includes("zklighter.elliot.ai") || urlStr.includes("lighter.xyz")) {
                const headers = opts?.headers || {};
                const auth = headers.Authorization || headers.authorization;
                if (auth && auth.includes(":")) {
                    _capturedAuth = auth;
                    // Extract account index from auth token (format: deadline:accountIndex:keyIndex:signature)
                    const parts = auth.split(":");
                    if (parts.length >= 2) {
                        const idx = parseInt(parts[1]);
                        if (!isNaN(idx) && idx > 0) _capturedAccountIndex = idx;
                    }
                }
                // Also check URL params for account_index
                try {
                    const u = new URL(urlStr);
                    const ai = u.searchParams.get("account_index");
                    if (ai) _capturedAccountIndex = parseInt(ai);
                } catch (e) {}
            }
        } catch (e) {}
        return originalFetch.apply(this, args);
    };

    // --- Message handler for content script requests ---
    window.addEventListener("message", (e) => {
        if (e.source !== window || !e.data?.type) return;

        if (e.data.type === "pp-get-auth") {
            // Also try localStorage as fallback
            const lsToken = localStorage.getItem("auth_token");

            window.postMessage({
                type: "pp-auth-response",
                id: e.data.id,
                token: _capturedAuth || lsToken || null,
                accountIndex: _capturedAccountIndex,
            });
        }
    });

    // --- Expose console API for _PP_TradeDB ---
    // Content script posts results back; we relay to a pending promise
    const _pendingQueries = new Map();
    window.addEventListener("message", (e) => {
        if (e.source !== window) return;
        if (e.data?.type === "pp-tradedb-result" && e.data.id) {
            const resolve = _pendingQueries.get(e.data.id);
            if (resolve) {
                _pendingQueries.delete(e.data.id);
                resolve(e.data.result);
            }
        }
    });

    function callTradeDB(method, args = []) {
        return new Promise((resolve) => {
            const id = "pp-q-" + Math.random().toString(36).slice(2);
            _pendingQueries.set(id, resolve);
            window.postMessage({ type: "pp-tradedb-call", id, method, args });
            setTimeout(() => { _pendingQueries.delete(id); resolve("timeout"); }, 10000);
        });
    }

    window._PP_TradeDB = {
        sync: () => callTradeDB("sync"),
        fullResync: () => callTradeDB("fullResync"),
        status: () => callTradeDB("status"),
        query: (sql) => callTradeDB("query", [sql]),
        pnlByMarket: () => callTradeDB("pnlByMarket"),
        dailyPnL: (days) => callTradeDB("dailyPnL", [days]),
        monthlySummary: () => callTradeDB("monthlySummary"),
        winRate: () => callTradeDB("winRate"),
    };

    // --- Fetch transfer history from MAIN world (has cookies) ---
    window.addEventListener("message", async (e) => {
        if (e.source !== window || e.data?.type !== "pp-fetch-transfers") return;
        const { id, accountIndex } = e.data;
        const BASE = "https://mainnet.zklighter.elliot.ai/api/v1/transfer_history";
        const all = [];
        let cursor = undefined;
        let pages = 0;
        try {
            while (pages < 50) {
                let url = `${BASE}?account_index=${accountIndex}&limit=100`;
                if (cursor) url += `&cursor=${cursor}`;
                const headers = {};
                if (_capturedAuth) {
                    headers.Authorization = _capturedAuth;
                    headers.PreferAuthServer = "true";
                }
                const resp = await fetch(url, { headers });
                if (!resp.ok) {
                    console.warn(`[Perpetualpulse] Transfer API: HTTP ${resp.status}`);
                    break;
                }
                const data = await resp.json();
                if (pages === 0) console.log("[Perpetualpulse] Transfer API keys:", Object.keys(data));
                if (!data.transfers || data.transfers.length === 0) {
                    if (pages === 0) console.log("[Perpetualpulse] No transfers:", JSON.stringify(data).slice(0, 300));
                    break;
                }
                if (pages === 0) console.log("[Perpetualpulse] First transfer:", JSON.stringify(data.transfers[0]));
                all.push(...data.transfers);
                cursor = data.cursor;
                if (!cursor) break;
                pages++;
                await new Promise(r => setTimeout(r, 300));
            }
        } catch (err) {
            console.error("[Perpetualpulse] Transfer fetch error:", err);
        }
        window.postMessage({ type: "pp-fetch-transfers-result", id, transfers: all });
    });

    console.log("[Perpetualpulse] Page bridge active (fetch interceptor + _PP_TradeDB console API)");
})();
