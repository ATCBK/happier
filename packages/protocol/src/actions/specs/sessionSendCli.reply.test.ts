import { describe, expect, it } from 'vitest';

import { bindSessionSendCliInput, SessionSendCliInputSchema } from './sessionSendCli.js';

describe('Session send CLI reply projection', () => {
  it('preserves explicit reply intent and its observation budget without a coordination ceiling', () => {
    const context = { actionId: 'session.message.send', invocationId: 'send-one' } as const;
    const input = SessionSendCliInputSchema.parse({ sessionId: 'worker', message: 'Which revision?', reply: 'wait', timeoutSeconds: 7200 });
    expect(bindSessionSendCliInput(input, context)).toMatchObject({ reply: 'wait', timeoutSeconds: 7200 });
    expect(bindSessionSendCliInput({ sessionId: 'worker', message: 'Which revision?', reply: 'wait' }, context))
      .not.toHaveProperty('timeoutSeconds');
    expect(SessionSendCliInputSchema.safeParse({ ...input, wait: false }).success).toBe(false);
  });
});
