import type { core } from 'zod/mini';

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
    ...(acceptedValues?.length ? { acceptedValues } : {}),
  }, ...(issue.code === 'invalid_union' ? issue.errors.flatMap(branch => branch.flatMap(projectIssue)) : [])];
}

/** Never echo rejected values, unknown-key lists, or custom issue prose. */
export function actionInputValidationFailure(error: core.$ZodError): ActionExecuteFailure {
  return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
    details: { issues: error.issues.flatMap(projectIssue) } };
}
