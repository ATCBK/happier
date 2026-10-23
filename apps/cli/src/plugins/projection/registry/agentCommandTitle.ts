import { readDeclaredAgentTitle } from '@happier-dev/agents/declaredAgentTitle';
import type { PluginAgentCliMetadata } from '@happier-dev/protocol';

/** Shared title for the runtime descriptor and its cold command projection. */
export function readAgentCommandTitle(params: Readonly<{
  agentId: string;
  title: unknown;
  cli: PluginAgentCliMetadata;
}>): string {
  return params.cli.displayName ?? readDeclaredAgentTitle(params.title) ?? params.agentId;
}
import type { ResolvedAgentContribution } from './types';

export function readResolvedAgentTitle(contribution: ResolvedAgentContribution): string {
    const runtimeTitle = contribution.runtimeSpec?.title;
    if (runtimeTitle) return runtimeTitle;
    const title: unknown = contribution.richDefinition?.definition.title;
    if (typeof title === 'string' && title.trim()) return title.trim();
    if (title && typeof title === 'object' && 'fallback' in title) {
        const fallback = (title as Readonly<{ fallback?: unknown }>).fallback;
        if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
    }
    return contribution.id;
}

