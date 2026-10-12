import { useMemo, type ReactElement } from 'react';

import { HappierApprovalPromptChrome, type HappierApprovalPromptChromeProps } from '../presentation/interaction/ApprovalPromptChrome.js';
import { resolveHappierWorkTheme } from '../presentation/work/workTheme.js';
import { usePluginTheme } from './PluginUiProvider.js';

/** `tone="attention"` is a request that needs the person: the shared needs-you ring and tint. It does not grant approval. */
export type ApprovalPromptProps = Omit<
  HappierApprovalPromptChromeProps,
  'colors' | 'renderText' | 'cardRadius' | 'bodyBottomInset' | 'spacing' | 'typography'
>;

/** The caller supplies reviewed facts and decisions through the shared approval anatomy. */
export function ApprovalPrompt(props: ApprovalPromptProps): ReactElement {
  const theme = usePluginTheme();
  const status = useMemo(() => resolveHappierWorkTheme(theme).colors, [theme]);
  return <HappierApprovalPromptChrome {...props} cardRadius={theme.radii.panel} spacing={theme.spacing} colors={{
    border: theme.colors.border,
    surface: theme.colors.elevatedSurface,
    title: theme.colors.text,
    // The card's ring and tint carry "needs you"; the request line stays quiet ink.
    subtitle: theme.colors.secondaryText,
    status,
  }} />;
}
