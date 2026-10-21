import { describe, expect, it, vi } from 'vitest';

import { buildDiscussionCheckInMenuAction } from './discussionCheckInMenu';

function settings(
  overrides: Partial<
    Parameters<typeof buildDiscussionCheckInMenuAction>[0]['settings']
  > = {},
) {
  return {
    status: 'ready' as const,
    override: undefined,
    saving: false,
    canManage: true,
    dontPause: vi.fn(async () => undefined),
    inherit: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Discussion check-in menu action', () => {
  it('is absent for a reader who cannot manage the Discussion', () => {
    expect(
      buildDiscussionCheckInMenuAction({
        settings: settings({ canManage: false }),
        accountAfterTurns: 5,
      }),
    ).toBeNull();
  });

  it('inherits the Account value until chosen, then stops pausing this Discussion only', () => {
    const state = settings();
    const action = buildDiscussionCheckInMenuAction({
      settings: state,
      accountAfterTurns: 5,
    })!;
    expect(action.checked).toBe(false);
    expect(action.disabled).toBe(false);
    expect(action.subtitle).toContain('5');
    action.onSelect();
    expect(state.dontPause).toHaveBeenCalledTimes(1);
    expect(state.inherit).not.toHaveBeenCalled();
  });

  it('shows Never as checked and returns to the Account value when chosen again', () => {
    const state = settings({ override: { afterTurns: null } });
    const action = buildDiscussionCheckInMenuAction({
      settings: state,
      accountAfterTurns: 5,
    })!;
    expect(action.checked).toBe(true);
    action.onSelect();
    expect(state.inherit).toHaveBeenCalledTimes(1);
    expect(state.dontPause).not.toHaveBeenCalled();
  });

  it('names a Discussion-specific count, which is not Never, and replaces it with Never', () => {
    const state = settings({ override: { afterTurns: 3 } });
    const action = buildDiscussionCheckInMenuAction({
      settings: state,
      accountAfterTurns: 5,
    })!;
    expect(action.checked).toBe(false);
    expect(action.subtitle).toContain('3');
    expect(action.subtitle).not.toContain('5');
    action.onSelect();
    expect(state.dontPause).toHaveBeenCalledTimes(1);
  });

  it('cannot be chosen while the setting is unread, unavailable or saving', () => {
    for (const state of [
      settings({ status: 'loading' }),
      settings({ status: 'unavailable' }),
      settings({ saving: true }),
    ]) {
      const action = buildDiscussionCheckInMenuAction({
        settings: state,
        accountAfterTurns: 5,
      })!;
      expect(action.disabled).toBe(true);
      expect(action.checked).toBeUndefined();
    }
    expect(
      buildDiscussionCheckInMenuAction({
        settings: settings({ saving: true }),
        accountAfterTurns: 5,
      })!.loading,
    ).toBe(true);
  });
});
