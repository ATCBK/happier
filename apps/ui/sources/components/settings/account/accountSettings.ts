import { directConnectionsStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { combineClientEncryptionRequirements } from '@happier-dev/protocol/encryption/clientEncryptionRequirement';

/** Account's searchable settings. Rows render their labels from these declarations. */
export const ACCOUNT_SETTINGS = defineSettingsPage({
    pageId: 'account',
    sections: {
        encryption: {
            titleKey: 'terminal.encryption',
            featureId: 'encryption.accountOptOut',
            settings: {
                encryptionMode: {
                    operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: true,
                        async invoke(context) {
                            if (context.input?.kind !== 'account_encryption_mode_convert') return { status: 'unavailable', reason: 'invalid_encryption_operation' };
                            const convert = context.services?.convertAccountEncryptionMode;
                            if (!convert || !context.isCurrent()) return { status: 'unavailable', reason: 'encryption_transport_unavailable' };
                            return convert(context.input.toMode, context.signal);
                        },
                    },
                },
                requireE2ee: {
                    storage: { scope: 'account', kind: 'owner', access: 'read_write',
                        read: settings => combineClientEncryptionRequirements(settings.clientEncryptionRequirementV1,
                            settings.clientEncryptionRequirementLocalV1) === 'require_e2ee',
                        parse: value => typeof value === 'boolean' ? { success: true, value } : { success: false },
                        // This client-owned intent also orders the scoped local minimum around the Account CAS.
                        mutate: () => null,
                    },
                },
            },
        },
        signIn: {
            titleKey: 'settingsAccount.security',
            settings: {
                emailPassword: {},
            },
        },
        accountService: {
            settings: {
                accountService: {},
            },
        },
        connections: {
            titleKey: 'settingsConnections.sectionTitle',
            settings: {
                directConnections: {
                    storage: directConnectionsStorage,

                },
            },
        },
        privacy: {
            titleKey: 'settingsAccount.privacy',
            settings: {
                analytics: {},
                crashReports: {},
                settingsHistory: {
                    operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: true,
                        async invoke(context) {
                            if (context.input?.kind === 'account_settings_history_restore') {
                                const restore = context.services?.restoreAccountSettingsHistory;
                                if (!restore || !context.isCurrent()) return { status: 'unavailable', reason: 'history_transport_unavailable' };
                                return restore(context.input, context.signal);
                            }
                            if (context.input?.kind !== 'account_settings_history_purge') return { status: 'unavailable', reason: 'invalid_history_operation' };
                            const purge = context.services?.purgeAccountSettingsHistory;
                            if (!purge || !context.isCurrent()) return { status: 'unavailable', reason: 'history_transport_unavailable' };
                            const result = await purge(context.input.versions, context.signal);
                            return result.status === 'complete' ? { status: 'completed', value: { versions: [...context.input.versions] } }
                                : { status: 'unavailable', reason: 'history_cleanup_pending', value: { versions: [...result.versions] } };
                        },
                    },
                },
            },
        },
    },
});
