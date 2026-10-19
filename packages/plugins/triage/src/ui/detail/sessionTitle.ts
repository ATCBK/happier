import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import type { PluginTranslate } from '@happier-dev/plugin-ui';

/** Labels consume the public host title; relationship records never name a Session. */
export function readTriageSessionTitle(
  state: SessionStateV1 | null | undefined,
  text: PluginTranslate,
): string {
  return state?.title?.trim() || text('session.untitled', 'Untitled session');
}
