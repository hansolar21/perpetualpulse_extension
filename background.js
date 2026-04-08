// background.js — Service worker for Perpetualpulse

// --- Fetch transfer history (background has no CORS restrictions) ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "pp-fetch-transfers") return false;
    const { accountIndex, authToken } = msg;

    (async () => {
        const BASE = "https://mainnet.zklighter.elliot.ai/api/v1/transfer/history";
        const all = [];
        let cursor = undefined;
        let pages = 0;

        // Load stored auth token from settings as extra fallback
        const stored = await new Promise(r => chrome.storage.local.get(["pp_settings"], d => r((d.pp_settings || {}).auth_token || null)));

        // Try auth strategies: provided token, stored token, no auth
        const tokens = [authToken, stored].filter(Boolean);
        const authHeaders = [
            ...tokens.map(t => ({ Authorization: t, PreferAuthServer: "true" })),
            ...tokens.map(t => ({ Authorization: t })),
            {}, // no auth
        ].filter((h, i, arr) => i === arr.findIndex(x => JSON.stringify(x) === JSON.stringify(h)));

        try {
            while (pages < 50) {
                let url = `${BASE}?account_index=${accountIndex}&limit=100`;
                if (cursor) url += `&cursor=${cursor}`;

                let resp = null;
                for (const headers of authHeaders) {
                    resp = await fetch(url, { headers });
                    console.log(`[PP BG] Transfer API (${Object.keys(headers).join(",") || "no-auth"}): ${resp.status}`);
                    if (resp.ok) break;
                }

                if (!resp || !resp.ok) {
                    console.warn(`[PP BG] All auth strategies failed: ${resp?.status}`);
                    break;
                }

                const data = await resp.json();
                if (pages === 0) console.log("[PP BG] Transfer keys:", Object.keys(data));
                if (!data.transfers || data.transfers.length === 0) {
                    if (pages === 0) console.log("[PP BG] Empty response:", JSON.stringify(data).slice(0, 300));
                    break;
                }
                if (pages === 0) console.log("[PP BG] First transfer:", JSON.stringify(data.transfers[0]).slice(0, 300));
                all.push(...data.transfers);
                cursor = data.cursor;
                if (!cursor) break;
                pages++;
                await new Promise(r => setTimeout(r, 300));
            }
        } catch (err) {
            console.error("[PP BG] Transfer fetch error:", err);
        }
        console.log(`[PP BG] Fetched ${all.length} transfers`);
        sendResponse({ transfers: all });
    })();
    return true; // keep channel open for async response
});

// --- Sync deposits/withdrawals from correct on-chain endpoints ---
const L1_ADDRESS = "0x9b8D146AB4b61C281B993E3F85066249A6e9b0Db";
const ACCOUNT_INDEX = 24;
const BASE_URL = "https://mainnet.zklighter.elliot.ai/api/v1";

async function fetchAllPages(url, token, itemKey) {
    const all = [];
    let cursor = null;
    while (true) {
        const fullUrl = cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url;
        const resp = await fetch(fullUrl, { headers: { authorization: token, PreferAuthServer: "true" } });
        if (!resp.ok) return { error: resp.status, items: all };
        const data = await resp.json();
        // Debug: log keys on first page
        if (!cursor) console.log(`[PP BG] ${url.split("?")[0].split("/").pop()} keys:`, Object.keys(data), "first item:", JSON.stringify((data[itemKey]||[])[0] || data).slice(0,200));
        const items = data[itemKey] || data.items || data.data || [];
        if (!items.length) break;
        all.push(...items);
        cursor = data.cursor || data.next_cursor || data.nextCursor || null;
        if (!cursor) break;
        await new Promise(r => setTimeout(r, 200));
    }
    return { items: all };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "pp-sync-deposits") return false;

    (async () => {
        try {
            const settings = await new Promise(r =>
                chrome.storage.local.get(["pp_settings"], d => r(d.pp_settings || {}))
            );
            const token = settings.auth_token || null;
            if (!token) {
                sendResponse({ ok: false, error: "No read-only API token saved. Add it in ⚙ Settings." });
                return;
            }

            // Fetch deposits (requires l1_address) and withdrawals in parallel
            const [depResult, wdResult] = await Promise.all([
                fetchAllPages(`${BASE_URL}/deposit/history?account_index=${ACCOUNT_INDEX}&l1_address=${L1_ADDRESS}`, token, "deposits"),
                fetchAllPages(`${BASE_URL}/withdraw/history?account_index=${ACCOUNT_INDEX}`, token, "withdrawals"),
            ]);

            if (depResult.error && wdResult.error) {
                sendResponse({ ok: false, error: `HTTP ${depResult.error} — token may be expired or invalid` });
                return;
            }

            sendResponse({
                ok: true,
                deposits: depResult.items || [],
                withdrawals: wdResult.items || [],
            });
        } catch (e) {
            sendResponse({ ok: false, error: e.message });
        }
    })();
    return true;
});

chrome.action.onClicked.addListener(() => {
    const url = chrome.runtime.getURL("dashboard.html");
    // Reuse existing dashboard tab if open
    chrome.tabs.query({ url }, (tabs) => {
        if (tabs.length > 0) {
            chrome.tabs.update(tabs[0].id, { active: true });
            chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
            chrome.tabs.create({ url });
        }
    });
});
