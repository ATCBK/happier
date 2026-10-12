import * as React from 'react';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { HOME_WORKOS_SETUP_SETTINGS, TEAM_WORKOS_SETUP_SETTINGS } from './teamAuthenticationSettings';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';
import { createIdentityAdministrationClient } from './identityAdministrationClient';
import { useIdentityAdministration } from './useIdentityAdministration';
import {
    eligibleProviderFixHref,
    eligibleProviderFixLabel,
    eligibleProviderUnavailableReason,
    resolveEligibleProviderRecovery,
    useEligibleProviderRecoveryViewer,
} from './eligibleProviderAvailability';
import { askAdministratorsText } from '../collection/teamsCreateGuidanceText';
import { WorkosMark } from '@/components/settings/identity/WorkosMark';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { t } from '@/text';

/** One draft-creation entry for the Home and Team scopes, using the same server-owned eligibility. */
export function IdentityWorkosSetupContent(props: Readonly<{
    scope: ServerAccountScope;
    teamId: string | null;
    homeName?: string;
    conditionBanners?: React.ReactNode;
    mutationsAvailable: boolean;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
    onCreated: (connectionId: string) => void;
}>) {
    const router = useRouter();
    const { state, refresh } = useIdentityAdministration(props.scope, props.teamId, props.requestApproval);
    const client = React.useMemo(() => createIdentityAdministrationClient(props.scope, { onApprovalPending: props.requestApproval }), [props.scope.serverId, props.scope.accountId, props.requestApproval]);
    const [displayName, setDisplayName] = React.useState('');
    const [pending, setPending] = React.useState(false);
    const [failure, setFailure] = React.useState<string | null>(null);
    const choice = state.kind === 'ready' ? state.eligibleProviders.find((provider) => provider.providerKind === 'workos_sso' && provider.providerId === null) : undefined;
    const eligible = choice?.availability.status === 'available' && choice.availability.setupChoice.kind === 'create_managed';
    const canCreate = props.mutationsAvailable && state.kind === 'ready' && !state.refreshing && !state.stale && eligible;
    const create = async () => {
        if (!canCreate || pending || !displayName.trim()) return;
        setPending(true); setFailure(null);
        try {
            const result = await client.execute('teams.identity.workos.connection.create', { v: 1, teamId: props.teamId, displayName: displayName.trim() }, {
                onApprovalSucceeded: (value) => props.onCreated(value.connection.id),
                onApprovalFailed: setFailure,
            });
            if (result.ok) props.onCreated(result.value.connection.id);
            else if (!('approvalPending' in result)) setFailure(result.failure.code);
        } catch { setFailure('home_unreachable'); }
        finally { setPending(false); }
    };
    const settings = props.teamId === null ? HOME_WORKOS_SETUP_SETTINGS : TEAM_WORKOS_SETUP_SETTINGS;
    const recoveryViewer = useEligibleProviderRecoveryViewer(props.scope);
    // A connection that cannot be created is not offered as a form (craft: never show a form that
    // cannot succeed). The page says why in the Home's words and leads to the fix or names who can.
    const blocked = state.kind === 'ready' && !eligible;
    const recovery = blocked && choice ? resolveEligibleProviderRecovery(choice, recoveryViewer) : null;
    const fix = recovery?.kind === 'fix_on_home' && choice
        ? { href: eligibleProviderFixHref(props.scope.serverId, choice, recovery.destination), label: eligibleProviderFixLabel(recovery.destination) }
        : null;
    const blockedReason = blocked
        ? (choice ? eligibleProviderUnavailableReason(choice, props.homeName ?? '', t('identityAdministration.homeWorkosAdd')) : null) ?? t('identityAdministration.errorSetupRequired')
        : null;
    return <><PageHeader
            leading={<PageHeaderMarkSlot><WorkosMark /></PageHeaderMarkSlot>}
            title={t('identityAdministration.homeWorkosAdd')}
            // The page's purpose; the portal step's own instruction belongs to the step, not the header.
            description={props.teamId === null ? t('identityAdministration.homeWorkosPurpose') : t('teams.pages.identityProviderNew')}
            // The page's one decision is creating the connection, so it is the header's primary, as on
            // every other "new" page (New Team). It waits for a name and for the Home to allow it.
            primaryAction={blocked ? undefined : {
                title: t('identityAdministration.add'),
                testID: 'identity-workos-create',
                loading: pending,
                disabled: !canCreate || !displayName.trim() || pending,
                onPress: () => void create(),
            }}
        />
        {props.conditionBanners}
        <SettingSection section={settings.sectionRefs.configuration}>{blocked ? (
            <SurfaceStateCard
                testID="identity-workos-unavailable"
                kind="unavailable"
                size="pane"
                title={blockedReason ?? ''}
                reason={recovery?.kind === 'ask' ? askAdministratorsText(recovery.names) ?? undefined : undefined}
                action={fix ? { label: fix.label, onPress: () => router.push(fix.href), testID: 'identity-workos-fix' } : undefined}
            />
        ) : /* Search for "Add connection" lands on the form its header primary submits. */ <SettingAnchor setting={settings.settings.create}><ItemGroup>
            {state.kind === 'loading' ? <SurfaceStateCard kind="loading" size="line" title={t('common.loading')} /> : null}
            {state.kind === 'unavailable' ? <SurfaceStateCard kind="error" size="line" title={identityAdministrationFailureMessage(state.failure.code)} action={state.failure.retryable ? { label: t('common.retry'), onPress: refresh } : undefined} /> : null}
            {state.kind === 'ready' && state.failure ? <SurfaceStateCard kind="error" size="line" title={identityAdministrationFailureMessage(state.failure.code)} action={{ label: t('common.retry'), onPress: refresh }} /> : null}
            <SettingRow setting={settings.settings.companyName} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="identity-workos-company-name" accessibilityLabel={t('identityAdministration.homeWorkosCompanyName')} value={displayName} editable={canCreate && !pending} onChangeText={setDisplayName} onSubmitEditing={() => void create()} autoCapitalize="words" />} />
            {failure ? <SurfaceStateCard testID="identity-workos-create-failure" kind="error" size="line" title={identityAdministrationFailureMessage(failure)} /> : null}
        </ItemGroup></SettingAnchor>}</SettingSection></>;
}
