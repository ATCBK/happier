/**
 * The cooperative preview's navigation reporter. It is the only part of the collector that every
 * in-frame document of a bound relay preview carries: it reports history position and loading to
 * the exact host that embedded it, and obeys back, forward and stop from that host only. It never
 * admits page automation or diagnostics; the full runtime still does that for the document loaded
 * with the pane's own navigation identity.
 */
export const INJECTED_COOPERATIVE_NAVIGATION_RUNTIME = `
  (function (config) {
    var navigationPending = false;
    var collectorQueryNames = ['__happierCollector', '__happierCollectorState'];

    function currentUrl() {
      var url = new URL(window.location.href);
      var kept = url.search.replace(/^\\?/, '').split('&').filter(function (part) {
        return part && collectorQueryNames.indexOf(part.split('=', 1)[0]) === -1;
      }).join('&');
      return url.origin + url.pathname + (kept ? '?' + kept : '') + url.hash;
    }

    function reportNavigationState() {
      if (!window.parent || typeof window.parent.postMessage !== 'function') return;
      var navigation = window.navigation;
      try {
        window.parent.postMessage(JSON.stringify({
          v: 1, kind: 'browser.collector.navigation',
          browserSessionId: config.browserSessionId, viewId: config.viewId,
          navigationGeneration: config.navigationGeneration,
          collectorId: config.collector.collectorId, nonce: config.collector.nonce,
          loading: navigationPending || String(document.readyState) !== 'complete',
          canGoBack: Boolean(navigation && navigation.canGoBack),
          canGoForward: Boolean(navigation && navigation.canGoForward),
          url: currentUrl()
        }), config.webPostMessageTargetOrigin);
      } catch (_error) {
        // Reporting is best-effort metadata; it must never disturb the previewed page.
      }
    }

    function handleNavigationCommand(event) {
      if (event.source !== window.parent || event.origin !== config.webPostMessageTargetOrigin) return;
      var message = event.data;
      if (typeof message === 'string') {
        try { message = JSON.parse(message); } catch (_error) { return; }
      }
      if (!message || message.v !== 1 || message.kind !== 'browser.collector.navigate'
          || message.browserSessionId !== config.browserSessionId || message.viewId !== config.viewId
          || message.navigationGeneration !== config.navigationGeneration
          || message.collectorId !== config.collector.collectorId || message.nonce !== config.collector.nonce) return;
      if (message.command === 'back') window.history.back();
      else if (message.command === 'forward') window.history.forward();
      else if (message.command === 'stop') {
        navigationPending = false;
        window.stop();
        reportNavigationState();
      }
    }

    window.addEventListener('message', handleNavigationCommand);
    window.addEventListener('load', reportNavigationState);
    window.addEventListener('pageshow', reportNavigationState);
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('currententrychange', reportNavigationState);
      window.navigation.addEventListener('navigate', function (event) {
        if (event.destination && event.destination.sameDocument) return;
        navigationPending = true;
        reportNavigationState();
      });
      window.navigation.addEventListener('navigateerror', function () {
        navigationPending = false;
        reportNavigationState();
      });
    }
    reportNavigationState();
  })(config);
`;
