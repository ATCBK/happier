import * as React from 'react';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { MarkdownView } from './MarkdownView';
import { useWorkspaceMarkdownImages } from './useWorkspaceMarkdownImages';

type WorkspaceMarkdownViewProps = Omit<React.ComponentProps<typeof MarkdownView>, 'images' | 'imageScope'> & Readonly<{
    scope?: WorkspaceScopeBase | null;
    filePath: string;
}>;

/** File and README documents share the resolver, consent and Machine context as one binding. */
export function WorkspaceMarkdownView({ scope, filePath, ...props }: WorkspaceMarkdownViewProps) {
    const images = useWorkspaceMarkdownImages({ scope, filePath });
    return <MarkdownView {...props} {...images} />;
}
