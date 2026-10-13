import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { profileDefaults } from '@/sync/domains/profiles/profile';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({ storage: 'real' });

const { AccountSignInSecuritySection } = await import('./AccountSignInSecuritySection');

describe('AccountSignInSecuritySection while the Account Security facts load', () => {
    it('reserves the recovery-key row as a quiet busy placeholder and prints no "Loading…" value', async () => {
        const screen = await renderScreen(
            <AccountSignInSecuritySection
                homeName="Studio"
                security={{ kind: 'loading' }}
                profile={{ ...profileDefaults, id: 'prof_1' }}
                credentials={null}
                applyProfile={() => {}}
            />,
        );
        expect(screen.findHostByTestId('settings-account-recovery-key-loading')?.props.accessibilityState).toEqual({ busy: true });
        expect(screen.findByTestId('settings-account-email-password')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('common.loading');
    });
});
