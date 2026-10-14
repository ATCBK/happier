import * as React from 'react';
import type { TextInputProps } from 'react-native';

import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { t } from '@/text';

/**
 * The Account's own Name field: how people the Account works with see it. One field for every place
 * that asks for a name (Settings → Account, the joined-Team card), so its label, hint, autofill and
 * capitalisation never drift apart. The caller owns the draft, the save and where Return goes.
 */
export function AccountNameField(
  props: Readonly<{
    testID: string;
    value: string;
    onChangeText: (name: string) => void;
    /** Why the name is asked for here, under the field. */
    supportingText?: string;
    error?: string | null;
    editable?: boolean;
    autoFocus?: boolean;
    returnKeyType?: TextInputProps['returnKeyType'];
    onSubmitEditing?: () => void;
    onKeyPress?: TextInputProps['onKeyPress'];
  }>,
): React.ReactElement {
  return (
    <FieldItem
      label={t('settingsAccount.nameLabel')}
      supportingText={props.supportingText}
    >
      <FieldTextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChangeText}
        accessibilityLabel={t('settingsAccount.nameLabel')}
        placeholder={t('settingsAccount.namePlaceholder')}
        error={props.error}
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        autoFocus={props.autoFocus}
        editable={props.editable}
        returnKeyType={props.returnKeyType}
        onSubmitEditing={props.onSubmitEditing}
        onKeyPress={props.onKeyPress}
      />
    </FieldItem>
  );
}
