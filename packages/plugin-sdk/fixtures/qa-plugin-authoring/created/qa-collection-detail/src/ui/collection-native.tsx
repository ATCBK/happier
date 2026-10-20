import * as React from 'react';
import { defineUiSurface, useLivePluginResource } from '@happier-dev/plugin-ui';
import { Action, Collection, EmptyState, ErrorState, LoadingState, PageHeader, Screen, Stack, Text, useHappierCollection } from '@happier-dev/plugin-ui/components';
import { readRows, type ReviewRow } from '../rows.js';

const EMPTY_ROWS: readonly ReviewRow[] = [];
const keyOf = (row: ReviewRow) => row.id;
function useRowActions(row: ReviewRow) {
    return { accessory: <Action.Execute action="set-complete" input={{ rowId: row.id, completed: !row.completed }}
        title={row.completed ? 'Reopen' : 'Complete'} testID={`qa-review-complete-${row.id}`} /> };
}

function ReviewCollection() {
    const { resource, refresh } = useLivePluginResource('rows');
    const rows = React.useMemo(() => resource.value?.contentType === 'application/json'
        ? readRows(resource.value.bytes) : null, [resource.value]);
    const [openKey, setOpenKey] = React.useState<string | null>(null);
    const model = useHappierCollection({ items: rows ?? EMPTY_ROWS, keyOf, openKey, onOpenChange: setOpenKey, expandable: true });
    const retry = <Action.Refresh title="Refresh reviews" onRefresh={refresh} />;
    const empty = !resource.value ? resource.error ? <ErrorState title="Reviews could not be loaded" action={retry} />
        : <LoadingState title="Loading reviews" /> : rows === null ? <ErrorState title="Reviews could not be read" action={retry} />
        : <EmptyState title="Start another review" description="Restore the sample reviews to try the collection again."
            action={<Action.Execute action="restore" input={{}} title="Restore reviews" />} />;
    return <Screen><Collection model={model} presentation="table" detail="auto" accessibilityLabel="QA review collection"
        minListWidth={280} minDetailWidth={420} preferredListRatio={0.4} useRowActions={useRowActions} empty={empty}
        header={<Stack gap="small"><PageHeader title="Review collection" description="Review sample work and mark it complete. Changes last until this QA plugin reloads." />
            {resource.error && rows ? <ErrorState layout="line" title="Could not refresh; showing the last reviews" action={retry} /> : null}
            <Action.Execute action="clear" input={{}} title="Clear sample reviews" testID="qa-review-clear" /></Stack>}
        anatomy={{ glyph: () => null, title: row => row.title, accessibilityLabel: row => row.title, columnTitles: { title: 'Review' },
            byline: row => row.completed ? 'Complete' : 'Ready to review', peek: row => <Text value={row.summary} /> }}
        detailHeader={key => ({ title: rows?.find(row => row.id === key)?.title ?? 'Review' })}
        renderDetail={(key, { headerHosted }) => {
            const row = rows?.find(row => row.id === key);
            return row ? <Stack gap="medium">{!headerHosted ? <PageHeader title={row.title} /> : null}
                <Text value={row.summary} variant="reading" /><Text value={row.completed ? 'Complete' : 'Ready to review'} tone="secondary" />
                <Action.Execute action="set-complete" input={{ rowId: row.id, completed: !row.completed }} title={row.completed ? 'Reopen review' : 'Complete review'} />
            </Stack> : null;
        }} testID="qa-review-collection" detailTestID="qa-review-detail" /></Screen>;
}

export const renderSurface = defineUiSurface(ReviewCollection);
