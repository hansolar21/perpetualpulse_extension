// background.js — Service worker for Perpetualpulse

// --- Fetch transfer history (background has no CORS restrictions) ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "pp-fetch-transfers") return false;
    const { accountIndex, authToken } = msg;

    (async () => {
        const BASE = "https://mainnet.zklighter.elliot.ai/api/v1/transfer_history";
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
