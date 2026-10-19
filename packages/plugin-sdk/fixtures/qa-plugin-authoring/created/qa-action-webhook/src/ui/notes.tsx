import * as React from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import {
    Action, ErrorState, Item, ItemGroup, PageHeader, Screen, ScrollArea, Stack, Text,
} from '@happier-dev/plugin-ui/components';

function NotesPage() {
    const [summary, setSummary] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    return <Screen><ScrollArea accessibilityLabel="QA notes"><Stack gap="medium">
        <PageHeader title="QA notes" description="Try the same note behavior exposed to agents and verified deliveries." />
        <ItemGroup title="Sample note" description="This QA action formats a note without saving or sending it.">
            <Item title="Release review" accessory={<Action.Execute action="summarize-note"
                input={{ text: '  Release review  ' }} title="Summarize note" testID="qa-note.summarize"
                onSettled={(execution) => {
                    if (execution.status === 'error' || execution.status === 'outcomeUnknown') {
                        setError(execution.message);
                    }
                    if (execution.status === 'success' && execution.result
                        && typeof execution.result === 'object' && !Array.isArray(execution.result)
                        && 'summary' in execution.result && typeof execution.result.summary === 'string') {
                        setSummary(execution.result.summary);
                        setError(null);
                    }
                }} />} />
        </ItemGroup>
        {summary === null ? null : <Text value={summary} testID="qa-note.summary" />}
        {error === null ? null : <ErrorState title="Could not summarize the note" description={error} />}
    </Stack></ScrollArea></Screen>;
}

export const renderSurface = defineUiSurface(NotesPage);
