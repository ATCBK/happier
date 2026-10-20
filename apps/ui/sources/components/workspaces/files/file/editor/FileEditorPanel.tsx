import * as React from 'react';
import { View } from 'react-native';

import { CodeEditorWithFind, type CodeEditorWithFindProps } from '@/components/ui/code/editor/CodeEditorWithFind';

/** File-page spacing around the shared editor and Find owner. */
export const FileEditorPanel = React.memo(function FileEditorPanel(props: CodeEditorWithFindProps & Readonly<{ theme?: unknown }>) {
    return <View style={{ flex: 1, paddingHorizontal: 16, paddingVertical: 12 }}>
        <CodeEditorWithFind {...props} testID={props.testID ?? 'file-details-editor'} />
    </View>;
});
