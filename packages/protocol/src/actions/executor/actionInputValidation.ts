import type { core } from 'zod/mini';
import type { ErrorObject } from 'ajv';
import type { PluginJsonSchemaValidator } from '../../plugins/actions/protocolComposableSchema.js';

import type { ActionExecuteFailure } from '../actionExecutionResult.js';

type JsonPrimitive = string | number | boolean | null;
type ActionInputIssue = Readonly<{
  code: string;
  path: readonly (string | number)[];
  expected?: string;
  acceptedValues?: readonly JsonPrimitive[];
}>;

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value);
}

function projectIssue(issue: core.$ZodIssue): ActionInputIssue[] {
  const values = issue.code === 'invalid_value' ? issue.values
    : issue.code === 'invalid_union' && 'options' in issue ? issue.options : undefined;
  const acceptedValues = values?.filter(isJsonPrimitive);
  return [{
    code: issue.code,
    path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
    ...(issue.code === 'invalid_type' ? { expected: issue.expected } : {}),
    ...(issue.code === 'invalid_format' && issue.format === 'starts_with'
      && 'prefix' in issue && typeof issue.prefix === 'string'
      ? { expected: `starts_with ${JSON.stringify(issue.prefix)}` } : {}),
    ...(acceptedValues?.length ? { acceptedValues } : {}),
  }, ...(issue.code === 'invalid_union' ? issue.errors.flatMap(branch => branch.flatMap(projectIssue)) : [])];
}

/** Never echo rejected values, unknown-key lists, or custom issue prose. */
export function actionInputValidationFailure(error: core.$ZodError): ActionExecuteFailure {
  return actionInputIssueFailure(...error.issues.flatMap(projectIssue));
}

/** Read the canonical compiler's last failure; never revalidate or copy input/prose. */
export function projectActionInputJsonSchemaIssues(
  validate: PluginJsonSchemaValidator,
  schema: object,
  input: unknown,
): readonly ActionInputIssue[] {
  // The Protocol JSON Schema compiler owns this AJV error-bag boundary.
  const errors = (validate as PluginJsonSchemaValidator & { errors?: readonly ErrorObject<string, Record<string, unknown>>[] | null }).errors;
  return (errors ?? []).map(error => {
    let cursor = input;
    const path = error.instancePath === '' ? [] : error.instancePath.slice(1).split('/').map(encoded => {
      const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      const key = Array.isArray(cursor) && /^\d+$/u.test(segment) ? Number(segment) : segment;
      cursor = cursor !== null && typeof cursor === 'object' ? Reflect.get(cursor, key) : undefined;
      return key;
    });
    if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') path.push(error.params.missingProperty);
    let constraint: unknown = schema;
    for (const encoded of error.schemaPath.slice(2).split('/')) {
      constraint = constraint !== null && typeof constraint === 'object'
        ? Reflect.get(constraint, encoded.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined;
    }
    const acceptedValues = error.keyword === 'enum' && Array.isArray(constraint) ? constraint.filter(isJsonPrimitive)
      : error.keyword === 'const' && isJsonPrimitive(constraint) ? [constraint] : undefined;
    return { code: error.keyword, path,
      ...(error.keyword === 'type' && typeof error.params.type === 'string' ? { expected: error.params.type } : {}),
      ...(error.keyword === 'required' ? { expected: 'nonoptional' } : {}),
      ...(acceptedValues?.length ? { acceptedValues } : {}),
    };
  });
}

/** Semantic checks use the same content-free repair envelope as schema validation. */
export function actionInputIssueFailure(...issues: readonly ActionInputIssue[]): ActionExecuteFailure {
  return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters', details: { issues: issues.map(issue => ({
    code: issue.code,
    path: [...issue.path],
    ...(issue.expected === undefined ? {} : { expected: issue.expected }),
    ...(issue.acceptedValues === undefined ? {} : { acceptedValues: issue.acceptedValues.filter(isJsonPrimitive) }),
  })) } };
}
