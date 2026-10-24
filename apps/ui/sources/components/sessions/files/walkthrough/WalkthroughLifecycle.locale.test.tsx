import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text/i18n';
import type { WalkthroughInventoryRow } from './walkthroughReading';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
const { WalkthroughInventory } = await import('./WalkthroughLifecycle');
const originalLanguage = getPreferredLanguage();
afterEach(() => { standardCleanup(); setPreferredLanguageFromSettings(originalLanguage); });

it('updates the running inventory after the language changes with stable rows', async () => {
    setPreferredLanguageFromSettings('en');
    const rows: readonly WalkthroughInventoryRow[] = [{ path: 'access.ts', changeKind: 'modified',
        added: 2, removed: 1, generated: false, lockfile: false, reading: 'reading' }];
    const screen = await renderScreen(<WalkthroughInventory rows={rows} />);
    const strings = () => screen.findAll(node => typeof node.type === 'string')
        .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
    expect(strings()).toContain(t('walkthrough.inventory.reading'));
    await act(async () => { await preloadTranslations('fr'); setPreferredLanguageFromSettings('fr'); });
    await screen.update(<WalkthroughInventory rows={rows} />);
    expect(strings()).toContain(t('walkthrough.inventory.title'));
    expect(strings()).toContain(t('walkthrough.inventory.reading'));
    expect(strings()).not.toContain('Reading');
});
