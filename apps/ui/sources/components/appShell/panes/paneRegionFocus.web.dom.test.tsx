/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { focusPaneRegion, usePaneRegionFocusBoundary } from './paneRegion';

// Exercise the browser host refs and real focus-return owner at the platform boundary.
vi.mock('react-native', async () => vi.importActual('react-native-web'));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();
});

it('restores the last interactive target and excludes a retained hidden region', async () => {
    function Pane(props: Readonly<{ region: 'details' | 'main'; visible: boolean }>) {
        const boundary = usePaneRegionFocusBoundary(props.region, props.visible);
        return <section {...boundary} aria-label={props.region} tabIndex={-1} hidden={!props.visible}>
            <button data-testid={`${props.region}-first`}>First</button>
            <button data-testid={`${props.region}-last`}>Last</button>
        </section>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const render = (detailsVisible: boolean) => <><Pane region="details" visible={detailsVisible} /><Pane region="main" visible /></>;
    await act(async () => root.render(render(true)));
    const detailsLast = container.querySelector<HTMLButtonElement>('[data-testid="details-last"]')!;
    const mainFirst = container.querySelector<HTMLButtonElement>('[data-testid="main-first"]')!;
    detailsLast.focus();
    mainFirst.focus();
    expect(focusPaneRegion('previous')).toBe(true);
    expect(document.activeElement).toBe(detailsLast);
    await act(async () => root.render(render(false)));
    mainFirst.focus();
    expect(focusPaneRegion('previous')).toBe(true);
    expect(document.activeElement).toBe(mainFirst);
});
