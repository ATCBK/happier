import * as React from 'react';
import { View } from 'react-native';
import { HappierLink } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { ProviderExternalLink } from '../ProviderExternalLinkItem';
import { ProviderSavedSecretControl } from '../ProviderPageParts';

/**
 * The API key of a provider being added, asked for where it is needed (PA1). With no saved key
 * chosen it is a masked field whose value becomes a Saved Secret when the provider is saved, with
 * "Get API key" and "Use a saved key" beneath it; once a saved key is chosen, or when this Account
 * cannot offer one, it is that key's name and Replace. One row for catalog and custom providers.
 */
export function ProviderKeyEntryItem(
  props: Readonly<{
    /** What the key is for, said while the Account can save one. */
    description: string;
    placeholder: string;
    pastedKey: string;
    onPastedKeyChange: (value: string) => void;
    /** Enter in the field: the page's save. */
    onSubmit: () => void;
    keyUrl?: string | null;
    secretSelected: boolean;
    selectedSecretName?: string | null;
    savedSecretSelectionEnabled: boolean;
    onPickSecret: () => void;
    savePending: boolean;
    /** The key is the sheet's first question (a catalog provider); a custom one asks its name first. */
    autoFocus?: boolean;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const presentationTheme = usePluginUiTheme(theme);
  const title = t('settingsProviders.authoring.apiKey');
  if (!props.secretSelected && props.savedSecretSelectionEnabled) {
    return (
      <Item
        testID="settings-provider-authoring-api-key"
        title={title}
        subtitle={props.description}
        subtitleLines={0}
        showChevron={false}
        accessoryLayout="stacked"
        rightElement={
          <View style={styles.keyEntry}>
            <FieldTextInput
              testID="settings-provider-authoring-api-key.field"
              value={props.pastedKey}
              onChangeText={props.onPastedKeyChange}
              accessibilityLabel={title}
              placeholder={props.placeholder}
              secureTextEntry
              monospace
              autoFocus={props.autoFocus}
              autoComplete="off"
              returnKeyType="done"
              editable={!props.savePending}
              onSubmitEditing={props.onSubmit}
            />
            <View style={styles.keyLinks}>
              {props.keyUrl ? (
                <ProviderExternalLink kind="getApiKey" url={props.keyUrl} />
              ) : null}
              <HappierLink
                testID="settings-provider-authoring-api-key.useSaved"
                label={t('settingsProvidersCollection.useSavedKey')}
                onPress={props.onPickSecret}
                theme={presentationTheme}
              >
                {t('settingsProvidersCollection.useSavedKey')}
              </HappierLink>
            </View>
          </View>
        }
        rightElementOutsidePressable
      />
    );
  }
  return (
    <Item
      testID="settings-provider-authoring-api-key"
      title={title}
      subtitle={
        props.savedSecretSelectionEnabled
          ? props.description
          : t('settingsProviders.local.accountScopeMismatchDescription')
      }
      subtitleLines={0}
      showChevron={false}
      rightElement={
        <ProviderSavedSecretControl
          testID="settings-provider-authoring-api-key"
          saved={props.secretSelected}
          selectedName={props.selectedSecretName}
          disabled={!props.savedSecretSelectionEnabled}
          onChoose={props.onPickSecret}
        />
      }
      rightElementOutsidePressable
    />
  );
}

const styles = StyleSheet.create((theme) => ({
    keyEntry: {
        alignSelf: 'stretch',
        gap: theme.space.s10,
    },
    keyLinks: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s16,
        rowGap: theme.space.s6,
    },
}));
