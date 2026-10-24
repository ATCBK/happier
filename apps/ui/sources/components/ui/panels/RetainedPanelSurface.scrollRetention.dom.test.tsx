/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

// Keep real RNW DOM hosts; jsdom's missing hidden-layout scroll reset is delivered below at the browser boundary.
vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RetainedPanelSurface } from './RetainedPanelSurface';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it.each(['local', 'ancestor'] as const)('retains independent scroll positions and local state through %s hiding and hidden browser resets', async (hiddenOwner) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
    let mounts = 0;
    let commits = 0;
    function Body() {
        const [note, setNote] = React.useState('retained note');
        React.useEffect(() => { mounts += 1; }, []);
        React.useLayoutEffect(() => { commits += 1; });
        return <>
            <button data-testid="note" onClick={() => setNote('edited note')}>{note}</button>
            <div data-testid="first" style={{ height: 100, overflow: 'auto' }}><div style={{ height: 2000, width: 1000 }} /></div>
            <div data-testid="second" style={{ height: 100, overflow: 'auto' }}><div style={{ height: 2000 }} /></div>
        </>;
    }
    const body = <Body />;
    const render = async (visible: boolean) => {
        await act(async () => root.render(
            <PluginSurfaceFocusEligibilityProvider active={false} presentationActive={hiddenOwner === 'ancestor' ? visible : true}>
                <RetainedPanelSurface isActive={hiddenOwner === 'local' ? visible : true}>{body}</RetainedPanelSurface>
            </PluginSurfaceFocusEligibilityProvider>,
        ));
    };
    await render(true);
    const first = container.querySelector<HTMLElement>('[data-testid="first"]')!;
    const second = container.querySelector<HTMLElement>('[data-testid="second"]')!;
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="note"]')!.click());
    await act(async () => {
        first.scrollTop = 650;
        first.scrollLeft = 47;
        first.dispatchEvent(new Event('scroll'));
        second.scrollTop = 1300;
        second.dispatchEvent(new Event('scroll'));
    });
    await render(false);
    commits = 0;
    // Chrome can zero a hidden scroller while the retained portal moves. This is not reader movement.
    await act(async () => {
        for (const scroller of [first, second]) {
            scroller.scrollTop = 0;
            scroller.scrollLeft = 0;
            scroller.dispatchEvent(new Event('scroll'));
        }
    });
    expect(commits).toBe(0);
    await render(true);
    expect(container.querySelector('[data-testid="first"]')).toBe(first);
    expect(container.querySelector('[data-testid="second"]')).toBe(second);
    expect(first.isConnected && second.isConnected).toBe(true);
    expect([first.scrollTop, first.scrollLeft, second.scrollTop]).toEqual([650, 47, 1300]);
    expect(container.querySelector('[data-testid="note"]')?.textContent).toBe('edited note');
    expect(mounts).toBe(1);
    // A subsequent real reader movement replaces only that scroller's retained position, including zero.
    await act(async () => {
        first.scrollTop = 0;
        first.dispatchEvent(new Event('scroll'));
    });
    await render(false);
    second.scrollTop = 0;
    await render(true);
    expect([first.scrollTop, second.scrollTop]).toEqual([0, 1300]);
});

it('lets the nearest retained surface own nested scroll targets, including hidden child resets', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
    const content = <div data-testid="nested-scroll" style={{ height: 100, overflow: 'auto' }}><div style={{ height: 2000 }} /></div>;
    const render = async (parentActive: boolean, childActive: boolean) => {
        await act(async () => root.render(<RetainedPanelSurface isActive={parentActive}>
            <RetainedPanelSurface isActive={childActive}>{content}</RetainedPanelSurface>
        </RetainedPanelSurface>));
    };
    await render(true, true);
    const scroller = container.querySelector<HTMLElement>('[data-testid="nested-scroll"]')!;
    scroller.scrollTop = 650;
    scroller.dispatchEvent(new Event('scroll'));
    await render(true, false);
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await render(false, false);
    await render(true, false);
    expect(scroller.scrollTop).toBe(0);
    await render(true, true);
    expect(scroller.scrollTop).toBe(650);
    expect(container.querySelector('[data-testid="nested-scroll"]')).toBe(scroller);
    // Reveal both owners in one commit: an ancestor must not overwrite the child's restored position.
    await render(true, false);
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await render(false, false);
    await render(true, true);
    expect(scroller.scrollTop).toBe(650);
});

it('retains scroll view state when an Activity ancestor temporarily withdraws DOM refs', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
    let initializations = 0;
    function Body() {
        const [note] = React.useState(() => { initializations += 1; return 'retained note'; });
        return <div data-testid="activity-scroll" style={{ height: 100, overflow: 'auto' }}>
            <input defaultValue={note} /><div style={{ height: 2000 }} />
        </div>;
    }
    const content = <RetainedPanelSurface isActive><Body /></RetainedPanelSurface>;
    const render = async (visible: boolean) => {
        await act(async () => root.render(<React.Activity mode={visible ? 'visible' : 'hidden'}>{content}</React.Activity>));
    };
    await render(true);
    const scroller = container.querySelector<HTMLElement>('[data-testid="activity-scroll"]')!;
    const input = scroller.querySelector('input')!;
    input.value = 'edited retained note';
    scroller.scrollTop = 650;
    scroller.dispatchEvent(new Event('scroll'));
    await render(false);
    scroller.scrollTop = 0;
    await render(true);
    expect(container.querySelector('[data-testid="activity-scroll"]')).toBe(scroller);
    expect(input.value).toBe('edited retained note');
    expect(scroller.scrollTop).toBe(650);
    expect(initializations).toBe(1);
});
