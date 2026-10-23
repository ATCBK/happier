import type { ActionCliField } from './compiledCommands';

/** Literal words and caller slots, shared by compiled and published commands. */
export type ActionCliCommandPattern = readonly (string | ActionCliField)[];

export type ActionCliCommandPathDeclaration = Readonly<{
  actionId: string;
  path: readonly string[];
  visibility: 'canonical' | 'alias' | 'hidden';
  pattern: ActionCliCommandPattern;
}>;

export function actionCliCommandPattern<T>(command: Readonly<{
  path: readonly string[];
  positionalsBeforeLastSegment: readonly T[];
}>): readonly (string | T)[] {
  return [...command.path.slice(0, -1), ...command.positionalsBeforeLastSegment, command.path.at(-1)!];
}

/** The longest canonical friendly pattern that prefixes the supplied words. */
export function findActionCliCommandPattern<T extends Readonly<{ pattern: ActionCliCommandPattern }>>(
  words: readonly string[], commands: readonly T[],
): T | null {
  let best: T | null = null;
  for (const command of commands) {
    const pattern = command.pattern;
    if (pattern.length > words.length) continue;
    if (!pattern.every((segment, index) => typeof segment === 'string' ? words[index] === segment : Boolean(words[index] && !words[index]!.startsWith('-')))) continue;
    if (!best || pattern.length > best.pattern.length) best = command;
  }
  return best;
}

/** Next literal words only; caller fields and their values stay compiler-owned. */
export function resolveActionCliCommandPathCompletionCandidates(params: Readonly<{
  commands: readonly Pick<ActionCliCommandPathDeclaration, 'visibility' | 'pattern'>[];
  committed: readonly string[];
  prefix: string;
}>): readonly string[] {
  const candidates = new Set<string>();
  for (const command of params.commands) {
    if (command.visibility === 'hidden') continue;
    if (!params.committed.every((word, index) => {
      const segment = command.pattern[index];
      return segment !== undefined && (typeof segment === 'string' ? segment === word : !word.startsWith('-'));
    })) continue;
    const next = command.pattern[params.committed.length];
    if (typeof next === 'string' && next.startsWith(params.prefix)) candidates.add(next);
  }
  return Object.freeze([...candidates].sort());
}
