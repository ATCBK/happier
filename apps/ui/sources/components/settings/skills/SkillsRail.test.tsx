import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSkillsSurfaceHarness, createSkillsSurfaceItem as skill, createSkillsSurfaceLibrary as library } from '@/dev/testkit/harness/skillsSurfaceHarness';

const navigation = vi.hoisted(() => ({ params: {} as { machine?: string }, push: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/skills', params: () => navigation.params,
        router: { push: navigation.push, replace: navigation.replace } }).module;
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
const { SkillsList } = await import('./SkillsRail');
const { CapabilityRow } = await import('@/components/capabilities/row/CapabilityRow');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

afterEach(() => { standardCleanup(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); navigation.params = {}; vi.clearAllMocks(); });

it('retains row render locality when one of 139 listed skills changes', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-rail-row-cost.test');
    // Observe the real render function without replacing any of its logic or dependencies.
    const row = CapabilityRow as React.MemoExoticComponent<React.FunctionComponent<React.ComponentProps<typeof CapabilityRow>>>;
    const original = row.type;
    const counts = new Map<string, number>();
    const render = vi.spyOn(row, 'type').mockImplementation(props => {
        if (props.testID.startsWith('skills.rail.row.')) counts.set(props.testID, (counts.get(props.testID) ?? 0) + 1);
        return original(props);
    });
    const items = Array.from({ length: 139 }, (_, i) => skill(`row-${i}`));
    const screen = await renderScreen(<SkillsList variant="page" library={library(items)} />);
    try {
        await vi.waitFor(() => expect(screen.findByTestId('skills.rail.row.row-138')).not.toBeNull());
        counts.clear();
        await screen.update(<SkillsList variant="page" library={library(items.map((item, i) => i === 0
            ? { ...item, description: 'Changed instructions' } : item))} />);
        expect([...counts.entries()]).toEqual([['skills.rail.row.row-0', 1]]);
    } finally { await screen.unmount(); render.mockRestore(); await home.dispose(); }
});

it('moves rendered rows from use groups to personal folders, filters by the route Machine and clears that filter', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-rail-groups.test', [{ key: 'folders', value: { v: 1,
        folders: [{ id: 'writing', name: 'Writing', parentId: null }] } }]);
    try {
        const on = skill('on');
        const off = skill('off', { rules: [] });
        const elsewhere = skill('elsewhere', { rules: [{ ...skill('elsewhere').rules[0]!, target: { t: 'machine', machineId: 'away' } }] });
        const screen = await renderScreen(<SkillsList variant="page" library={library([on, off, elsewhere])} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.list.group.inUse')).not.toBeNull());
        expect(screen.findByTestId('skills.list.group.off')).not.toBeNull();
        expect(screen.findByTestId('skills.list.group.inUse')?.findAll(node => node.props.testID === 'skills.rail.row.on')).not.toHaveLength(0);
        expect(screen.findByTestId('skills.list.group.off')?.findAll(node => node.props.testID === 'skills.rail.row.off')).not.toHaveLength(0);
        await screen.update(<SkillsList variant="page" library={library([{ ...on, folderId: 'writing' }, off, elsewhere])} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.list.group.folder.writing')).not.toBeNull());
        expect(screen.findByTestId('skills.list.group.folder.none')).not.toBeNull();
        expect(screen.findByTestId('skills.list.group.folder.writing')?.findAll(node => node.props.testID === 'skills.rail.row.on')).not.toHaveLength(0);
        expect(screen.findByTestId('skills.list.group.folder.none')?.findAll(node => node.props.testID === 'skills.rail.row.off')).not.toHaveLength(0);
        expect(screen.findByTestId('skills.list.group.inUse')).toBeNull();
        navigation.params = { machine: 'nl2' };
        await screen.update(<SkillsList variant="page" library={library([on, off, elsewhere])} />);
        expect(screen.findByTestId('skills.rail.row.on')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.off')).toBeNull();
        expect(screen.findByTestId('skills.rail.row.elsewhere')).toBeNull();
        await act(async () => screen.pressByTestId('skills.rail.machineFilter.clear'));
        expect(navigation.replace).toHaveBeenCalledWith('/settings/skills');
    } finally { await standardCleanup(); await home.dispose(); }
});

it('adds the Updates destination only for a waiting update and preserves known rows on a failed refresh', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-rail-states.test');
    try {
        const item = skill('review');
        const screen = await renderScreen(<SkillsList variant="rail" library={library([item])} />);
        expect(screen.findByTestId('skills.rail.updates')).toBeNull();
        await screen.update(<SkillsList variant="rail" library={library([{ ...item, upstream: { state: 'update_available' } }])} />);
        expect(screen.findByTestId('skills.rail.updates')).not.toBeNull();
        await act(async () => screen.pressByTestId('skills.rail.updates'));
        expect(navigation.push).toHaveBeenCalledWith('/settings/skills/updates');
        const retry = vi.fn();
        await screen.update(<SkillsList variant="rail" library={library([item], { status: 'unavailable', stale: true, errorCode: 'catalog_unavailable', retry })} />);
        expect(screen.findByTestId('skills.rail.row.review')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.error')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.empty')).toBeNull();
        await screen.update(<SkillsList variant="rail" library={library([], { status: 'unavailable', errorCode: 'catalog_unavailable', retry })} />);
        expect(screen.findByTestId('skills.rail.error')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.empty')).toBeNull();
        await act(async () => screen.pressByTestId('skills.rail.error-action'));
        expect(retry).toHaveBeenCalledOnce();
    } finally { await standardCleanup(); await home.dispose(); }
});
