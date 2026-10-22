import * as React from 'react';
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen, renderHook } from '@/dev/testkit';
import { installCodeViewCommonModuleMocks } from '@/components/ui/code/view/codeViewTestHelpers';
import { CodeLinesViewCore } from '@/components/ui/code/view/CodeLinesViewCore';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { createFileViewerFindModel } from '../details/useFileViewerFind';
import { useFileContentScrollTarget } from './useFileContentScrollTarget';

installCodeViewCommonModuleMocks();

describe('file content scroll intent', () => {
    it('restores memory once without rebounding after an explicit anchor or Find', async () => {
        const hook = await renderHook<string | undefined, { jump?: string; open: boolean }>((props) =>
            useFileContentScrollTarget(props.jump, { open: props.open, lineTarget: props.open ? 'f:12' : null }, 'f:8'),
        { initialProps: { open: false } });
        expect(hook.getCurrent()).toBe('f:8');
        await hook.rerender({ jump: 'f:18', open: false });
        expect(hook.getCurrent()).toBe('f:18');
        await hook.rerender({ open: false });
        expect(hook.getCurrent()).toBeUndefined();
        await hook.rerender({ open: true });
        expect(hook.getCurrent()).toBe('f:12');
        await hook.rerender({ open: false });
        expect(hook.getCurrent()).toBeUndefined();
        await hook.unmount();
    });
    it('keeps the remembered place under a restored Find bar until a match becomes current, then never rebounds', async () => {
        const hook = await renderHook<string | undefined, { target: string | null }>((props) =>
            useFileContentScrollTarget(undefined, { open: true, lineTarget: props.target }, 'f:8'),
        { initialProps: { target: null } });
        expect(hook.getCurrent()).toBe('f:8');
        await hook.rerender({ target: 'f:12' });
        expect(hook.getCurrent()).toBe('f:12');
        await hook.rerender({ target: null });
        expect(hook.getCurrent()).toBeUndefined();
        await hook.unmount();
    });
    it('does not rebound to an old deep link on invalid query or close, but honors a new target', async () => {
        const text = 'first\nneedle\nlast';
        const lines = buildCodeLinesFromFile({ text });
        const model = createFileViewerFindModel(() => ({ path: 'a.ts', mode: 'file', text }));
        let scrollY = 0;
        // Native measurement/ScrollView are platform boundaries; all matching and rendering are real.
        const externalScrollView = { scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } },
            contentRef: { current: {} as View }, offsetRef: { current: 0 } };
        function Content(props: { jumpTarget: string }) {
            const find = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
            const target = useFileContentScrollTarget(props.jumpTarget, find);
            return <CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId={target}
                findRangesByLineId={find.lineRanges} externalScrollView={externalScrollView} />;
        }
        const screen = await renderScreen(<Content jumpTarget="f:1" />, {
            createNodeMock: () => ({ measureLayout: (_relative: unknown, callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 240, 400, 22) }),
        });
        const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
        await settle();
        await act(async () => { model.open(); model.setQuery('needle'); });
        await settle();
        scrollY = 320;
        await act(async () => { model.setOptions({ matchCase: false, regex: true }); model.setQuery('['); });
        await settle();
        expect(scrollY).toBe(320);
        await act(async () => { model.close(); });
        await settle();
        expect(scrollY).toBe(320);
        await screen.update(<Content jumpTarget="f:3" />);
        await settle();
        expect(scrollY).toBe(240);
        await screen.unmount();
    });
});
