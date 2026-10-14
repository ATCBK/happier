import * as React from 'react';
import type { TeamInvitationAcceptResultV1 } from '@happier-dev/protocol/teams';

import { getCurrentAuth } from '@/auth/context/currentAuth';
import { AccountNameField } from '@/components/account/AccountNameField';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { setAccountName } from '@/sync/api/account/apiAccountName';
import {
  areServerAccountScopesEqual,
  type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import {
  resolveTeamJoinPresentation,
  shouldOfferTeamJoinName,
} from './teamJoinOutcome';

type TeamAdmissionSuccess = Extract<
  TeamInvitationAcceptResultV1,
  { outcome: 'joined' | 'already_member' }
>;

/** The synced name of exactly this Home's Account, or `null` while that profile is not the one in sync. */
function useSyncedAccountName(
  scope: ServerAccountScope | null,
): Readonly<{ name: string | null }> | null {
  const name = getStorage()((state) =>
    scope &&
    areServerAccountScopesEqual(state.profileScope, scope) &&
    state.profile.id === scope.accountId
      ? (state.profile.name ?? '')
      : undefined,
  );
  return name === undefined ? null : { name };
}

/**
 * The one "you're in" card after accepting a Team invitation.
 *
 * A fresh join by an Account with no name of its own also asks how colleagues
 * should see it; leaving the field empty simply opens the Team. The ask is
 * decided once, when the profile is first known, so a name that syncs in while
 * the card is open never makes the field vanish under the person typing.
 */
export function TeamJoinedCard(
  props: Readonly<{
    testID: string;
    result: TeamAdmissionSuccess;
    teamName: string;
    /** The Account that was admitted, on the Home that admitted it. */
    accountScope: ServerAccountScope | null;
    onOpenTeam: () => Promise<void> | void;
  }>,
): React.ReactElement {
  const syncedName = useSyncedAccountName(props.accountScope);
  const offer = shouldOfferTeamJoinName({
    outcome: props.result.outcome,
    profile: syncedName,
  });
  const [asksName, setAsksName] = React.useState<boolean | null>(() =>
    syncedName ? offer : null,
  );
  React.useEffect(() => {
    if (asksName === null && syncedName) setAsksName(offer);
  }, [asksName, offer, syncedName]);

  const [name, setName] = React.useState('');
  const [nameError, setNameError] = React.useState<string | null>(null);
  const autoFocus = useDeviceType() !== 'phone';

  const [opening, openTeam] = useHappyAction(async () => {
    if (asksName && name.trim()) {
      setNameError(null);
      try {
        const credentials = getCurrentAuth()?.credentials;
        if (!credentials) throw new Error('Account is unavailable');
        await setAccountName(credentials, name);
      } catch {
        setNameError(t('settingsAccount.nameSaveFailed'));
        return;
      }
    }
    await props.onOpenTeam();
  });

  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="success"
      title={resolveTeamJoinPresentation(props.result, props.teamName).title}
      body={
        asksName ? (
          <AccountNameField
            testID={`${props.testID}-name-field`}
            value={name}
            onChangeText={(next) => {
              setNameError(null);
              setName(next);
            }}
            supportingText={t('teams.join.nameStepReason')}
            error={nameError}
            autoFocus={autoFocus}
            editable={!opening}
            returnKeyType="go"
            onSubmitEditing={openTeam}
          />
        ) : undefined
      }
      action={{
        label: t('teams.join.openTeam', { team: props.teamName }),
        onPress: openTeam,
        busy: opening,
      }}
      accessibilitySemantics="status"
    />
  );
}
