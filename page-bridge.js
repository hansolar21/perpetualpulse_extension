// page-bridge.js — Runs in MAIN world (page context)
// Holds Lighter auth tokens and makes authenticated API calls on behalf of the
// content scripts. window.postMessage is visible to every script on the page,
// so tokens must never be included in a message: only API results leave here.

(function () {
    "use strict";

    // A token from one Lighter site must only ever go to that site's backend.
    const API_BASE = location.hostname === "robinhoodchain.lighter.xyz"
        ? "https://api.rh.lighter.xyz/api/v1"
        : "https://mainnet.zklighter.elliot.ai/api/v1";
    const EXPORT_TYPES = new Set(["trade", "funding"]);
    const MAX_TRANSFER_PAGES = 50;

    let _capturedAuth = null;
    let _capturedAccountIndex = null;

    // Lighter passes a Headers instance; fetch also accepts plain objects and pair arrays
    function readAuthHeader(headers) {
        if (!headers) return null;
        if (headers instanceof Headers) return headers.get("authorization");
        if (Array.isArray(headers)) {
            return headers.find(([name]) => String(name).toLowerCase() === "authorization")?.[1] || null;
        }
        return headers.Authorization || headers.authorization || null;
    }

    // --- Intercept fetch to capture Authorization header ---
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
        try {
            const [url, opts] = args;
            const urlStr = typeof url === "string" ? url : url?.url || "";

            if (urlStr.includes("zklighter.elliot.ai") || urlStr.includes("lighter.xyz")) {
                const auth = readAuthHeader(opts?.headers ?? (url instanceof Request ? url.headers : null));
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

    // --- Token helpers (never post these values) ---
    function currentToken() {
        return _capturedAuth || localStorage.getItem("auth_token") || null;
    }

    function tokenAccountIndex(token) {
        const idx = parseInt((token || "").split(":")[1]);
        return idx > 0 ? idx : null;
    }

    function detectedAccountIndex() {
        return _capturedAccountIndex || tokenAccountIndex(currentToken());
    }

    // Only the account this browser session is signed in to can be queried.
    function isOwnAccount(accountIndex) {
        return Number.isInteger(accountIndex) && accountIndex > 0 &&
            (accountIndex === _capturedAccountIndex || accountIndex === tokenAccountIndex(currentToken()));
    }

    async function freshToken(accountIndex) {
        try {
            // 1. Read-only token in localStorage (set via Lighter Settings → API)
            const stored = localStorage.getItem("auth_token");
            if (stored) return stored;
            // 2. Generate via WASM (same function Lighter uses internally)
            if (window._createAuthToken) {
                const factory = await window._createAuthToken(accountIndex, "desktop");
                const result = await factory();
                if (result && !result.error && result.token) return result.token;
            }
        } catch (err) {
            console.warn("[Perpetualpulse] Auth token generation failed");
        }
        // 3. Fall back to captured token from fetch interceptor
        return _capturedAuth;
    }

    // --- API calls requested by the content scripts ---
    async function requestExport({ accountIndex, exportType, startMs, endMs }) {
        if (!isOwnAccount(accountIndex) || !EXPORT_TYPES.has(exportType) ||
            !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
            throw new Error("invalid export request");
        }
        const token = currentToken();
        if (!token) throw new Error("no auth token");

        let params = `account_index=${accountIndex}&type=${exportType}&start_timestamp=${startMs}&end_timestamp=${endMs}`;
        if (exportType === "trade") params += "&side=all&role=all&trade_type=all";
        const resp = await originalFetch(`${API_BASE}/export?${params}`, {
            headers: { Authorization: token, PreferAuthServer: "true" },
        });
        const data = await resp.json();
        return { code: data.code, dataUrl: data.data_url || null, message: data.message || null };
    }

    async function requestTransfers({ accountIndex }) {
        if (!isOwnAccount(accountIndex)) throw new Error("invalid transfer request");

        const token = await freshToken(accountIndex);
        const strategies = token
            ? [{ Authorization: token, PreferAuthServer: "true" }, { Authorization: token }, {}]
            : [{}];
        const transfers = [];
        let cursor;
        for (let page = 0; page < MAX_TRANSFER_PAGES; page++) {
            let url = `${API_BASE}/transfer/history?account_index=${accountIndex}&limit=100`;
            if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

            let resp = null;
            for (const headers of strategies) {
                resp = await originalFetch(url, { headers });
                if (resp.ok) break;
            }
            if (!resp.ok) {
                // Nothing fetched yet means this route failed; let the caller try another.
                if (page === 0) throw new Error(`HTTP ${resp.status}`);
                break;
            }
            const data = await resp.json();
            if (!data.transfers || data.transfers.length === 0) break;
            transfers.push(...data.transfers);
            cursor = data.cursor;
            if (!cursor) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        return { transfers };
    }

    // --- Message handler for content script requests ---
    const API_HANDLERS = { export: requestExport, transfers: requestTransfers };

    window.addEventListener("message", async (e) => {
        if (e.source !== window || !e.data?.type) return;

        if (e.data.type === "pp-get-auth") {
            window.postMessage({
                type: "pp-auth-response",
                id: e.data.id,
                hasToken: !!currentToken(),
                accountIndex: detectedAccountIndex(),
            });
            return;
        }

        if (e.data.type === "pp-api-request") {
            const { id, api, request } = e.data;
            const handler = Object.hasOwn(API_HANDLERS, api) ? API_HANDLERS[api] : null;
            try {
                if (!handler) throw new Error("unknown api");
                const result = await handler(request || {});
                window.postMessage({ type: "pp-api-response", id, ok: true, result });
            } catch (err) {
                window.postMessage({ type: "pp-api-response", id, ok: false, error: err.message });
            }
        }
    });

    console.log("[Perpetualpulse] Page bridge active");
})();
