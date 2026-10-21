import * as React from 'react';
import { View, type TextInputProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AccountUsernameCheckResponseV1 } from '@happier-dev/protocol/account/profile';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/** The service's last answer for exactly this draft; any edit makes it stale. */
export type AccountUsernameCheck = Readonly<{
  raw: string;
  result: AccountUsernameCheckResponseV1;
}>;

/**
 * The Account's username: one handle for Friends and the public page. The service decides
 * availability; this field only shows its answer for the current draft and lets a returned
 * suggestion fill the same draft. A name the service could not check stays editable and is
 * still decided by the service on Save.
 */
export function AccountUsernameField(
  props: Readonly<{
    testID: string;
    value: string;
    onChangeText: (username: string) => void;
    /** The current handle; a different draft explains what renaming changes. */
    currentUsername: string | null;
    check: AccountUsernameCheck | null;
    error?: string | null;
    editable?: boolean;
    onBlur?: () => void;
    onSubmitEditing?: () => void;
    onKeyPress?: TextInputProps['onKeyPress'];
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const draft = props.value.trim();
  const answer =
    props.check && props.check.raw === draft ? props.check.result : null;
  const available = answer?.availability === 'available';
  const renaming =
    props.currentUsername !== null &&
    draft.length > 0 &&
    draft !== props.currentUsername;
  const supporting =
    !answer || available ? (
      renaming ? (
        t('publicIdentity.handle.renameConsequence', { username: props.currentUsername! })
      ) : undefined
    ) : (
      <UsernameAnswer
        answer={answer}
        onSelect={props.onChangeText}
        testID={props.testID}
      />
    );
  return (
    <FieldItem label={t('profile.username')} supportingText={supporting}>
      <FieldTextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChangeText}
        accessibilityLabel={t('profile.username')}
        error={props.error}
        invalid={answer !== null && !available}
        autoCapitalize="none"
        autoComplete="username"
        editable={props.editable}
        onBlur={props.onBlur}
        onSubmitEditing={props.onSubmitEditing}
        onKeyPress={props.onKeyPress}
        trailing={
          available ? (
            <View
              testID={`${props.testID}-available`}
              accessible
              accessibilityLabel={t('publicIdentity.handle.available', {
                username: answer.username,
              })}
              style={styles.available}
            >
              <Icon
                name="check"
                size={14}
                color={theme.colors.text.secondary}
              />
            </View>
          ) : undefined
        }
      />
    </FieldItem>
  );
}

function UsernameAnswer(
  props: Readonly<{
    answer: AccountUsernameCheckResponseV1;
    onSelect: (username: string) => void;
    testID: string;
  }>,
) {
  const { answer } = props;
  const message =
    answer.availability === 'reserved'
      ? t('publicIdentity.handle.reserved', { username: answer.username })
      : answer.availability === 'invalid'
        ? t('publicIdentity.handle.invalid')
        : t('publicIdentity.handle.taken', { username: answer.username });
  return (
    <View style={styles.answer} testID={`${props.testID}-answer`}>
      <Text variant="meta" style={styles.meta} accessibilityLiveRegion="polite">
        {message}
      </Text>
      {answer.suggestions.length > 0 ? (
        <View style={styles.suggestions}>
          <Text variant="meta" style={styles.meta}>{t('publicIdentity.handle.suggestions')}</Text>
          {answer.suggestions.map((suggestion) => (
            <TextLinkButton
              key={suggestion}
              testID={`${props.testID}-suggestion-${suggestion}`}
              size="meta"
              tone="strong"
              label={suggestion}
              onPress={() => props.onSelect(suggestion)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  available: { paddingHorizontal: theme.space.s4 },
  answer: { gap: theme.space.s4, marginTop: theme.space.s4 },
  meta: { color: theme.colors.text.secondary },
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
    rowGap: theme.space.s4,
  },
}));
