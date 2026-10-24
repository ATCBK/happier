// A change notification only. The host reads URL/history from the native WebView.
(() => {
    let lastUrl = location.href;
    const changed = (force = false) => {
        const current = location.href;
        if (!force && current === lastUrl) return;
        lastUrl = current;
        window.ipc.postMessage('happier:history-changed');
    };
    for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function (...args) {
            const result = original.apply(this, args);
            changed(name === 'pushState');
            return result;
        };
    }
    window.addEventListener('popstate', () => changed(true));
    window.addEventListener('hashchange', () => changed());
    window.navigation?.addEventListener('currententrychange', () => changed(true));
})();
