import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useAuth } from '@/auth/context/AuthContext';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { setAccountName } from '@/sync/api/account/apiAccountName';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { isAccountMissingOwnName } from '@/sync/domains/account/accountOwnName';
import { t } from '@/text';

import { AccountNameField } from './AccountNameField';
import { useSyncedAccountName } from './useSyncedAccountName';

/** The Home setup step id; a dismissal keeps `setup:addName` on the Account's Home layout. */
export const ADD_NAME_SETUP_STEP_ID = 'addName';

/**
 * "Add your name" as a Get set up block: offered while the Account in sync has no name of its own
 * (`isAccountMissingOwnName`, the rule the joined-Team card shares). Add name grows the block in
 * place into the shared Name field; saving uses the Account's name writer, so a name set anywhere
 * (Settings, a Team join, an Action, another device) removes the block. Not now, or the block's ✕,
 * hides the step on the Account layout like every other setup step (Customize brings it back).
 */
export function useAddNameSetupItem(
  input: Readonly<{
    layout: 'card' | 'row';
    hidden: ReadonlySet<string>;
    onDismiss: (stepId: string) => void;
  }>,
): SetupBlockItem | null {
  const missing = isAccountMissingOwnName(useSyncedAccountName());
  if (!missing || input.hidden.has(ADD_NAME_SETUP_STEP_ID)) return null;
  const title = t('settingsAccount.addName');
  const dismiss = () => input.onDismiss(ADD_NAME_SETUP_STEP_ID);
  return {
    id: ADD_NAME_SETUP_STEP_ID,
    renderTile: ({ open }) => (
      <SetupBlockTile
        testID="hub-setup.addName"
        layout={input.layout}
        icon="user-circle"
        title={title}
        subtitle={t('homeSetup.addNameSubtitle')}
        action={{
          label: t('homeSetup.addNameAction'),
          testID: 'hub-setup.addName.action',
          onPress: open,
        }}
        dismiss={{
          label: t('homeSetup.dismiss', { title }),
          tooltip: t('homeSetup.dismissTooltip'),
          onPress: dismiss,
        }}
      />
    ),
    renderPanel: ({ close }) => (
      <AddNamePanel
        autoFocus={input.layout === 'card'}
        onSaved={close}
        onNotNow={dismiss}
      />
    ),
  };
}

/** The block grown in place: why, the Name field, Save and Not now. */
function AddNamePanel(
  props: Readonly<{
    autoFocus: boolean;
    onSaved: () => void;
    onNotNow: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const testID = 'hub-setup.addName-panel';
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const auth = useAuth();
  // The same mounted execution Settings → Account saves through, so an approval keeps this save.
  const accountExecution = useMountedActionExecution(useAccountSettingsScope());
  const [saving, save] = useHappyAction(async () => {
    if (!name.trim()) return;
    setError(null);
    try {
      if (!auth.credentials) throw new Error('Account is unavailable');
      await setAccountName(auth.credentials, name, accountExecution);
    } catch {
      setError(t('settingsAccount.nameSaveFailed'));
      return;
    }
    props.onSaved();
  });
  return (
    <View testID={testID} style={styles.panel}>
      <Icon name="user-circle" size={20} color={theme.colors.text.secondary} />
      <View style={styles.text}>
        <Text accessibilityRole="header" style={styles.title}>
          {t('settingsAccount.addName')}
        </Text>
        <Text style={styles.body}>{t('homeSetup.addNameSubtitle')}</Text>
      </View>
      <View style={styles.field}>
        <AccountNameField
          testID={`${testID}.field`}
          value={name}
          onChangeText={(next) => {
            setError(null);
            setName(next);
          }}
          error={error}
          autoFocus={props.autoFocus}
          editable={!saving}
          returnKeyType="done"
          onSubmitEditing={save}
        />
      </View>
      <View style={styles.actions}>
        <RoundButton
          testID={`${testID}.save`}
          size="small"
          title={t('common.save')}
          onPress={save}
          loading={saving}
          disabled={!name.trim() || !accountExecution.ready}
        />
        <RoundButton
          testID={`${testID}.not-now`}
          size="small"
          display="inverted"
          title={t('homeSetup.notNow')}
          onPress={props.onNotNow}
          disabled={saving}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    padding: theme.space.s20,
    gap: theme.space.s10,
  },
  text: {
    gap: theme.space.s4,
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('pageTitle'),
    color: theme.colors.text.primary,
  },
  body: {
    ...Typography.default(),
    ...happierPageTextMetrics('pageDescription'),
    color: theme.colors.text.secondary,
  },
  field: {
    maxWidth: 420,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingTop: theme.space.s6,
  },
}));
