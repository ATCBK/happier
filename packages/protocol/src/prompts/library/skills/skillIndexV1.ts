import type { SkillLibraryItemV1 } from './skillLibraryItemV1.js';

/** Metadata only; bodies remain behind the session-bound skill read Action. */
export function renderSkillIndexV1(items: readonly SkillLibraryItemV1[], sessionId?: string): string {
  const lines = items.filter(item => !item.disableModelInvocation).map(item => `${item.name}: ${item.description}`);
  if (lines.length === 0) return '';
  const session = sessionId ? ` and sessionId ${JSON.stringify(sessionId)}` : ' and the current sessionId';
  return `${lines.join('\n')}\nUse skills_read with a skill name${session} to read its full instructions and supporting files.`;
}
