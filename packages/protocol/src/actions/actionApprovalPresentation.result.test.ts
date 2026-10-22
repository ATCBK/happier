import { describe, expect, it } from 'vitest';

import { describeActionResultFields } from './actionApprovalPresentation.js';

describe('Action result presentation', () => {
  it('reads an archive result by meaning: no repeated success flag, no echoed argument, the time as a timestamp', () => {
    const presentation = describeActionResultFields({
      actionArgs: { sessionId: 'session-1' },
      result: {
        success: true,
        sessionId: 'session-1',
        archivedAt: 1792557232467,
      },
    });

    expect(presentation?.rows).toEqual([
      {
        kind: 'value',
        path: 'archivedAt',
        title: 'Archived at',
        value: '1792557232467',
        valueFormat: 'timestamp',
      },
    ]);
  });

  it('names Session and Machine ids it returned, and keeps a failed success flag', () => {
    const presentation = describeActionResultFields({
      actionArgs: {},
      result: {
        success: false,
        sessionId: 'session-2',
        machineId: 'machine-1',
        reports: [{ id: 'r1', archivedAt: 1792557232467 }],
      },
    });

    expect(presentation?.rows).toEqual([
      {
        kind: 'value',
        path: 'success',
        title: 'Success',
        value: 'false',
        valueFormat: 'boolean',
      },
      {
        kind: 'value',
        path: 'sessionId',
        title: 'Session id',
        value: 'session-2',
        reference: { kind: 'session', id: 'session-2' },
      },
      {
        kind: 'value',
        path: 'machineId',
        title: 'Machine id',
        value: 'machine-1',
        reference: { kind: 'machine', id: 'machine-1' },
      },
      expect.objectContaining({
        path: 'reports',
        entries: [
          { label: '1', value: null, depth: 0 },
          { label: 'Id', value: 'r1', depth: 1 },
          {
            label: 'Archived at',
            value: '1792557232467',
            depth: 1,
            valueFormat: 'timestamp',
          },
        ],
      }),
    ]);
  });

  it('reads a discriminator as words, like an argument does', () => {
    expect(describeActionResultFields({ result: { type: 'pending' } })?.rows).toEqual([
      { kind: 'value', path: 'type', title: 'Type', value: 'Pending' },
    ]);
  });

  it('reads an empty result as nothing, and leaves a non-object result to its caller', () => {
    expect(
      describeActionResultFields({ result: { success: true } })?.rows,
    ).toEqual([]);
    expect(describeActionResultFields({ result: 'plain words' })).toBeNull();
  });
});
