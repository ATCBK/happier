import { expect, it, vi } from 'vitest';

import { reportSessionRunnerFailure } from './resolveSessionRunnerFailureExitCode';
import { logger } from '@/ui/logger';

it('records code-only phase evidence for a refused continuation before exit 78', () => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  const error = Object.assign(new Error('private-body\n    at /PRIVATE_SENTINEL.js:1:2'), {
    name: 'AgentSessionContinuationUnreachableError',
    response: { status: 503, data: 'private-response', headers: { Authorization: 'private-token' } },
  });
  try {
    expect(reportSessionRunnerFailure(error)).toBe(78);
    expect(log).toHaveBeenCalledWith('[Session] Runner failed', expect.objectContaining({
      phase: 'runner_exit', exitCode: 78, errorClass: 'Error', httpStatus: 503,
      stackFrames: expect.arrayContaining([expect.objectContaining({
        file: expect.stringContaining('resolveSessionRunnerFailureExitCode.test.ts'),
      })]),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-|PRIVATE_SENTINEL/);
  } finally { log.mockRestore(); fatal.mockRestore(); }
});
