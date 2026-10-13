import * as React from 'react';

import type {
    ImportedMcpInputDefinitionV1,
} from '@happier-dev/protocol/mcp/servers/import/parseMcpServerImportV1';
import type { ImportedMcpInputResolutionV1 } from '@/sync/domains/settings/mcpServers/mcpImportActionInputs';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

type InputMode = ImportedMcpInputResolutionV1['mode'];

/**
 * One section per input an imported server asks for: where its value comes from (a new Saved Secret
 * or a variable already set on the machine), then the fields that choice needs. A secret value is
 * entered here once and saved as a Saved Secret; it is never shown again.
 */
export const McpInputMappingEditor = React.memo(function McpInputMappingEditor(props: Readonly<{
    inputs: readonly ImportedMcpInputDefinitionV1[];
    mappings: Record<string, ImportedMcpInputResolutionV1>;
    onChangeMapping: (inputId: string, next: ImportedMcpInputResolutionV1) => void;
}>) {
    if (props.inputs.length === 0) return null;

    return (
        <>
            {props.inputs.map((input) => {
                const mapping = props.mappings[input.inputId];
                const mode: InputMode = mapping?.mode ?? (input.secret ? 'savedSecret' : 'machineEnv');
                const secretKind = mapping?.mode === 'savedSecret' ? mapping.secretKind : (input.secret ? 'token' : 'other');
                const secretName = mapping?.mode === 'savedSecret' ? mapping.secretName : input.title;
                const secretValue = mapping?.mode === 'savedSecret' ? mapping.secretValue : '';
                return (
                    <ItemGroup key={input.inputId} title={input.title} description={input.description || undefined}>
                        <SegmentedChoiceItem<InputMode>
                            testID={`mcp.server.importInput.${input.inputId}.mode`}
                            testIDPrefix={`mcp.server.importInput.${input.inputId}.mode`}
                            title={t('settings.mcpServersValueSourceTitle')}
                            value={mode}
                            options={[
                                { id: 'savedSecret', label: t('settings.mcpServersImportMappingSavedSecret'), description: t('settings.mcpServersValueSourceSavedSecretSubtitle') },
                                { id: 'machineEnv', label: t('settings.mcpServersImportMappingMachineEnv') },
                            ]}
                            onChange={(candidateMode) => props.onChangeMapping(
                                input.inputId,
                                candidateMode === 'savedSecret'
                                    ? { mode: 'savedSecret', secretName: input.title, secretValue: '', secretKind: input.secret ? 'token' : 'other' }
                                    : { mode: 'machineEnv', envVarName: input.suggestedEnvVarName },
                            )}
                        />
                        {mode === 'savedSecret' ? (
                            <>
                                <Item
                                    title={t('secrets.fields.name')}
                                    accessoryLayout="adaptive"
                                    showChevron={false}
                                    rightElement={(
                                        <FieldTextInput
                                            value={secretName}
                                            onChangeText={(value) => props.onChangeMapping(input.inputId, {
                                                mode: 'savedSecret', secretName: value, secretValue, secretKind,
                                            })}
                                            accessibilityLabel={t('settings.mcpServersImportSecretNamePlaceholder')}
                                            placeholder={t('settings.mcpServersImportSecretNamePlaceholder')}
                                            autoCapitalize="words"
                                        />
                                    )}
                                />
                                <Item
                                    title={t('secrets.fields.value')}
                                    accessoryLayout="adaptive"
                                    showChevron={false}
                                    rightElement={(
                                        <FieldTextInput
                                            value={secretValue}
                                            onChangeText={(value) => props.onChangeMapping(input.inputId, {
                                                mode: 'savedSecret', secretName, secretValue: value, secretKind,
                                            })}
                                            accessibilityLabel={t('settings.mcpServersImportSecretValuePlaceholder')}
                                            placeholder={t('settings.mcpServersImportSecretValuePlaceholder')}
                                            secureTextEntry
                                            monospace
                                        />
                                    )}
                                />
                            </>
                        ) : (
                            <Item
                                title={t('settings.mcpServersImportMachineEnvPlaceholder')}
                                accessoryLayout="adaptive"
                                showChevron={false}
                                rightElement={(
                                    <FieldTextInput
                                        value={mapping?.mode === 'machineEnv' ? mapping.envVarName : input.suggestedEnvVarName}
                                        onChangeText={(value) => props.onChangeMapping(input.inputId, { mode: 'machineEnv', envVarName: value })}
                                        accessibilityLabel={t('settings.mcpServersImportMachineEnvPlaceholder')}
                                        placeholder={t('settings.mcpServersImportMachineEnvPlaceholder')}
                                        autoCapitalize="characters"
                                        monospace
                                    />
                                )}
                            />
                        )}
                    </ItemGroup>
                );
            })}
        </>
    );
});
