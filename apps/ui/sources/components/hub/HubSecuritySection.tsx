import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useAccountEncryptionMode } from '@/components/settings/account/useAccountEncryptionMode';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

/**
 * How the Account's data is protected, leading to Security. The mode is one server read through
 * its cache owner (never a machine), re-read when that owner invalidates it; the section is absent
 * until it is known, and keeps the last answer while mounted. The recovery key still to save is the
 * setup section's step, so it is not repeated here.
 */
export const HubSecuritySection = React.memo(function HubSecuritySection() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const mode = useAccountEncryptionMode();

    if (mode !== 'e2ee' && mode !== 'plain') return null;
    return (
        <ItemGroup title={t('settingsOverview.securityTitle')}>
            <Item
                testID="hub-security"
                title={mode === 'e2ee' ? t('settingsAccount.endToEndEncrypted') : t('settingsAccount.notEndToEndEncrypted')}
                icon={<Icon name="shield-check" color={theme.colors.text.secondary} />}
                onPress={() => router.push(SETTINGS_ROUTES.accountSecurity as never)}
            />
        </ItemGroup>
    );
});
