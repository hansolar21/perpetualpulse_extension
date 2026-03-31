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

    console.log("[Perpetualpulse] Page bridge active (fetch interceptor)");
})();
