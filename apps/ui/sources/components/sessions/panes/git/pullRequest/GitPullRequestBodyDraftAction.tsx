import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** Runs a press handler once at a time: a second press while the first is settling does nothing. */
function useSettledPress(run: (() => Promise<void> | void) | undefined) {
  const [settling, setSettling] = React.useState(false);
  const press = React.useCallback(() => {
    if (!run || settling) return;
    setSettling(true);
    void Promise.resolve(run()).finally(() => setSettling(false));
  }, [run, settling]);
  return { settling, press };
}

/**
 * The form's "Write description" control and what its pending request is doing.
 *
 * Healthy pending shows the busy control with one quiet Cancel beside it (present only while a matching Run can be
 * stopped). When the Machine may never have received the request, nothing is being written: the control and Cancel go
 * away and one notice says so, with a single way to check again. Checking never starts a second request.
 */
export const GitPullRequestBodyDraftAction = React.memo(
  function GitPullRequestBodyDraftAction(
    props: Readonly<{
      drafting: boolean;
      canDraft: boolean;
      /** Why drafting cannot run right now, when it cannot. */
      prerequisite: string | null;
      /** The request is pending and the Machine may never have received it. */
      uncertain: boolean;
      /** The last check's failure: shown in the notice in place of the generic reason, so the form adds no second message. */
      message: string | null;
      onDraft: () => void;
      onCheckAdmission: () => Promise<void> | void;
      /** Present only with a matching Run. */
      onCancel?: () => Promise<void> | void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const check = useSettledPress(props.onCheckAdmission);
    const cancel = useSettledPress(props.onCancel);

    if (props.uncertain) {
      return (
        <AttentionBanner
          presentation="strip"
          tone="warning"
          iconName="question"
          testID="git-pull-request-form-draft-body-unknown"
          title={t('sessionGitPullRequest.form.bodyUnknown')}
          description={
            props.message ?? t('sessionGitPullRequest.form.bodyUnknownReason')
          }
          secondaryAction={{
            testID: 'git-pull-request-form-draft-body-check',
            label: t('sessionGitPullRequest.form.checkAgain'),
            onPress: check.press,
            disabled: check.settling,
          }}
        />
      );
    }

    return (
      <View style={styles.row}>
        <ToolbarButton
          testID="git-pull-request-form-draft-body"
          label={
            props.drafting
              ? t('sessionGitPullRequest.form.writingBody')
              : t('sessionGitPullRequest.form.writeBody')
          }
          icon={
            <Icon
              name="sparkle"
              size={14}
              color={theme.colors.text.secondary}
            />
          }
          size="sm"
          busy={props.drafting}
          disabled={!props.canDraft}
          onPress={props.onDraft}
        />
        {props.drafting && props.onCancel ? (
          <ToolbarButton
            testID="git-pull-request-form-draft-body-cancel"
            label={t('common.cancel')}
            size="sm"
            disabled={cancel.settling}
            onPress={cancel.press}
          />
        ) : null}
        {props.prerequisite ? (
          <Text
            testID="git-pull-request-form-draft-body-unavailable"
            style={styles.note}
            numberOfLines={2}
          >
            {props.prerequisite}
          </Text>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  note: {
    flex: 1,
    minWidth: 0,
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
