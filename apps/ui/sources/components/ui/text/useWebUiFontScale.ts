import * as React from 'react';
import { Platform } from 'react-native';

import { useLocalSetting } from '@/sync/store/settingsReadHooks';

import {
    observeDocumentUnistylesFontMetrics,
    setRootCssVar,
} from './webUnistylesFontOverrides';

/**
 * Web-only: Unistyles compiles many font-related styles into static CSS classes (no numeric `fontSize`
 * values remain in React `style` props), so per-component JS scaling cannot reliably adjust font sizes.
 *
 * This hook:
 * - sets a root CSS variable for the chosen UI font scale
 * - generates an override stylesheet that scales `.unistyles_*` font rules via `calc(... * var(--scale))`
 * - keeps the override sheet up-to-date as new Unistyles classes are injected at runtime
 */
export function useWebUiFontScale() {
    const scale = useLocalSetting('uiFontScale');

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;

        return observeDocumentUnistylesFontMetrics(document);
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;
        setRootCssVar(document, scale);
    }, [scale]);
}
