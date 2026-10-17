import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { Button, defineUiSurface, DragSource, DropTarget, PageHeader, Screen, ScrollArea, Select, Stack, Text, TextField, WidgetSurface } from '@happier-dev/plugin-ui';
import { inspectedItemSchema } from '../entityContract.js';

function Overview({ launchInput }: RenderContext) {
    const [directory, setDirectory] = React.useState('.');
    const [directoryDraft, setDirectoryDraft] = React.useState(directory);
    const [filter, setFilter] = React.useState<'files' | 'folders'>('files');
    const context = React.useMemo(() => ({ directory, filter }), [directory, filter]);
    const useDirectory = () => setDirectory(directoryDraft);
    const inspected = inspectedItemSchema.safeParse(launchInput);
    return (
        <Screen>
            <ScrollArea accessibilityLabel="Widget areas">
                <Stack gap="medium">
                    <PageHeader title="Widget areas" description="Count files or folders on the serving machine. Copies can follow this page or keep their own inputs." />
                    <DragSource sourceId="sample-card" reference={{ id: 'directory-check', title: 'Directory check' }} testID="widget-areas-sample-source">
                        <Text value="Directory check" />
                    </DragSource>
                    <DropTarget targetId="inspect-item" testID="widget-areas-inspect-target">
                        <Text value="Drop a Session or Directory check here to inspect its reference." />
                    </DropTarget>
                    {inspected.success ? <Text testID="widget-areas-inspected-item" value={inspected.data.kind === 'session'
                        ? `Session · ${inspected.data.address.sessionId}` : `Sample · ${inspected.data.reference.title}`} /> : null}
                    <TextField label="Directory on the serving machine" value={directoryDraft} onChange={setDirectoryDraft}
                        autoCapitalize="none" autoCorrect={false} required onSubmitEditing={useDirectory} />
                    <Button title="Use directory" onPress={useDirectory} />
                    <Select label="Count" presentation="segmented" value={filter}
                        options={[{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' }]}
                        onChange={value => { if (value === 'files' || value === 'folders') setFilter(value); }} />
                    <WidgetSurface area="pinned" context={context} title="Pinned" />
                </Stack>
            </ScrollArea>
        </Screen>
    );
}

export const renderSurface = defineUiSurface(Overview);
