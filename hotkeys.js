// hotkey-tabs.js
// Adds Option/Alt+M, L, B, S hotkeys for tab switching and for toggling buy/sell side selection, with dynamic hotkey labels and fast order workflow

(function waitForTabsAndInit() {
    // Detect platform (Mac vs Windows/Linux)
    const isMac = /Mac/i.test(navigator.platform);

    // Wait for all required UI elements to exist
    const marketBtn = document.querySelector('[data-testid="select-order-type-market"]');
    const limitBtn = document.querySelector('[data-testid="select-order-type-limit"]');
    // For side tabs, look for buttons in the h-8 row (the actual toggle, not the big Place Order)
    const sideRow = document.querySelector('div.relative.flex.h-8');
    const sideButtons = sideRow ? Array.from(sideRow.querySelectorAll('button')) : [];
    const buySideBtn = sideButtons.find(btn => btn.textContent.trim().toLowerCase().includes('buy') || btn.textContent.trim().toLowerCase().includes('long'));
    const sellSideBtn = sideButtons.find(btn => btn.textContent.trim().toLowerCase().includes('sell') || btn.textContent.trim().toLowerCase().includes('short'));

    // Also check for the amount input and place order button
    function getAmountInput() {
        // Use the most specific selector possible, fallback to common pattern
        return document.querySelector('input[data-testid="place-order-size-input"], input[placeholder="0.0"], input[placeholder="0"]');
    }
    function focusAmountInput() {
        const inp = getAmountInput();
        if (inp) {
            inp.focus();
            inp.select && inp.select();
        }
    }
    function getPlaceOrderButton() {
        // The main execution button should have this testid
        return document.querySelector('button[data-testid="place-order-button"]');
    }

    // Attach enter-to-trade shortcut just once per amount input
    function attachEnterForOrder() {
        const inp = getAmountInput();
        if (inp && !inp._perppulse_enter_handler) {
            inp.addEventListener('keydown', function(ev) {
                if (ev.key === 'Enter') {
                    const btn = getPlaceOrderButton();
                    if (btn && !btn.disabled) {
                        btn.click();
                    }
                }
            });
            inp._perppulse_enter_handler = true;
        }
    }

    if (!marketBtn || !limitBtn || !buySideBtn || !sellSideBtn) {
        setTimeout(waitForTabsAndInit, 300);
        return;
    }

    // Add styles for all hotkey badges
    const style = document.createElement('style');
    style.innerHTML = `
    .market-hotkey span, .limit-hotkey span, .buy-hotkey span, .sell-hotkey span {
        margin-left: 0.5em;
        font-size: 0.8em;
        padding: 0.1em 0.4em;
        border-radius: 4px;
        background: rgba(120,120,120,0.08);
        color: inherit !important;
        font-weight: 400;
    }
    `;
    document.head.appendChild(style);

    // Tab switching logic
    function switchToOrderTab(tab) {
        if (tab === 'market') {
            const btn = document.querySelector('[data-testid="select-order-type-market"]');
            if (btn) setTimeout(() => { btn.click(); setTimeout(() => { focusAmountInput(); attachEnterForOrder(); }, 100); }, 0);
        }
        if (tab === 'limit') {
            const btn = document.querySelector('[data-testid="select-order-type-limit"]');
            if (btn) setTimeout(() => { btn.click(); setTimeout(() => { focusAmountInput(); attachEnterForOrder(); }, 100); }, 0);
        }
    }
    // Switch buy/sell SIDE (not order submit!)
    function switchToSide(side) {
        const sideRow = document.querySelector('div.relative.flex.h-8');
        if (!sideRow) return;
        const sideButtons = Array.from(sideRow.querySelectorAll('button'));
        const buySideBtn = sideButtons.find(btn => btn.textContent.trim().toLowerCase().includes('buy') || btn.textContent.trim().toLowerCase().includes('long'));
        const sellSideBtn = sideButtons.find(btn => btn.textContent.trim().toLowerCase().includes('sell') || btn.textContent.trim().toLowerCase().includes('short'));
        if (side === 'buy' && buySideBtn) setTimeout(() => { buySideBtn.click(); setTimeout(() => { focusAmountInput(); attachEnterForOrder(); }, 100); }, 0);
        if (side === 'sell' && sellSideBtn) setTimeout(() => { sellSideBtn.click(); setTimeout(() => { focusAmountInput(); attachEnterForOrder(); }, 100); }, 0);
    }

    // Hotkey label, platform dependent
    const keyBadge = key => isMac ? `⌥+${key}` : `Alt+${key}`;

    // Show/hide hotkey labels
    function showHotkeyLabels(show) {
        // Market Tab
        const marketBtn = document.querySelector('[data-testid="select-order-type-market"]');
        if (marketBtn) {
            let span = marketBtn.querySelector('.market-hotkey');
            if (show) {
                if (!span) {
                    span = document.createElement('span');
                    span.className = 'market-hotkey';
                    span.innerHTML = ` <span>${keyBadge('M')}</span>`;
                    marketBtn.appendChild(span);
                }
            } else if (span) {
                span.remove();
            }
        }
        // Limit Tab
        const limitBtn = document.querySelector('[data-testid="select-order-type-limit"]');
        if (limitBtn) {
            let span = limitBtn.querySelector('.limit-hotkey');
            if (show) {
                if (!span) {
                    span = document.createElement('span');
                    span.className = 'limit-hotkey';
                    span.innerHTML = ` <span>${keyBadge('L')}</span>`;
                    limitBtn.appendChild(span);
                }
            } else if (span) {
                span.remove();
            }
        }
        // Buy SIDE Button
        const sideRow = document.querySelector('div.relative.flex.h-8');
        if (sideRow) {
            const sideButtons = Array.from(sideRow.querySelectorAll('button'));
            const buySideBtn = sideButtons.find(btn => btn.textContent.trim().toLowerCase().includes('buy') || btn.textContent.trim().toLowerCase().includes('long'));
            if (buySideBtn) {
                let span = buySideBtn.querySelector('.buy-hotkey');
                if (show) {
                    if (!span) {
                        span = document.createElement('span');
                        span.className = 'buy-hotkey';
                        span.innerHTML = ` <span>${keyBadge('B')}</span>`;
                        buySideBtn.appendChild(span);
                    }
                } else if (span) {
                    span.remove();
                }
            }
            // Sell SIDE Button
            const sellSideBtn = sideButtons.find(btn => btn.textContent.trim().toLowerCase().includes('sell') || btn.textContent.trim().toLowerCase().includes('short'));
            if (sellSideBtn) {
                let span = sellSideBtn.querySelector('.sell-hotkey');
                if (show) {
                    if (!span) {
                        span = document.createElement('span');
                        span.className = 'sell-hotkey';
                        span.innerHTML = ` <span>${keyBadge('S')}</span>`;
                        sellSideBtn.appendChild(span);
                    }
                } else if (span) {
                    span.remove();
                }
            }
        }
    }

    // Keyboard listeners
    document.addEventListener('keydown', function(e) {
        if (e.altKey && !e.repeat) {
            showHotkeyLabels(true);
            switch (e.code) {
                case 'KeyM':
                    switchToOrderTab('market');
                    e.preventDefault();
                    break;
                case 'KeyL':
                    switchToOrderTab('limit');
                    e.preventDefault();
                    break;
                case 'KeyB':
                    switchToSide('buy');
                    e.preventDefault();
                    break;
                case 'KeyS':
                    switchToSide('sell');
                    e.preventDefault();
                    break;
            }
        }
    });
    document.addEventListener('keyup', function(e) {
        if (!e.altKey) {
            showHotkeyLabels(false);
        }
    });
    window.addEventListener('blur', () => {
        showHotkeyLabels(false);
    });

    // Attach once at startup
    setTimeout(attachEnterForOrder, 500);

})();
