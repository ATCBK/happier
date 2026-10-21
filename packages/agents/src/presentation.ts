import { BUNDLED_AGENT_PRESENTATION } from './generated/bundledAgentPresentation.js';

export type BundledAgentPresentation = Readonly<{
    name: string;
    identityColor: Readonly<{ light: string; dark: string }> | null;
}>;

export function readBundledAgentPresentation(agentId: string): BundledAgentPresentation | null {
    return Object.hasOwn(BUNDLED_AGENT_PRESENTATION, agentId) ? BUNDLED_AGENT_PRESENTATION[agentId]! : null;
}

/** Shared neutral for an Agent without an admitted identity hue, or a folded Other series. */
export function getNeutralAgentIdentityColor(theme: Readonly<{ dark: boolean }>): string {
    return theme.dark ? '#6C625D' : '#A3A3A8';
}

