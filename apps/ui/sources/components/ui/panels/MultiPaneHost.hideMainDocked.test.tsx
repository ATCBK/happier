import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { MultiPaneHost } from './MultiPaneHost';
import { renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (hideMain docked)', () => {
    it('hides the main region when hideMain is true and panes are docked', async () => {
        const screen = await renderScreen(<MultiPaneHost
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
                />);

        const main = screen.findByType(Main);
        await screen.update(<MultiPaneHost hideMain main={<Main />} rightPane={<Right />} detailsPane={<Details />}
            layout={{ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }} rightDockWidthPx={360} detailsDockWidthPx={520}
            onCloseRight={() => {}} onCloseDetails={() => {}} onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}} />);
        expect(screen.findByType(Main)).toBe(main);
        expect(screen.findByType(Details)).toBeTruthy();
        expect(screen.findByType(Right)).toBeTruthy();
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
