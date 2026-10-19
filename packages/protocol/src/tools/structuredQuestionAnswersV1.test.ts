import { describe, expect, it } from 'vitest';

import { StructuredQuestionAnswersV1Schema, StructuredQuestionResponseV1Schema } from './structuredQuestionAnswersV1.js';
import { AskUserQuestionResultV2Schema } from './v2/schemas.js';

describe('StructuredQuestionAnswersV1Schema', () => {
  it('reads the strict 0.2 lossless response wrapper without permission metadata', () => {
    // ui-web-v0.2.17 b8d1c449, sessions.ts sessionAllowWithAnswers producer.
    const response = { id: 'question-one', structuredAnswersV1: { Branch: ['Alpha, Beta', 'Gamma'] } };
    expect(StructuredQuestionResponseV1Schema.parse(response)).toEqual(response);
    for (const extra of [{ approved: true }, { decision: 'approved' }, { answers: { Branch: ['Other'] } },
      { updatedPermissions: {} }, { disposition: 'pass_up' }]) {
      expect(StructuredQuestionResponseV1Schema.safeParse({ ...response, ...extra }).success).toBe(false);
    }
  });
  it('accepts complete answers at the canonical author form bounds without truncation', () => {
    const answers = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`q${index}`, ['value']]));
    answers.q0 = Array.from({ length: 64 }, (_, index) => `choice-${index}`);
    expect(StructuredQuestionAnswersV1Schema.parse(answers)).toEqual(answers);
    expect(StructuredQuestionAnswersV1Schema.safeParse({ ...answers, extra: ['value'] }).success).toBe(false);
    expect(StructuredQuestionAnswersV1Schema.safeParse({ q: [...answers.q0!, 'extra'] }).success).toBe(false);
  });
  it('preserves exact ordered answer arrays including commas', () => {
    expect(StructuredQuestionAnswersV1Schema.parse({
      components: ['Alpha, Beta', 'Gamma', 'Custom, other'],
    })).toEqual({
      components: ['Alpha, Beta', 'Gamma', 'Custom, other'],
    });

    expect(AskUserQuestionResultV2Schema.parse({
      answers: {
        components: ['Alpha, Beta', 'Gamma', 'Custom, other'],
      },
    }).answers).toEqual({
      components: ['Alpha, Beta', 'Gamma', 'Custom, other'],
    });
  });

  it('rejects legacy scalar and mixed answer records', () => {
    expect(StructuredQuestionAnswersV1Schema.safeParse({ component: 'Alpha, Beta' }).success).toBe(false);
    expect(StructuredQuestionAnswersV1Schema.safeParse({
      component: ['Alpha, Beta'],
      notes: 'Gamma',
    }).success).toBe(false);
  });

  it('rejects duplicate values within one answer array', () => {
    expect(StructuredQuestionAnswersV1Schema.safeParse({
      component: ['Alpha, Beta', 'Alpha, Beta'],
    }).success).toBe(false);
  });
});
