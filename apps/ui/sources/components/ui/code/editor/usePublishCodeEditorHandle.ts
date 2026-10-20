import * as React from 'react';

import type { TextEditorHandle } from './codeEditorTypes';

/** Outgoing transition layers may unmount after the incoming editor publishes. */
export function usePublishCodeEditorHandle<T extends TextEditorHandle>(
    editorRef: React.MutableRefObject<T | null>,
    onPublished?: (handle: T | null) => void,
): React.RefCallback<T> {
    const publishedHandle = React.useRef<T | null>(null);
    const onPublishedRef = React.useRef(onPublished);
    onPublishedRef.current = onPublished;
    return React.useCallback((handle: T | null) => {
        if (handle !== null || editorRef.current === publishedHandle.current) {
            editorRef.current = handle;
            onPublishedRef.current?.(handle);
        }
        publishedHandle.current = handle;
    }, [editorRef]);
}
