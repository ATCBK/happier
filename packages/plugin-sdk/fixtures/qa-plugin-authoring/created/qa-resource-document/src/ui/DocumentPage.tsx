import * as React from 'react';
import { defineUiSurface, useLivePluginResource } from '@happier-dev/plugin-ui';
import { Action, EmptyState, ErrorState, FreshnessLine, LoadingState, Markdown, PageHeader, Screen, ScrollArea, Stack } from '@happier-dev/plugin-ui/components';

const SAMPLE_DOCUMENT = '# Review notes\n\nThe permission checks are complete. Next, verify recovery after a connection drops.';

function DocumentPage() {
    const { resource, refresh } = useLivePluginResource('document');
    const refreshAction = <Action.Refresh title="Refresh document" onRefresh={refresh} />;
    const writeAction = <Action.Execute action="document-write" input={{ text: SAMPLE_DOCUMENT }} title="Write sample notes" />;
    let body: React.ReactNode;
    if (resource.value === undefined) {
        body = resource.error
            ? <ErrorState title="Document is unavailable" description="Try reading the document again." action={refreshAction} />
            : <LoadingState title="Loading document" />;
    } else if (resource.value.contentType !== 'text/markdown') {
        body = <ErrorState title="Document format is unsupported" description="The document must contain Markdown." action={refreshAction} />;
    } else {
        const text = new TextDecoder().decode(resource.value.bytes);
        body = <Stack gap="medium">
            {resource.freshness === 'stale' ? <FreshnessLine
                reason={resource.error ? 'The latest document could not be read.' : 'Refreshing document…'}
                busy={resource.pending === 'refresh'} tone={resource.error ? 'warning' : 'neutral'}
                action={{ label: 'Refresh', onPress: refresh }}
            /> : null}
            {text.length === 0 ? <EmptyState title="Start your review notes"
                description="Save a sample document, then watch it change when an agent writes new notes." action={writeAction} />
                : <><Markdown value={text} testID="qa-document-content" />{writeAction}
                    <Action.Execute action="document-write" input={{ text: '' }} title="Clear sample notes" variant="secondary" />
                    {refreshAction}</>}
        </Stack>;
    }
    return <Screen><ScrollArea accessibilityLabel="Review notes"><Stack gap="medium">
        <PageHeader title="Review notes" description="Read the latest document saved from this page or an agent." />
        {body}
    </Stack></ScrollArea></Screen>;
}

export const renderSurface = defineUiSurface(DocumentPage);
