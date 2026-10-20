import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { MultiPaneHost } from './MultiPaneHost';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (hideMain docked)', () => {
    it('hides the main region when hideMain is true and panes are docked', async () => {
        vi.useFakeTimers();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MultiPaneHost
                    main={<Main />}
                    rightPane={<Right />}
                    detailsPane={<Details />}
                    layout={{ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />)).tree;

        const main = tree!.findByType('Main' as any);
        await renderer.act(async () => tree!.update(<MultiPaneHost hideMain main={<Main />} rightPane={<Right />} detailsPane={<Details />}
            layout={{ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }} rightDockWidthPx={360} detailsDockWidthPx={520}
            onCloseRight={() => {}} onCloseDetails={() => {}} onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}} />));
        expect(tree!.findByType('Main' as any)).toBe(main);
        expect(tree!.findByType('Details' as any)).toBeTruthy();
        expect(tree!.findByType('Right' as any)).toBeTruthy();
    });
});

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}

function Details() {
    return React.createElement('Details');
}
