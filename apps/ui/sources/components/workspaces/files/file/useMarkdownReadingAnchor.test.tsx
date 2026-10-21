import { describe, expect, it, vi } from 'vitest';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import { renderHook } from '@/dev/testkit';
import { splitMarkdownRenderSegments } from '@/components/markdown/rendering/splitMarkdownRenderSegments';
import { useMarkdownReadingAnchor } from './useMarkdownReadingAnchor';

const ranges = (markdown: string) => splitMarkdownRenderSegments({ markdown, streamingMode: 'static', splitEnrichedSourceRanges: true });
const scrollEvent = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } }) as NativeSyntheticEvent<NativeScrollEvent>;

describe('Markdown file reading continuity', () => {
    it('restores a remembered source line through measured blocks and captures the next passage', async () => {
        const hook = await renderHook(() => useMarkdownReadingAnchor('session:remembered', 24, 5));
        const anchor = hook.getCurrent();
        const scrollTo = vi.fn();
        anchor.scrollRef.current = { scrollTo } as unknown as ScrollView;
        const blocks = ranges('# Heading\n\nFirst paragraph.\n\nRemembered paragraph.');
        anchor.observer.onRanges(blocks);
        blocks.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 100, height: 100 }));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 224, animated: false });
        expect(anchor.readLine()).toBe(5);
        anchor.onScroll(scrollEvent(144));
        expect(anchor.readLine()).toBe(3);
        await hook.unmount();
    });
    it('reveals an offscreen Find source line after its block is measured and lets manual scrolling take over', async () => {
        const hook = await renderHook(() => useMarkdownReadingAnchor('session:find', 24));
        const anchor = hook.getCurrent();
        const scrollTo = vi.fn();
        anchor.scrollRef.current = { scrollTo } as unknown as ScrollView;
        const blocks = ranges('# Heading\n\nFirst paragraph.\n\nNeedle paragraph.');
        anchor.observer.onRanges(blocks);
        anchor.revealLine(5);
        expect(scrollTo).not.toHaveBeenCalled();
        blocks.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 100, height: 100 }));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 224, animated: false });
        anchor.onScroll(scrollEvent(224));
        anchor.onScroll(scrollEvent(80));
        scrollTo.mockClear();
        anchor.observer.onLayout(blocks[2]!, { y: 250, height: 100 });
        expect(scrollTo).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it('follows the same paragraph across insertion, unchanged refresh, deletion and manual scrolling', async () => {
        const hook = await renderHook(() => useMarkdownReadingAnchor('session:readme', 24));
        const anchor = hook.getCurrent();
        const scrollTo = vi.fn();
        // The ScrollView imperative handle is the native/web platform boundary.
        anchor.scrollRef.current = { scrollTo } as unknown as ScrollView;
        const original = ranges('# Heading\n\nReading paragraph.\n\nNext paragraph.');
        anchor.observer.onRanges(original);
        original.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 100, height: 100 }));
        anchor.onScroll(scrollEvent(144));
        anchor.observer.onRanges(original);
        expect(scrollTo).not.toHaveBeenCalled();
        const inserted = ranges('# New heading\n\nInserted paragraph.\n\n# Heading\n\nReading paragraph.\n\nNext paragraph.');
        anchor.observer.onRanges(inserted);
        inserted.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 100, height: 100 }));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 344, animated: false });
        anchor.onScroll(scrollEvent(344));
        const deleted = ranges('# New heading\n\nInserted paragraph.\n\n# Heading\n\nNext paragraph.');
        anchor.observer.onRanges(deleted);
        deleted.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 90, height: 90 }));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 314, animated: false });
        anchor.onScroll(scrollEvent(314));
        anchor.onScroll(scrollEvent(134));
        scrollTo.mockClear();
        anchor.observer.onLayout(deleted[3]!, { y: 350, height: 100 });
        expect(scrollTo).not.toHaveBeenCalled();
        const prepended = ranges('Preamble.\n\n# New heading\n\nInserted paragraph.\n\n# Heading\n\nNext paragraph.');
        anchor.observer.onRanges(prepended);
        prepended.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 100, height: 100 }));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 244, animated: false });
        await hook.unmount();
    });
    it('reads a source line inside a native prose run and keeps it when Find re-measures by block', async () => {
        const markdown = '# Heading\n\nFirst paragraph.\n\nSecond paragraph\ncontinues.\n\nLast paragraph.';
        const hook = await renderHook((granularity: 'block' | 'run') => useMarkdownReadingAnchor('session:run', 24, undefined, granularity), { initialProps: 'run' });
        const scrollTo = vi.fn();
        hook.getCurrent().scrollRef.current = { scrollTo } as unknown as ScrollView;
        expect(hook.getCurrent().observer.granularity).toBe('run');
        const [run] = splitMarkdownRenderSegments({ markdown, streamingMode: 'static' });
        hook.getCurrent().observer.onRanges([run!]);
        hook.getCurrent().observer.onLayout(run!, { y: 0, height: 800 });
        hook.getCurrent().onScroll(scrollEvent(524));
        expect(hook.getCurrent().readLine()).toBe(6);
        await hook.rerender('block');
        const blocks = ranges(markdown);
        hook.getCurrent().observer.onRanges(blocks);
        blocks.forEach((range, index) => hook.getCurrent().observer.onLayout(range, { y: index * 100, height: 100 }));
        // Line 6 is the second of the "Second paragraph" block's two source lines.
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 274, animated: false });
        expect(hook.getCurrent().readLine()).toBe(6);
        await hook.unmount();
    });
    it('keeps restoring while a page that clamped the restore is still growing (images loading on return)', async () => {
        const hook = await renderHook(() => useMarkdownReadingAnchor('session:images', 24));
        const anchor = hook.getCurrent();
        const scrollTo = vi.fn();
        anchor.scrollRef.current = { scrollTo } as unknown as ScrollView;
        const blocks = ranges('# Gallery\n\nIntro.\n\n![Hero](hero.png)\n\nClosing.');
        const frames = [{ y: 0, height: 41 }, { y: 41, height: 32 }, { y: 73, height: 170 }, { y: 243, height: 32 }];
        anchor.observer.onRanges(blocks);
        blocks.forEach((range, index) => anchor.observer.onLayout(range, frames[index]!));
        anchor.onScroll(scrollEvent(238));
        // The tab comes back: the renderer re-reports its blocks while the hero image is still shorter.
        anchor.observer.onRanges([...blocks]);
        anchor.observer.onLayout(blocks[2]!, { y: 73, height: 134 });
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 231, animated: false });
        // The browser clamps that restore to the still-short page and reports it as a scroll.
        anchor.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 164 }, contentSize: { width: 500, height: 579 }, layoutMeasurement: { width: 500, height: 415 } } } as NativeSyntheticEvent<NativeScrollEvent>);
        anchor.observer.onLayout(blocks[2]!, { y: 73, height: 170 });
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 238, animated: false });
        await hook.unmount();
    });
    it('holds the reader\'s passage when a hidden tab comes back shorter and the page clamps the offset', async () => {
        const hook = await renderHook(() => useMarkdownReadingAnchor('session:tab', 24));
        const anchor = hook.getCurrent();
        const scrollTo = vi.fn();
        anchor.scrollRef.current = { scrollTo } as unknown as ScrollView;
        const blocks = ranges('# Gallery\n\nIntro.\n\n![Hero](hero.png)\n\n![Logo](logo.svg)');
        const frames = [{ y: 0, height: 41 }, { y: 41, height: 32 }, { y: 73, height: 170 }, { y: 243, height: 300 }];
        anchor.observer.onRanges(blocks);
        blocks.forEach((range, index) => anchor.observer.onLayout(range, frames[index]!));
        anchor.onScroll(scrollEvent(378));
        // Shown again, the hero image has not loaded yet: the page is shorter and the browser clamps the offset.
        anchor.observer.onLayout(blocks[2]!, { y: 73, height: 134 });
        anchor.observer.onLayout(blocks[3]!, { y: 207, height: 300 });
        anchor.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 304 }, contentSize: { width: 500, height: 719 }, layoutMeasurement: { width: 500, height: 415 } } } as NativeSyntheticEvent<NativeScrollEvent>);
        expect(anchor.readLine()).toBe(7);
        anchor.observer.onLayout(blocks[2]!, { y: 73, height: 170 });
        anchor.observer.onLayout(blocks[3]!, { y: 243, height: 300 });
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 378, animated: false });
        scrollTo.mockClear();
        // The scroll view's late scroll-end echo repeats the clamped offset; the page then clamps the restore again.
        const clamped = (y: number, height: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 500, height }, layoutMeasurement: { width: 500, height: 415 } } }) as NativeSyntheticEvent<NativeScrollEvent>;
        anchor.onScroll(clamped(304, 755));
        anchor.onScroll(clamped(340, 755));
        anchor.observer.onLayout(blocks[3]!, { y: 243, height: 301 });
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 378, animated: false });
        expect(anchor.readLine()).toBe(7);
        await hook.unmount();
    });
    it('treats the scroll-end echo of a restore as no reader movement, even a sub-pixel short of the block', async () => {
        const hook = await renderHook(() => useMarkdownReadingAnchor('session:echo', 24, 7));
        const anchor = hook.getCurrent();
        const scrollTo = vi.fn();
        anchor.scrollRef.current = { scrollTo } as unknown as ScrollView;
        const blocks = ranges('# Gallery\n\nIntro.\n\n![Hero](hero.png)\n\n![Logo](logo.svg)');
        const frames = [{ y: 0, height: 41 }, { y: 41, height: 32 }, { y: 73, height: 170 }, { y: 243, height: 134 }];
        anchor.observer.onRanges(blocks);
        blocks.forEach((range, index) => anchor.observer.onLayout(range, frames[index]!));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 267, animated: false });
        // The web scroll view reports the restore on its tick and again when scrolling ends, at a fractional offset.
        anchor.onScroll(scrollEvent(266.8));
        anchor.onScroll(scrollEvent(266.8));
        expect(anchor.readLine()).toBe(7);
        anchor.observer.onLayout(blocks[2]!, { y: 73, height: 300 });
        anchor.observer.onLayout(blocks[3]!, { y: 373, height: 134 });
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 397, animated: false });
        await hook.unmount();
    });
    it('resets the passage on file identity changes', async () => {
        const hook = await renderHook((identity: string) => useMarkdownReadingAnchor(identity, 16), { initialProps: 'session:first' });
        const scrollTo = vi.fn();
        hook.getCurrent().scrollRef.current = { scrollTo } as unknown as ScrollView;
        const original = ranges('# Heading\n\nReading paragraph.');
        hook.getCurrent().observer.onRanges(original);
        original.forEach((range, index) => hook.getCurrent().observer.onLayout(range, { y: index * 100, height: 100 }));
        hook.getCurrent().onScroll(scrollEvent(130));
        await hook.rerender('session:second');
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
        scrollTo.mockClear();
        hook.getCurrent().observer.onRanges(ranges('Another file.'));
        hook.getCurrent().observer.onLayout(ranges('Another file.')[0]!, { y: 0, height: 100 });
        expect(scrollTo).not.toHaveBeenCalled();
    });
});
