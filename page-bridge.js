// page-bridge.js — Runs in MAIN world (page context) to access localStorage
// Communicates with content scripts via window.postMessage

(function () {
    "use strict";

    window.addEventListener("message", (e) => {
        if (e.source !== window || !e.data?.type) return;

        if (e.data.type === "pp-get-auth") {
            const token = localStorage.getItem("auth_token");
            const accountIndex = (() => {
                // Try to get account index from Zustand store or other sources
                try {
                    // The Lighter app stores state in various places
                    // Check for __zustand stores
                    for (const key of Object.keys(localStorage)) {
                        if (key.includes("account") || key.includes("zustand")) {
                            try {
                                const val = JSON.parse(localStorage.getItem(key));
                                if (val?.state?.accountIndex) return val.state.accountIndex;
                                if (val?.accountIndex) return val.accountIndex;
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
                return null;
            })();

            window.postMessage({
                type: "pp-auth-response",
                id: e.data.id,
                token,
                accountIndex,
            });
        }
    });

    console.log("[Perpetualpulse] Page bridge active");
})();
