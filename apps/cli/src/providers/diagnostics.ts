import { logger } from '@/ui/logger';

/** Unexpected failures may contain credentials in their message or cause.
 * Retain the exception class and source coordinates, never arbitrary prose,
 * paths, request data, or serialized error objects. */
export function logProviderUnexpectedFailure(
  operation: 'launch' | 'model_projection',
  error: unknown,
): void {
  const errorType = error instanceof Error
    ? [Error, TypeError, ReferenceError, RangeError, SyntaxError, URIError, EvalError]
      .find(type => error.constructor === type)?.name ?? 'Error'
    : 'Unknown';
  const sourceLocations = error instanceof Error && typeof error.stack === 'string'
    ? error.stack.split('\n').flatMap(line => {
      if (!/^\s+at /.test(line)) return [];
      const location = /[/\\]([^/\\():\s]+\.(?:[cm]?js|tsx?)):(\d+):(\d+)\)?$/.exec(line);
      return location ? [`${location[1]}:${location[2]}:${location[3]}`] : [];
    }) : [];
  logger.warnLocalFile('[PROVIDER] Unexpected failure', { operation, errorType, sourceLocations });
}
