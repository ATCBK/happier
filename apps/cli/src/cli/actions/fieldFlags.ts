import { ACTION_CLI_COMPILER_OWNED_FLAGS } from './flags';
import type { ActionCliField } from './compiledCommands';

/**
 * The caller-facing shape one parse reads. `parseActionCliCommandInput` supplies
 * it from a compiled friendly command; `happier actions invoke` supplies it from
 * a dynamically selected Action's compiled fields. Both use this one parser.
 */
export type ActionCliParseTarget = Readonly<{
  fields: readonly ActionCliField[];
  positionals: readonly ActionCliField[];
  positionalsBeforeLastSegment?: readonly ActionCliField[];
  variadicPositional?: ActionCliField | null;
}>;

export function fieldSpellings(field: ActionCliField): readonly string[] {
  return [field.flag, ...field.aliases];
}

export function jsonFlagFor(field: ActionCliField): string {
  return `${field.flag}-json`;
}

export function negatedFlagFor(field: ActionCliField): string {
  return `--no-${field.flag.slice(2)}`;
}

export type FlagMatch = Readonly<{
  field: ActionCliField;
  form: 'value' | 'json' | 'boolean_true' | 'boolean_false';
}>;

export function buildFlagIndex(command: ActionCliParseTarget): ReadonlyMap<string, FlagMatch> {
  const index = new Map<string, FlagMatch>();
  for (const field of command.fields) {
    if (field.kind === 'boolean') {
      for (const spelling of fieldSpellings(field)) {
        index.set(spelling, { field, form: 'boolean_true' });
      }
      index.set(negatedFlagFor(field), { field, form: 'boolean_false' });
      continue;
    }
    if (field.kind !== 'json') {
      for (const spelling of fieldSpellings(field)) {
        index.set(spelling, { field, form: 'value' });
      }
    } else {
      // A declared alias of a JSON field spells the same JSON form, so an
      // established caller spelling survives the canonical projection instead
      // of being silently dead data.
      for (const alias of field.aliases) {
        index.set(alias, { field, form: 'json' });
      }
    }
    index.set(jsonFlagFor(field), { field, form: 'json' });
  }
  return index;
}

export type ActionCliFlagCollision = Readonly<{
  ok: false;
  code: 'action_cli_flag_collision';
  flag: string;
  fieldPath: string;
  conflictingFieldPath: string | null;
}>;

/**
 * Fail-closed declaration validation shared by bundled and contributed Action
 * commands. CLI-owned flags and two different caller fields must never acquire
 * the same spelling; execution otherwise has no principled precedence rule.
 */
export function validateActionCliFlagCollisions(
  command: ActionCliParseTarget,
  options: Readonly<{ reservedFlags?: readonly string[] }> = {},
): Readonly<{ ok: true }> | ActionCliFlagCollision {
  const owners = new Map<string, string | null>(
    [...ACTION_CLI_COMPILER_OWNED_FLAGS, ...(options.reservedFlags ?? [])].map((flag) => [flag, null]),
  );
  for (const field of command.fields) {
    const spellings = field.kind === 'boolean'
      ? [field.flag, ...field.aliases, negatedFlagFor(field)]
      : field.kind === 'json'
        ? [jsonFlagFor(field), ...field.aliases]
        : [field.flag, ...field.aliases, jsonFlagFor(field)];
    for (const flag of spellings) {
      if (owners.has(flag)) {
        return {
          ok: false,
          code: 'action_cli_flag_collision',
          flag,
          fieldPath: field.path,
          conflictingFieldPath: owners.get(flag) ?? null,
        };
      }
      owners.set(flag, field.path);
    }
  }
  return { ok: true };
}

/** Every flag spelling this command accepts, for help and completion. */
export function listActionCliCommandFlags(command: ActionCliParseTarget): readonly string[] {
  return Object.freeze([...buildFlagIndex(command).keys()]);
}

/**
 * The same flag spellings split by arity, so an argv policy elsewhere in the CLI
 * is derived from this one descriptor instead of restating it.
 */
export function describeActionCliCommandFlags(command: ActionCliParseTarget): Readonly<{
  booleanFlags: readonly string[];
  valueFlags: readonly string[];
}> {
  const booleanFlags: string[] = [];
  const valueFlags: string[] = [];
  for (const [name, match] of buildFlagIndex(command)) {
    if (match.form === 'boolean_true' || match.form === 'boolean_false') booleanFlags.push(name);
    else valueFlags.push(name);
  }
  return Object.freeze({
    booleanFlags: Object.freeze(booleanFlags),
    valueFlags: Object.freeze(valueFlags),
  });
}

