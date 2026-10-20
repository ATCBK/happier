import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createDesktopDownloadFileSink, openInDefaultApp } from '../sources/sync/runtime/files/openInDefaultApp.ts';
import { resolveWorkspaceFileDownloadSource } from '../sources/hooks/workspaces/transfers/workspaceFileDownloadSource.ts';

test('desktop default-handler permission is confined to the download temp area', () => {
    const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
    assert.deepEqual(capability.permissions.filter(permission => typeof permission === 'object' && permission.identifier === 'opener:allow-open-path'), [
        { identifier: 'opener:allow-open-path', allow: [{ path: '$TEMP/happier-downloads/**' }] },
    ]);
    assert.equal(capability.permissions.some(permission => permission === 'opener:default' || permission === 'opener:allow-open-path'), false);
});

test('held complete bytes export without a Machine, while ZIP creation still requires the workspace', () => {
    const content = { bytes: new Uint8Array([0, 255, 42]), fileName: 'report.txt', mimeType: 'text/plain' };
    assert.deepEqual(resolveWorkspaceFileDownloadSource({ workspaceScope: null, asZip: false, cachedContent: content }), { kind: 'held', content });
    assert.deepEqual(resolveWorkspaceFileDownloadSource({ workspaceScope: null, asZip: true, cachedContent: content }), { kind: 'unavailable' });
    const scope = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };
    assert.deepEqual(resolveWorkspaceFileDownloadSource({ workspaceScope: scope, asZip: true, cachedContent: content }), { kind: 'workspace', scope });
});

test('desktop sink streams exact bytes, closes once, opens its owned path and cleans up exactly once', async () => {
    const path = '/tmp/happier-downloads/file-123/report.pdf';
    const files = new Map();
    const calls = [];
    const invoke = async (command, args) => {
        calls.push({ command, args });
        if (command === 'desktop_download_cache_create') { files.set(path, []); return path; }
        if (command === 'desktop_download_cache_write') files.get(args.path).push(...args.bytes);
        if (command === 'desktop_download_cache_remove') files.delete(args.path);
    };
    const sink = await createDesktopDownloadFileSink({ fileName: 'report.pdf', invoke });
    await sink.writeBytes(new Uint8Array([0, 255]));
    await sink.writeBytes(new Uint8Array([42]));
    await sink.close();
    await sink.close();
    await assert.rejects(sink.writeBytes(new Uint8Array([99])));
    assert.deepEqual(files.get(path), [0, 255, 42]);
    await openInDefaultApp({ path: sink.fileUri, invoke });
    assert.deepEqual(calls.filter(call => call.command === 'plugin:opener|open_path'), [{ command: 'plugin:opener|open_path', args: { path } }]);
    assert.equal(calls.filter(call => call.command === 'desktop_download_cache_close').length, 1);
    await sink.cleanup();
    await sink.cleanup();
    assert.equal(files.size, 0);
    assert.equal(calls.filter(call => call.command === 'desktop_download_cache_remove').length, 1);
});

test('desktop cleanup retries a failed exact removal and never claims success for it', async () => {
    let removals = 0;
    const sink = await createDesktopDownloadFileSink({ fileName: 'report.pdf', invoke: async (command) => {
        if (command === 'desktop_download_cache_create') return '/tmp/happier-downloads/file-456/report.pdf';
        if (command === 'desktop_download_cache_remove' && ++removals === 1) throw new Error('File busy');
    } });
    await assert.rejects(sink.cleanup(), /File busy/);
    await sink.cleanup();
    assert.equal(removals, 2);
});
