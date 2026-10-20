import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useWidgetPlacementLabels } from './WidgetAboutPanel';

it('names core-page placements alongside Home and plugin pages without exposing page ids', async () => {
    const scope = { serverId: 'home', accountId: 'viewer' };
    const hook = await renderHook(() => useWidgetPlacementLabels({ unavailableScopes: [], placements: [
        { surface: { ...scope, owner: { kind: 'home' } }, instanceId: 'home-copy' },
        { surface: { ...scope, owner: { kind: 'corePage', pageId: 'private-internal-page-id', area: 'overview' } }, instanceId: 'page-copy' },
        { surface: { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } }, instanceId: 'plugin-copy' },
    ] }));
    try {
        expect(hook.getCurrent()).toHaveLength(3);
        expect(hook.getCurrent().every(({ label }) => label.length > 0 && !label.includes('private-internal-page-id'))).toBe(true);
        // Each place carries its own kind's mark, so its label never repeats the kind in words.
        expect(new Set(hook.getCurrent().map(({ icon }) => icon)).size).toBe(3);
    } finally { await hook.unmount(); }
});

it('shows the friendly read label and the exact admitted Resource identity as separate lines', async () => {
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    const React = await import('react');
    const { WidgetAboutPanel } = await import('./WidgetAboutPanel');
    const screen = await renderScreen(React.createElement(WidgetAboutPanel, {
        definition: null, descriptor: null, name: 'Checks', placements: null, testID: 'about',
        sources: [{ key: 'acme.checks/bound-count', plugin: 'Acme checks', machine: null, usesViewerConnection: false,
            read: 'Bound count', identity: 'acme.checks/bound-count' }],
    }));
    try {
        const text = screen.getTextContent();
        expect(text).toContain('Bound count from Acme checks');
        expect(screen.findAllHostsByTestId('about.reads.identity').map(node => node.props.children).flat().join('')).toBe('acme.checks/bound-count');
    } finally { await act(async () => { screen.tree.unmount(); }); }
});
