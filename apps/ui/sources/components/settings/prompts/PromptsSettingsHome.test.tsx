import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import {
    installPromptLibrarySettingsCommonModuleMocks,
    promptLibrarySettingsRouterPushSpy,
} from './promptLibrarySettingsTestHelpers';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPromptLibrarySettingsCommonModuleMocks({ storage: async (importOriginal) => importOriginal() });

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

beforeEach(async () => {
    installDisconnectedServerSocketBoundary();
    await loadSyncSingletonForTests();
    clearActiveUnsavedChangesGuard();
    promptLibrarySettingsRouterPushSpy.mockClear();
});

afterEach(async () => {
    await standardCleanup();
    clearActiveUnsavedChangesGuard();
});

describe('PromptsSettingsHome', () => {
    it('keeps prompt destinations and removes the retired skills, assets and registry entries', async () => {
        const { PromptsSettingsHome } = await import('./PromptsSettingsHome');

        const screen = await renderScreen(<PromptsSettingsHome />);

        const promptsItem = screen.findByTestId('settings-prompts-library-prompts');
        const skillsItem = screen.findByTestId('settings-prompts-library-skills');
        const foldersItem = screen.findByTestId('settings-prompts-folders');
        const templatesItem = screen.findByTestId('settings-prompts-templates');
        const stacksItem = screen.findByTestId('settings-prompts-stacks');
        const assetsItem = screen.findByTestId('settings-prompts-assets');
        const registriesItem = screen.findByTestId('settings-prompts-registries');

        expect(promptsItem).toBeTruthy();
        expect(skillsItem).toBeFalsy();
        expect(foldersItem).toBeTruthy();
        expect(templatesItem).toBeTruthy();
        expect(stacksItem).toBeTruthy();
        expect(assetsItem).toBeFalsy();
        expect(registriesItem).toBeFalsy();

        await screen.pressByTestIdAsync('settings-prompts-library-prompts');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/docs');

        await screen.pressByTestIdAsync('settings-prompts-folders');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/folders');

        await screen.pressByTestIdAsync('settings-prompts-templates');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/templates');

        await screen.pressByTestIdAsync('settings-prompts-stacks');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/stacks/coding');
    });
});
