import { describe, expect, it } from 'vitest';

import { en } from './translations/en';
import { hasTranslation, t, tLoose, type TranslationKey } from './i18n';

const declaredPluginTranslationKey: TranslationKey = 'plugins.inspector.title';
const declaredAgentConnectedServiceKey: TranslationKey = 'agentInput.connectedServiceLabel.gemini';
// @ts-expect-error Plugin-local keys remain closed to manifest-declared generated translations.
const undeclaredPluginTranslationKey: TranslationKey = 'plugins.fixture.undeclared';
void undeclaredPluginTranslationKey;

describe('text/i18n', () => {
    it('translates the default language and nested function entries', () => {
        expect(t('tabs.inbox')).toBe(en.tabs.inbox);
        expect(t('promptLibrary.profileStacksSubtitle', { count: 2 })).toBe(en.promptLibrary.profileStacksSubtitle({ count: 2 }));
        expect(tLoose('tabs.inbox')).toBe(en.tabs.inbox);
    });

    it('pluralizes the review completion suffix by the total engines being counted', () => {
        // The suffix follows “0 of 1”, so the total determines singular/plural.
        expect(t('reviewWalkthrough.enginesFinished', { count: 1 })).toBe('engine finished');
        expect(t('reviewWalkthrough.enginesFinished', { count: 2 })).toBe('engines finished');
    });

    it('resolves manifest-declared bundled plugin translations', () => {
        expect(t(declaredPluginTranslationKey)).toBe('Plugin Inspector');
        expect(hasTranslation(declaredPluginTranslationKey)).toBe(true);
        expect(t(declaredAgentConnectedServiceKey)).toBe('Google Gemini');
        expect(hasTranslation(declaredAgentConnectedServiceKey)).toBe(true);
    });

    it('capitalizes the stand-in for a locked machine only where it starts the sentence', () => {
        const machine = t('machine.thisMachineInSentence');
        expect(t('machineAttention.phrases.memoryCritical', { machine })).toBe('This machine is short on memory');
        expect(t('machineDetailPage.terminalSheetWaitingTitle', { machine })).toBe('Unlocking this machine');
        // A machine's own name is never re-cased.
        expect(t('machineAttention.phrases.memoryCritical', { machine: 'leeroy-mbp' })).toBe('leeroy-mbp is short on memory');
    });

    it('reports missing keys without throwing', () => {
        expect(hasTranslation('tabs.inbox')).toBe(true);
        expect(hasTranslation('not.a.real.key')).toBe(false);
        expect(tLoose('not.a.real.key')).toBe('not.a.real.key');
    });
});
