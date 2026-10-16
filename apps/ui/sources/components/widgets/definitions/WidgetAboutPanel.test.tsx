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
