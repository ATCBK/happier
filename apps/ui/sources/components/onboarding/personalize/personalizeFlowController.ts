import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';

import {
    EMPTY_PERSONALIZE_PROGRESS,
    applyStartingStyle,
    readPersonalizeChoices,
    recordPersonalizePageSkipped,
    recordPersonalizeStepSaved,
    resolvePersonalizeStepWrite,
    type PersonalizeChoices,
    type PersonalizePageId,
    type PersonalizeProgress,
    type PersonalizeStepId,
    type PersonalizeSettingWrite,
    type StartingStyleId,
    type ThemeModeChoice,
} from './personalizeFlowModel';

/** The settings writers and stores the flow saves through. Each is an existing owner. */
export type PersonalizeFlowPorts = Readonly<{
    readAccount: () => Settings;
    readLocal: () => LocalSettings;
    /** The declared settings owner reports success only after Action admission and commit. */
    writeSetting: (write: PersonalizeSettingWrite) => Promise<boolean>;
    /** The theme owner: stores the mode and applies it to the running app. */
    applyTheme: (mode: ThemeModeChoice) => void | boolean | Promise<void | boolean>;
    readProgress: () => PersonalizeProgress;
    writeProgress: (progress: PersonalizeProgress) => void;
    /** Marks `setup:personalize` done through the Home setup owner. */
    completeSetup: () => void;
}>;

export type PersonalizeSaveResult = Readonly<{ ok: true } | { ok: false; error: unknown }>;

/**
 * What each flow action does to settings and to the visit memory. Next saves one step through its
 * writers (only what changed); Skip keeps the current values; Later keeps everything already saved;
 * "Use this setup" only marks the Home card done. Nothing is rolled back.
 */
export function createPersonalizeFlowActions(ports: PersonalizeFlowPorts) {
    return {
        /** Next on a step. A failure leaves the progress and the person's draft as they were. */
        async saveStep(step: PersonalizeStepId, draft: PersonalizeChoices): Promise<PersonalizeSaveResult> {
            try {
                const write = resolvePersonalizeStepWrite(step, draft, ports.readAccount(), ports.readLocal());
                for (const setting of write.settings) {
                    if (!await ports.writeSetting(setting)) return { ok: false, error: null };
                }
                if (write.theme && await ports.applyTheme(write.theme) === false) return { ok: false, error: null };
                ports.writeProgress(recordPersonalizeStepSaved(ports.readProgress(), step));
            } catch (error) {
                return { ok: false, error };
            }
            return { ok: true };
        },

        /** Skip (or Next on the optional style page): moves on without writing a preference. */
        skipPage(page: PersonalizePageId): void {
            ports.writeProgress(recordPersonalizePageSkipped(ports.readProgress(), page));
        },

        /** The draft after the style page: a style only pre-fills; "keep" changes nothing. */
        prefillStyle(draft: PersonalizeChoices, style: StartingStyleId | 'keep'): PersonalizeChoices {
            return style === 'keep' ? draft : applyStartingStyle(draft, style);
        },

        /** The current saved values, for a step that was skipped or a flow that is reopened. */
        readCurrentChoices(): PersonalizeChoices {
            return readPersonalizeChoices(ports.readAccount(), ports.readLocal());
        },

        /** "Use this setup": the card is done; the visit memory is no longer needed. */
        complete(): void {
            ports.completeSetup();
            ports.writeProgress(EMPTY_PERSONALIZE_PROGRESS);
        },
    };
}

export type PersonalizeFlowActions = ReturnType<typeof createPersonalizeFlowActions>;
