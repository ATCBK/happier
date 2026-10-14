import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';

/** Prepare both capability kinds at the machine boundary, preserving stored/display roots. */
export function realpathReachRules<T extends ReachRuleV1>(rules: readonly T[], normalizePath = createRealpathNormalizer()): T[] {
  return rules.map(rule => rule.target.t === 'workspace'
    ? { ...rule, target: { ...rule.target, workspaceRoot: normalizePath(rule.target.workspaceRoot) } } : rule);
}

export function createRealpathNormalizer(): (value: string) => string {
  const cache = new Map<string, string>();

  return (value: string) => {
    const resolved = resolvePath(value);
    const cached = cache.get(resolved);
    if (cached) return cached;

    let normalized = resolved;
    try {
      normalized = realpathSync(resolved);
    } catch {
      // keep resolved
    }

    normalized = normalizeWorkspaceRootPathV1(normalized, process.platform === 'win32' ? 'win32' : 'posix') ?? normalized;
    cache.set(resolved, normalized);
    return normalized;
  };
}
