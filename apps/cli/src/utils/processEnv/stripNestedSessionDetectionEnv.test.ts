import { describe, expect, it } from 'vitest';
import { stripNestedSessionDetectionEnv } from './stripNestedSessionDetectionEnv';

describe('stripNestedSessionDetectionEnv', () => {
  it('preserves only the explicit entrypoint still present after scoped environment merging', () => {
    const explicitEnvironment = { CLAUDE_CODE_ENTRYPOINT: 'happier', CLAUDECODE: '1', HERDR_ENV: '1' };
    expect(stripNestedSessionDetectionEnv(explicitEnvironment, explicitEnvironment)).toEqual({
      CLAUDE_CODE_ENTRYPOINT: 'happier',
    });
    expect(stripNestedSessionDetectionEnv({}, explicitEnvironment).CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(stripNestedSessionDetectionEnv({ CLAUDE_CODE_ENTRYPOINT: 'inherited' }, explicitEnvironment)
      .CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it('removes nested session detection env vars', () => {
    const input: NodeJS.ProcessEnv = {
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'parent',
      HERDR_ENV: '1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    };

    const output = stripNestedSessionDetectionEnv(input);

    expect(output.PATH).toBe('/bin');
    expect(output.CLAUDECODE).toBeUndefined();
    expect(output.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(output.HERDR_ENV).toBeUndefined();
    expect(output.HERDR_SOCKET_PATH).toBe('/tmp/herdr.sock');
  });

  it('does not mutate the input object', () => {
    const input: NodeJS.ProcessEnv = { CLAUDECODE: '1' };
    stripNestedSessionDetectionEnv(input);
    expect(input.CLAUDECODE).toBe('1');
  });
});
