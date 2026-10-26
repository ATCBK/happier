import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';

installUiListsCommonModuleMocks();

const { ProjectShellHeader } = await import('./ProjectShellHeader');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { resolveProjectPageCatalog } = await import('../detail/projectPageCatalog');

describe('Project header page descriptors', () => {
    afterEach(standardCleanup);

    it('announces the authored disabled explanation instead of interpreting it as a diagnostic code', async () => {
        const placement = createPluginPagePlacementFixture({ pluginId: 'external.tools', localId: 'builds', title: 'Builds' });
        const pages = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' },
            placements: [{ ...placement, availability: { ...placement.availability,
                disabledWhen: { fact: 'project.exists', operator: 'equals', value: true },
                disabledReason: 'Builds are paused for this Project' } }],
            policyContext: { data: { project: { exists: true } } } });
        const external = pages.at(-1)!;
        const screen = await renderScreen(<ProjectShellHeader projectName="Project" checkout={null}
            pages={[external]} activePage="overview" onSelectPage={() => {}} onNewSession={null} menuActions={[]} />);
        expect(screen.findHostByTestId(`project-shell-header.pages:${external.id}`)?.props.accessibilityLabel)
            .toContain(external.disabledReason);
    });

    it('keeps an explicitly overflowed external page reachable and selected when the pinned page fits', async () => {
        const pages = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' },
            placements: [createPluginPagePlacementFixture({ pluginId: 'external.tools', localId: 'builds', title: 'Builds' })] });
        const external = pages.find(page => page.id === 'plugin:external.tools:builds')!;
        const selected: string[] = [];
        const screen = await renderScreen(<ProjectShellHeader projectName="Project" checkout={null}
            pages={pages.slice(0, 1)} overflowPages={[external]} orderedPageIds={[external.id, 'overview']}
            activePage={external.id} onSelectPage={id => selected.push(id)} onNewSession={null} menuActions={[]}
            onCustomizeTabs={() => {}} />);
        const menu = screen.root.findAllByType(DropdownMenu).find(menu =>
            menu.props.items.some((item: { id: string }) => item.id === external.id));
        expect(menu).toBeDefined();
        expect(menu?.props.selectedId).toBe(external.id);
        expect(menu?.props.items.find((item: { id: string }) => item.id === external.id)).toMatchObject({ title: external.title, checked: true });
        expect(menu?.props.footer).toBeTruthy();
        await menu?.props.onSelect(external.id);
        expect(selected).toEqual([external.id]);
    });
});
