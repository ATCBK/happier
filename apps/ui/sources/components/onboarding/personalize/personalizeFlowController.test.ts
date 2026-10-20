import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { applyLocalSettings, localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';

import { createPersonalizeFlowActions } from './personalizeFlowController';
import {
    EMPTY_PERSONALIZE_PROGRESS,
    readPersonalizeChoices,
    resolvePersonalizeCardProgress,
    resolvePersonalizeResumePage,
    type PersonalizeProgress,
} from './personalizeFlowModel';

/** Account, device and visit-memory storage are the persistence boundaries; the flow logic above them is real. */
function createHarness(options: Readonly<{ declineTheme?: boolean }> = {}) {
    const account = settingsDefaults;
    let local: LocalSettings = localSettingsDefaults;
    let progress: PersonalizeProgress = EMPTY_PERSONALIZE_PROGRESS;
    const completed: string[] = [];
    const actions = createPersonalizeFlowActions({
        readAccount: () => account,
        readLocal: () => local,
        // Preference mutations run through the real Action wiring in usePersonalizeFlow.test.tsx.
        writeSetting: async () => { throw new Error('Unexpected preference write in a visit-memory test'); },
        applyTheme: (mode) => {
            if (options.declineTheme) return false;
            local = applyLocalSettings(local, { themePreference: mode });
            return true;
        },
        readProgress: () => progress,
        writeProgress: (next) => { progress = next; },
        completeSetup: () => { completed.push('personalize'); },
    });
    return {
        actions,
        account: () => account,
        local: () => local,
        progress: () => progress,
        completed,
    };
}

describe('Personalize flow actions', () => {
    it('keeps a declined theme step and its progress unsaved', async () => {
        const flow = createHarness({ declineTheme: true });
        const before = flow.local().themePreference;
        expect(await flow.actions.saveStep('look', { ...flow.actions.readCurrentChoices(), theme: 'dark' }))
            .toEqual({ ok: false, error: null });
        expect(flow.local().themePreference).toBe(before);
        expect(flow.progress()).toEqual(EMPTY_PERSONALIZE_PROGRESS);
    });
    it('saves a theme step and remembers where to resume', async () => {
        const flow = createHarness();
        const draft = readPersonalizeChoices(flow.account(), flow.local());

        expect(await flow.actions.saveStep('look', { ...draft, theme: 'dark' })).toEqual({ ok: true });
        expect(flow.local().themePreference).toBe('dark');
        flow.actions.skipPage('style');
        expect(flow.progress()).toEqual({ savedSteps: ['look'], resumeAt: 'conversation' });
    });

    it('keeps current values when a step is skipped', () => {
        const flow = createHarness();
        const before = flow.account();
        flow.actions.skipPage('tools');
        expect(flow.account()).toBe(before);
        expect(flow.progress()).toEqual({ savedSteps: [], resumeAt: 'work' });
    });

    it('finishing later keeps saved choices, and reopening resumes with them pre-selected', async () => {
        const flow = createHarness();
        const draft = readPersonalizeChoices(flow.account(), flow.local());
        await flow.actions.saveStep('look', { ...draft, theme: 'light' });
        flow.actions.skipPage('style');
        // "Finish later": nothing else happens; the card reads the visit memory.

        expect(resolvePersonalizeResumePage(flow.progress())).toBe('conversation');
        expect(resolvePersonalizeCardProgress(flow.progress())).toEqual({ started: true, savedCount: 1, nextStep: 'conversation' });
        expect(flow.actions.readCurrentChoices()).toMatchObject({ theme: 'light' });
        expect(flow.completed).toEqual([]);
    });

    it('a starting style only pre-fills the draft; nothing is written until each step\'s Next', () => {
        const flow = createHarness();
        const draft = flow.actions.readCurrentChoices();
        const prefilled = flow.actions.prefillStyle(draft, 'detail');
        expect(prefilled).toMatchObject({ transcriptLayout: 'linear', toolChrome: 'cards', listDensity: 'detailed' });
        expect(flow.actions.prefillStyle(draft, 'keep')).toBe(draft);
        expect(flow.account()).toBe(settingsDefaults);
    });

    it('"Use this setup" completes the Home card and clears the visit memory', async () => {
        const flow = createHarness();
        await flow.actions.saveStep('look', { ...flow.actions.readCurrentChoices(), theme: 'dark' });
        flow.actions.complete();
        expect(flow.completed).toEqual(['personalize']);
        expect(flow.progress()).toEqual(EMPTY_PERSONALIZE_PROGRESS);
        expect(flow.local().themePreference).toBe('dark');
    });
});
