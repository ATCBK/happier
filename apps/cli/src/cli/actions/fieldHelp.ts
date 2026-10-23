import { ActionCliHelpRow } from './helpModel';
import { type ActionCliField } from './compiledCommands';

export function describeFieldKind(field: ActionCliField): string {
  switch (field.kind) {
    case 'boolean':
      return 'flag';
    case 'string_list':
      return 'repeatable';
    case 'enum':
      return field.choices ? field.choices.join(' | ') : 'value';
    case 'integer':
    case 'number':
      return 'number';
    case 'json':
      return 'json';
    default:
      return 'value';
  }
}

export function optionLabel(field: ActionCliField): string {
  if (field.kind === 'boolean') {
    return [field.flag, ...field.aliases, `--no-${field.flag.slice(2)}`].join(', ');
  }
  const spellings = field.kind === 'json'
    ? [`${field.flag}-json <json>`, ...field.aliases.map((alias) => `${alias} <json>`)]
    : [...[field.flag, ...field.aliases].map((flag) => `${flag} <value>`), `${field.flag}-json <json>`];
  return spellings.join(', ');
}

export function optionDescription(field: ActionCliField): string {
  const parts = [field.title ?? field.path, `(${describeFieldKind(field)})`];
  if (field.description) parts.push(field.description);
  if (field.required) parts.push('[required]');
  else if (field.requiredWhen) parts.push('[conditionally required]');
  if (field.visibleWhen) parts.push('[conditionally available]');
  if (field.disabledWhen) parts.push('[conditionally disabled]');
  if (field.listSeparator) {
    parts.push(`${field.listSeparator}-separated${field.maxSelections === null ? '' : `; at most ${field.maxSelections}`}`);
  } else if (field.maxSelections !== null) {
    parts.push(`at most ${field.maxSelections}`);
  }
  if (field.minimum !== null && field.maximum !== null) {
    parts.push(`${field.minimum}–${field.maximum}`);
  } else if (field.minimum !== null) {
    parts.push(`at least ${field.minimum}`);
  } else if (field.maximum !== null) {
    parts.push(`at most ${field.maximum}`);
  }
  if (field.exclusiveMinimum !== null) parts.push(`greater than ${field.exclusiveMinimum}`);
  if (field.exclusiveMaximum !== null) parts.push(`less than ${field.exclusiveMaximum}`);
  return parts.join(' ');
}

/**
 * The option rows every Action-driven command documents its fields with — type,
 * requiredness, conditions, choices and ranges — for built-in, generic-invoke and
 * plugin-contributed commands alike.
 */
export function buildFieldOptionRows(fields: readonly ActionCliField[]): readonly ActionCliHelpRow[] {
  return Object.freeze(fields.map((field) => Object.freeze({
    label: optionLabel(field),
    description: optionDescription(field),
  })));
}

