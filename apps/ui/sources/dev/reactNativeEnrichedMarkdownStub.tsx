import * as React from 'react';

/** Native/Web SDK loader boundary; tests keep the app's preload/status owner real. */
export async function preloadMarkdownRuntime(): Promise<void> {}

export function EnrichedMarkdownText(props: Record<string, unknown>) {
    return React.createElement(
        'EnrichedMarkdownText',
        props,
        typeof props.markdown === 'string' ? props.markdown : null,
    );
}
