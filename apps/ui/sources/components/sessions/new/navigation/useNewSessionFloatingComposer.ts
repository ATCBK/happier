import { Platform } from 'react-native';

import { useSetting } from '@/sync/domains/state/storage';

import { isNewSessionFloatingComposerPresentation } from './newSessionPresentation';

/**
 * Whether the `/new` route shows the bare floating composer, read from the same settings the root
 * layout uses to choose the route's presentation. Embedded hosts (Home) never float.
 */
export function useNewSessionFloatingComposer(presentation: 'screen' | 'embedded' = 'screen'): boolean {
    const mode = useSetting('newSessionPresentationModeV1');
    const variant = useSetting('useEnhancedSessionWizard') ? 'wizard' : 'simple';
    return presentation === 'screen'
        && isNewSessionFloatingComposerPresentation({ mode, variant, platformOs: Platform.OS });
}
