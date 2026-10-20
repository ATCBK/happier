import * as React from 'react';
import { Button, Form, Item, ItemGroup, Select, usePluginTranslation } from '@happier-dev/plugin-ui';
import { TriageSourceInstanceConfigurationV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceSettingsSurface, type TriageSourceSettingsDraftEditorPropsV1 } from '@happier-dev/triage-sources/ui';
import { LINEAR_PLUGIN_ID, LINEAR_SERVICE_ID, LINEAR_PURPOSE, LINEAR_ACTIONS, LinearConfigurationSchema } from '../contracts.js';

function DraftEditor({ draft, busy, onSubmit, onCancel }: TriageSourceSettingsDraftEditorPropsV1): React.ReactElement {
  const text = usePluginTranslation();
  const configuration = React.useMemo(() => LinearConfigurationSchema.parse(JSON.parse(draft.configuration.token)), [draft.configuration.token]);
  const [involvement, setInvolvement] = React.useState(configuration.involvement);
  React.useEffect(() => setInvolvement(configuration.involvement), [configuration]);
  return <>
    <ItemGroup><Item title={text('plugins.linear.settings.issues', 'Issues')} fieldAccessory accessoryOutsidePressable accessory={<Select
      presentation="field" label={text('plugins.linear.settings.issues', 'Issues')} disabled={busy} value={involvement}
      options={[
        { value: 'mine', label: text('plugins.linear.settings.mine', 'My issues') },
        { value: 'assignee', label: text('plugins.linear.settings.assignee', 'Assigned to me') },
        { value: 'author', label: text('plugins.linear.settings.author', 'Created by me') },
        { value: 'subscribed', label: text('plugins.linear.settings.subscribed', 'Subscribed') },
        { value: 'everyone', label: text('plugins.linear.settings.everyone', 'All team issues') },
      ]} onChange={(value) => {
        const parsed = LinearConfigurationSchema.safeParse({ ...configuration, involvement: value });
        if (parsed.success) setInvolvement(parsed.data.involvement);
      }}
    />} /></ItemGroup>
    {/* The shared section action cluster: Save leads, Cancel follows, and a long translation wraps instead of clipping. */}
    <Form.Actions><Button title={text('plugins.linear.settings.save', 'Save')} disabled={busy} onPress={() => {
      const next = TriageSourceInstanceConfigurationV1Schema.parse({ v: 1, token: JSON.stringify({ ...configuration, involvement }) });
      void onSubmit({ ...draft, configuration: next });
    }} /><Button variant="secondary" title={text('plugins.linear.settings.cancel', 'Cancel')} disabled={busy} onPress={onCancel} /></Form.Actions>
  </>;
}

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: LINEAR_PLUGIN_ID, connectedAccountServiceLocalId: LINEAR_SERVICE_ID,
  connectedAccountPurpose: LINEAR_PURPOSE,
  listInstancesLocalActionId: LINEAR_ACTIONS.listInstances, sourceDisplayName: 'Linear',
  configuredInstanceKeyStability: 'stable',
  DraftEditor,
});
