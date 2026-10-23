import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID, HAPPIER_UI_FONT_SCALE_CSS_VAR } from './webUnistylesFontOverrides';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Preference selection and storage stay real; only browser/clock boundaries are substituted.
const { storage } = await import('@/sync/domains/state/storageStore');
const { useWebUiFontScale } = await import('./useWebUiFontScale');

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const key of ['__HAPPIER_WEB_UI_FONT_SCALE_SYNC_SCHEDULED__', '__HAPPIER_WEB_UI_FONT_SCALE_INSERT_RULE_PATCHED__']) {
        Reflect.deleteProperty(globalThis, key);
    }
});

it('updates only new font rules, without idle frames or observing its own writes, for both mounted roots', async () => {
    const dom = new JSDOM('<!doctype html><html><head><style>.unistyles_initial { font-size: 16px; }</style></head><body></body></html>');
    const { document, CSSStyleSheet, MutationObserver } = dom.window;
    const originalInsertRule = CSSStyleSheet.prototype.insertRule;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
    });
    const flushFrames = async () => {
        const pending = [...frames.values()];
        frames.clear();
        await act(async () => { for (const callback of pending) callback(0); });
    };
    vi.stubGlobal('document', document);
    vi.stubGlobal('CSSStyleSheet', CSSStyleSheet);
    vi.stubGlobal('MutationObserver', MutationObserver);
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const previousSettings = storage.getState().localSettings;
    storage.setState({ localSettings: { ...previousSettings, uiFontScale: 1.25 } });
    try {
        const root = await renderHook(() => useWebUiFontScale());
        const embed = await renderHook(() => useWebUiFontScale());
        await vi.advanceTimersByTimeAsync(50);
        await flushFrames();
        await flushFrames();
        requestFrame.mockClear();
        const sheet = document.styleSheets[0]!;
        for (let index = 0; index < 50; index++) sheet.insertRule(`.unrelated_${index} { color: red; }`);
        await act(async () => { await Promise.resolve(); });
        expect(requestFrame, 'unrelated CSS is not font-scaling demand').toHaveBeenCalledTimes(0);

        const override = () => document.getElementById(HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID)?.textContent ?? '';
        expect(override()).toContain('font-size: calc(16px *');
        let publications = 0;
        const publishedStyle = document.getElementById(HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID)!;
        const publicationObserver = new MutationObserver((records: MutationRecord[]) => {
            publications += records.filter(record => record.target === publishedStyle).length;
        });
        publicationObserver.observe(publishedStyle, { childList: true });
        try {
            for (let index = 0; index < 50; index++) sheet.insertRule(`.unistyles_burst_${index} { font-size: ${14 + index}px; }`);
            await act(async () => { await Promise.resolve(); await Promise.resolve(); });
            expect(override()).toContain('.unistyles_burst_49');
            expect(publications, 'one synchronous style burst publishes once before paint').toBe(1);
        } finally { publicationObserver.disconnect(); }
        sheet.insertRule('.unistyles_late { font-size: 18px; line-height: 24px; }');
        await act(async () => { await Promise.resolve(); });
        expect(override()).toContain('font-size: calc(18px *');
        expect(override()).toContain('line-height: calc(24px *');

        const added = document.createElement('style');
        added.textContent = '.unistyles_sheet { font-size: 22px; }';
        document.head.appendChild(added);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(override()).toContain('font-size: calc(22px *');
        await root.unmount();
        sheet.insertRule('.unistyles_remaining { letter-spacing: 2px; }');
        await act(async () => { await Promise.resolve(); });
        expect(override()).toContain('letter-spacing: calc(2px *');

        await act(async () => storage.getState().applyLocalSettings({ uiFontScale: 1.5 }, { persist: false }));
        expect(document.documentElement.style.getPropertyValue(HAPPIER_UI_FONT_SCALE_CSS_VAR)).toBe('1.5');
        await vi.advanceTimersByTimeAsync(300_000);
        expect(requestFrame).toHaveBeenCalledTimes(0);
        expect(frames.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await embed.unmount();
        expect(CSSStyleSheet.prototype.insertRule).toBe(originalInsertRule);
        const retained = override();
        sheet.insertRule('.unistyles_retired { font-size: 30px; }');
        await Promise.resolve();
        expect(override()).toBe(retained);
    } finally {
        standardCleanup();
        storage.setState({ localSettings: previousSettings });
        CSSStyleSheet.prototype.insertRule = originalInsertRule;
        dom.window.close();
    }
});
