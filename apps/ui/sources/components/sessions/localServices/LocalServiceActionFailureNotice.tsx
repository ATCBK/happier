import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';

import type { LocalServiceActionFailure } from './localServiceActionOutcome';

/**
 * A refused service action, read in place on the row it belongs to: the person-facing reason first,
 * the codes behind Details, and the one next step. It is the inline form of
 * `presentLocalServiceActionFailure`; both draw their words from `describeLocalServiceActionFailure`.
 *
 * The next step is Retry for the same action, or the caller's better one (the same project's running
 * instance to open when a start collided with it).
 */
export function LocalServiceActionFailureNotice(
  props: Readonly<{
    failure: LocalServiceActionFailure;
    /** A better way forward than repeating the action; replaces Retry. */
    nextAction?: Readonly<{ label: string; onPress: () => void }> | null;
    onDismiss: () => void;
    testID: string;
  }>,
): React.ReactElement {
  const { failure } = props;
  return (
    <View style={styles.root}>
      <AttentionBanner
        testID={props.testID}
        placement="inline"
        tone={failure.refusal ? 'warning' : 'danger'}
        title={failure.title}
        description={failure.body}
        details={failure.details}
        action={
          props.nextAction
            ? {
                label: props.nextAction.label,
                onPress: props.nextAction.onPress,
                testID: `${props.testID}.action`,
              }
            : failure.retry ? {
                label: t('common.retry'),
                onPress: failure.retry,
                testID: `${props.testID}.action`,
              } : undefined
        }
        announce="alert"
        onDismiss={failure.retry ? props.onDismiss : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s12 },
}));
