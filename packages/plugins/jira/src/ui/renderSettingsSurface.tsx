import * as React from 'react';
import { Button, ErrorState, Form, Item, ItemGroup, LoadingState, Select, useExecutePluginAction, usePluginTranslation } from '@happier-dev/plugin-ui';
import { createTriageSourceSettingsSurface, type TriageSourceSettingsDraftEditorPropsV1 } from '@happier-dev/triage-sources/ui';
import { triageSourceBindingComponentsV1 } from '@happier-dev/triage-protocol/v1';
import { JIRA_PLUGIN_ID, JIRA_ACCOUNT_PURPOSE, JIRA_ACTIONS } from '../contracts.js';
import { JiraConfigurationSchema, JiraIssueTypesResultSchema, type JiraConfiguration, type JiraIssueTypesResult } from '../source/configurationContract.js';

const issueTypesAction = { pluginId: JIRA_PLUGIN_ID, localId: JIRA_ACTIONS.issueTypes };
function ReadyEditor({ draft, busy, onSubmit, onCancel, configuration }: TriageSourceSettingsDraftEditorPropsV1 & { configuration: JiraConfiguration }): React.ReactElement {
    const text = usePluginTranslation();
    const [involvement, setInvolvement] = React.useState(configuration.involvement);
    const [issueTypeId, setIssueTypeId] = React.useState(configuration.issueTypeId ?? '');
    const [directory, setDirectory] = React.useState<{ request: unknown; result: JiraIssueTypesResult }>();
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const { execute } = useExecutePluginAction(issueTypesAction);
    const request = React.useMemo(() => ({ binding: draft.binding, localInstanceKey: draft.localInstanceKey, configuration: draft.configuration }),
        [JSON.stringify(triageSourceBindingComponentsV1(draft.binding)), draft.localInstanceKey, draft.configuration.token]);
    React.useEffect(() => { setInvolvement(configuration.involvement); setIssueTypeId(configuration.issueTypeId ?? ''); }, [configuration]);
    React.useEffect(() => {
        const controller = new AbortController();
        void execute(request, { signal: controller.signal }).then((execution) => {
            if (controller.signal.aborted) return;
            const parsed = execution.status === 'success' ? JiraIssueTypesResultSchema.safeParse(execution.result) : undefined;
            setDirectory({ request, result: parsed?.success ? parsed.data : { kind: 'failed', failure: { class: 'transient', code: 'jira/issueTypesUnavailable' } } });
        }).catch(() => {
            if (!controller.signal.aborted) setDirectory({ request, result: { kind: 'failed', failure: { class: 'transient', code: 'jira/issueTypesUnavailable' } } });
        });
        return () => controller.abort();
    }, [execute, request, attempt]);
    const result = directory?.request === request ? directory.result : undefined;
    return <>
        <ItemGroup>
            <Item title={text('plugins.jira.settings.issues', 'Issues')} fieldAccessory accessoryOutsidePressable accessory={<Select presentation="field"
                label={text('plugins.jira.settings.issues', 'Issues')} disabled={busy} value={involvement}
                options={[
                    { value: 'mine', label: text('plugins.jira.settings.mine', 'My issues') },
                    { value: 'assignee', label: text('plugins.jira.settings.assignee', 'Assigned to me') },
                    { value: 'author', label: text('plugins.jira.settings.author', 'Created by me') },
                    { value: 'subscribed', label: text('plugins.jira.settings.subscribed', 'Subscribed') },
                    { value: 'all', label: text('plugins.jira.settings.all', 'All project issues') },
                ]} onChange={(value) => {
                    const parsed = JiraConfigurationSchema.safeParse({ ...configuration, involvement: value });
                    if (parsed.success) setInvolvement(parsed.data.involvement);
                }} />} />
            {result?.kind === 'complete' && <Item title={text('plugins.jira.settings.type', 'Issue type for new issues')}
                subtitle={text('plugins.jira.settings.typeDescription', 'Choose a native issue type to enable creation in this project.')}
                fieldAccessory accessoryOutsidePressable accessory={<Select presentation="field" label={text('plugins.jira.settings.type', 'Issue type for new issues')}
                    disabled={busy} value={issueTypeId} onChange={(value) => {
                        if (typeof value === 'string') setIssueTypeId(value);
                    }}
                    options={[{ value: '', label: text('plugins.jira.settings.typeNone', 'Not selected') },
                        ...result.issueTypes.map((type) => ({ value: type.id, label: type.name }))]} />} />}
        </ItemGroup>
        {!result && <LoadingState title={text('plugins.jira.settings.typesLoading', 'Reading Jira issue types')} />}
        {result?.kind === 'failed' && <ErrorState title={text('plugins.jira.settings.typesUnavailable', 'Jira issue types unavailable')}
            action={<Button variant="secondary" title={text('plugins.jira.settings.retry', 'Retry')} onPress={retry} />} />}
        {/* The shared section action cluster: Save leads, Cancel follows, and a long translation wraps instead of clipping. */}
        <Form.Actions><Button title={text('plugins.jira.settings.save', 'Save')} disabled={busy} onPress={() => {
            const { issueTypeId: previousType, ...base } = configuration;
            void onSubmit({ ...draft, configuration: { v: 1, token: JSON.stringify({ ...base, involvement, ...(issueTypeId ? { issueTypeId } : {}) }) } });
        }} /><Button variant="secondary" title={text('plugins.jira.settings.cancel', 'Cancel')} disabled={busy} onPress={onCancel} /></Form.Actions>
    </>;
}
function DraftEditor(props: TriageSourceSettingsDraftEditorPropsV1): React.ReactElement {
    const text = usePluginTranslation();
    const configuration = React.useMemo(() => {
        try { return JiraConfigurationSchema.safeParse(JSON.parse(props.draft.configuration.token)); } catch { return undefined; }
    }, [props.draft.configuration.token]);
    if (!configuration?.success) return <ErrorState title={text('plugins.jira.settings.invalid', 'Jira configuration unavailable')}
        action={<Button title={text('plugins.jira.settings.cancel', 'Cancel')} onPress={props.onCancel} />} />;
    return <ReadyEditor {...props} configuration={configuration.data} />;
}

export const renderSurface = createTriageSourceSettingsSurface({
    pluginId: JIRA_PLUGIN_ID, listInstancesLocalActionId: JIRA_ACTIONS.listInstances,
    connectedAccountServiceLocalId: JIRA_ACCOUNT_PURPOSE, sourceDisplayName: 'Jira',
    connectedAccountPurpose: JIRA_ACCOUNT_PURPOSE,
    DraftEditor,
});
