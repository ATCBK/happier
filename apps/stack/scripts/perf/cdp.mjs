import { createCdpConnection } from '../../../ui/scripts/perf/agentBrowserUiPerfAudit.mjs';

// Extend the existing UI audit transport with explicit Stack-owned page
// selection. Disconnecting this observer never closes that browser.
export async function connectPage(endpoint, pageId, signal) {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('CDP must use the Stack loopback forward');
  const response = await fetch(new URL('/json/list', endpoint), { signal });
  if (!response.ok) throw new Error(`CDP discovery HTTP ${response.status}`);
  const pages = (await response.json()).filter(target => target.type === 'page');
  const page = pageId ? pages.find(target => target.id === pageId) : pages.length === 1 ? pages[0] : null;
  if (!page) throw new Error('Select exactly one owned page with --page-id');
  const socketUrl = new URL(page.webSocketDebuggerUrl);
  socketUrl.host = url.host;
  return { ...await createCdpConnection(socketUrl.href), pageId: page.id };
}
