import { describe, expect, it, vi } from 'vitest';

import { act, createDeferred, renderHook } from '@/dev/testkit';
import { decodeSvgPreviewBytes } from './decodeSvgPreviewBytes';
import { useSvgPreviewText } from './useSvgPreviewText';

const fileReads = vi.hoisted(() => new Map<string, Promise<string>>());
// Local cache-file I/O is the system boundary; source selection and lifecycle stay real.
vi.mock('expo-file-system', () => ({ File: class {
    constructor(private uri: string) {}
    text() { return fileReads.get(this.uri) ?? Promise.reject(new Error('cache file unavailable')); }
} }));

describe('SVG preview text', () => {
    it('prefers existing XML and bytes without reading a URI, and refuses non-SVG bytes', async () => {
        const xml = '<svg><path/></svg>';
        const hook = await renderHook(() => useSvgPreviewText({ xml, bytes: new Uint8Array([0]), uri: 'file:///unused' }));
        expect(hook.getCurrent()).toMatchObject({ status: 'loaded', text: xml, error: null });
        expect(decodeSvgPreviewBytes(new TextEncoder().encode(xml))).toBe(xml);
        expect(() => decodeSvgPreviewBytes(new TextEncoder().encode('not an SVG'))).toThrow();
        expect(() => decodeSvgPreviewBytes(new Uint8Array([0xff]))).toThrow();
        await hook.unmount();
    });

    it('drops an old cache-file resolution after the URI changes', async () => {
        const first = createDeferred<string>();
        const second = createDeferred<string>();
        fileReads.set('file:///a', first.promise);
        fileReads.set('file:///b', second.promise);
        const hook = await renderHook(({ uri }) => useSvgPreviewText({ uri }), { initialProps: { uri: 'file:///a' } });
        await hook.rerender({ uri: 'file:///b' });
        await act(async () => { second.resolve('<svg id="b"/>'); });
        expect(hook.getCurrent()).toMatchObject({ status: 'loaded', text: '<svg id="b"/>' });
        await act(async () => { first.resolve('<svg id="a"/>'); });
        expect(hook.getCurrent()).toMatchObject({ status: 'loaded', text: '<svg id="b"/>' });
        await hook.unmount();
        fileReads.clear();
    });
});
