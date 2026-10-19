import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SkillListItemV1Schema, type SkillUnavailableItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

afterEach(standardCleanup);

function skill(skillId: string, name: string, description: string | null = null) {
    return SkillListItemV1Schema.parse({
        skillId, name, description, revision: '1:1', rules: [], trust: 'text_only',
        cost: { descriptionTokens: 10, bodyTokens: 100 }, provenance: { kind: 'written' }, modified: false,
        updatePolicy: 'manual', createdAt: 1, migratedFromContext: false, userInvocable: true, folderId: null,
    });
}

const lint = skill('lint-id', 'lint', 'Runs the linter before every commit.');
const review = skill('review-id', 'review', 'Reviews a diff.');
const library = (
    items = [lint, review],
    status: 'ready' | 'loading' | 'unavailable' = 'ready',
    unavailableItems: readonly SkillUnavailableItemV1[] = [],
) => ({ status, items, unavailableItems, retry: vi.fn() });

// The section's graph is large; load it while collecting, outside any test deadline.
const { ProfileSkillSeedsSection } = await import('./ProfileSkillSeedsSection');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { t } = await import('@/text');
const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');

/** The editor's sections render as page sections; the section header carries Add. */
const inPage = (node: React.ReactNode) => <ListPresentationProvider value="page">{node}</ListPresentationProvider>;

/** The capability row's own title (the testID also lands on host nodes beneath it). */
const rowTitle = (screen: Awaited<ReturnType<typeof renderScreen>>, skillId: string) =>
    screen.findAllByTestId(`profile-skill-seeds:row:${skillId}`).find(node => typeof node.props.title === 'string')?.props.title;

describe('ProfileSkillSeedsSection', () => {
    it('lists the seeded skills by name, lets Add pick from the library without the seeded ones, and Remove takes one out', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(inPage(<ProfileSkillSeedsSection seeds={['lint-id']} library={library()} onChange={onChange} />));
        expect(rowTitle(screen, 'lint-id')).toBe('lint');
        const menu = screen.findByType(DropdownMenu);
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['review-id']);
        await act(async () => menu.props.onSelect('review-id'));
        expect(onChange).toHaveBeenLastCalledWith(['lint-id', 'review-id']);
        await act(async () => screen.pressByTestId('profile-skill-seeds:row:lint-id:remove'));
        expect(onChange).toHaveBeenLastCalledWith([]);
    });

    it('keeps a seeded skill that left the library visible, described as not in the library, and removable', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(inPage(<ProfileSkillSeedsSection seeds={['gone-id', 'lint-id']} library={library()} onChange={onChange} />));
        const gone = screen.findAllByTestId('profile-skill-seeds:row:gone-id').find(node => typeof node.props.title === 'string');
        expect(gone?.props.title).toBe(t('capabilities.profileSeeds.pending'));
        expect(gone?.props.description).toBe(t('capabilities.profileSeeds.missing'));
        expect(rowTitle(screen, 'lint-id')).toBe('lint');
        await act(async () => screen.pressByTestId('profile-skill-seeds:row:gone-id:remove'));
        expect(onChange).toHaveBeenLastCalledWith(['lint-id']);
    });

    it('names a seeded skill the library knows but cannot open, instead of calling it missing, and leaves it removable', async () => {
        const onChange = vi.fn();
        const unreadable: SkillUnavailableItemV1 = { skillId: 'brand-id', title: 'brand-voice', reason: 'skill_content_unavailable' };
        const screen = await renderScreen(inPage(
            <ProfileSkillSeedsSection seeds={['brand-id']} library={library([lint], 'ready', [unreadable])} onChange={onChange} />,
        ));
        const row = screen.findAllByTestId('profile-skill-seeds:row:brand-id').find(node => typeof node.props.title === 'string');
        expect(row?.props.title).toBe('brand-voice');
        expect(row?.props.description).toBe(t('capabilities.profileSeeds.unreadableItem'));
        await act(async () => screen.pressByTestId('profile-skill-seeds:row:brand-id:remove'));
        expect(onChange).toHaveBeenLastCalledWith([]);
    });

    it('explains an empty Profile with Add, and an empty library with a way to Skills and no Add', async () => {
        const none = await renderScreen(inPage(<ProfileSkillSeedsSection seeds={[]} library={library()} onChange={vi.fn()} />));
        expect(none.findByTestId('profile-skill-seeds:empty')).not.toBeNull();
        expect(none.findAllByType(DropdownMenu)).toHaveLength(1);
        const noLibrary = await renderScreen(inPage(<ProfileSkillSeedsSection seeds={[]} library={library([])} onChange={vi.fn()} />));
        expect(noLibrary.findByTestId('profile-skill-seeds:empty-library')).not.toBeNull();
        expect(noLibrary.findAllByType(DropdownMenu)).toHaveLength(0);
    });

    it('does not claim a seed is missing, or hide it, while the library cannot be read, and retries from the notice', async () => {
        const lib = library([], 'unavailable');
        const onChange = vi.fn();
        const screen = await renderScreen(inPage(<ProfileSkillSeedsSection seeds={['lint-id']} library={lib} onChange={onChange} />));
        expect(rowTitle(screen, 'lint-id')).toBe(t('capabilities.profileSeeds.pending'));
        await act(async () => screen.findAllByTestId('profile-skill-seeds:unreadable').find(node => node.props.action)?.props.action.onPress());
        expect(lib.retry).toHaveBeenCalledTimes(1);
    });
});
