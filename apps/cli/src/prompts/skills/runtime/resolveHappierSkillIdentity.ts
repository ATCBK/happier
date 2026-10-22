import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

export function resolveHappierSkillIdentity(
  input: Readonly<{ name?: string; path?: string }>,
  delivery: Pick<AgentSessionSkillDelivery, 'items'> | undefined,
  happyHomeDir?: string,
): string | null {
  if (!delivery) return null;
  if (input.path) {
    for (const item of delivery.items) {
      if (isCanonicalAbsolutePathInsideRoot(item.directory, input.path)
        || (happyHomeDir && isCanonicalAbsolutePathInsideRoot(
          `${happyHomeDir}/skills/cache/${item.digest.slice('sha256:'.length)}`, input.path,
        ))) return item.skillId;
    }
    // A reported native path is decisive even if its name matches a delivered item.
    return null;
  }
  return delivery.items.find(item => input.name === item.name || input.name === `happier:${item.name}`)?.skillId ?? null;
}
