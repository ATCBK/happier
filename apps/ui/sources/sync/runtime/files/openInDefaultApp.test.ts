import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createDesktopDownloadFileSink, openInDefaultApp, type DesktopFileInvoke } from './openInDefaultApp';

describe('desktop download cache handoff', () => {
    it('confines the default-handler permission to the app download temp area', () => {
        const capability: { permissions: Array<string | { identifier: string; allow?: unknown }> } = JSON.parse(
            readFileSync(new URL('../../../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
        expect(capability.permissions.filter(permission => typeof permission === 'object'
            && permission.identifier === 'opener:allow-open-path')).toEqual([
            { identifier: 'opener:allow-open-path', allow: [{ path: '$TEMP/happier-downloads/**' }] },
        ]);
        expect(capability.permissions).not.toContain('opener:default');
        expect(capability.permissions).not.toContain('opener:allow-open-path');
    });

    it('streams exact bytes, closes once and opens only its owned path before exact cleanup', async () => {
        const path = '/tmp/happier-downloads/file-123/report.pdf';
        const files = new Map<string, unknown[]>();
        const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
        // OS IPC is the only substituted boundary; the sink and opener stay real.
        const invoke: DesktopFileInvoke = async (command, args) => {
            calls.push({ command, args });
            if (command === 'desktop_download_cache_create') { files.set(path, []); return path; }
            if (command === 'desktop_download_cache_write') {
                if (args?.path !== path || !Array.isArray(args.bytes)) throw new Error('Invalid native write');
                files.get(path)!.push(...args.bytes);
            }
            if (command === 'desktop_download_cache_remove') files.delete(String(args?.path));
        };
        const sink = await createDesktopDownloadFileSink({ fileName: 'report.pdf', invoke });
        await sink.writeBytes(new Uint8Array([0, 255]));
        await sink.writeBytes(new Uint8Array([42]));
        await sink.close();
        await sink.close();
        await expect(sink.writeBytes(new Uint8Array([99]))).rejects.toThrow();
        expect(files.get(path)).toEqual([0, 255, 42]);
        await openInDefaultApp({ path: sink.fileUri, invoke });
        expect(calls.filter(call => call.command === 'plugin:opener|open_path')).toEqual([
            { command: 'plugin:opener|open_path', args: { path } },
        ]);
        expect(calls.filter(call => call.command === 'desktop_download_cache_close')).toHaveLength(1);
        await sink.cleanup();
        await sink.cleanup();
        expect(files.size).toBe(0);
        expect(calls.filter(call => call.command === 'desktop_download_cache_remove')).toEqual([
            { command: 'desktop_download_cache_remove', args: { path } },
        ]);
    });

    it('reports a failed exact removal and retains its later cleanup attempt', async () => {
        let removals = 0;
        const sink = await createDesktopDownloadFileSink({ fileName: 'report.pdf', invoke: async command => {
            if (command === 'desktop_download_cache_create') return '/tmp/happier-downloads/file-456/report.pdf';
            if (command === 'desktop_download_cache_remove' && ++removals === 1) throw new Error('File busy');
        } });
        await expect(sink.cleanup()).rejects.toThrow('File busy');
        await sink.cleanup();
        expect(removals).toBe(2);
    });
});
