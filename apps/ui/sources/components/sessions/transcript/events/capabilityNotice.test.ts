import { describe, expect, it } from 'vitest';

import { SESSION_CAPABILITY_NOTICE_SIDECAR_KEY } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';

import { describeCapabilityNotice } from './capabilityNotice';

const SKILL_ID = '736cb1a6-6067-4fe9-bce1-cb7a33e4feaf';

function skillNotice(name: string, itemId: string) {
  return {
    type: 'message',
    [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: {
      v: 1,
      items: [
        {
          kind: 'skill',
          name,
          itemId,
          code: 'skills_unavailable',
          detail: 'content_unreadable',
        },
      ],
    },
  };
}

describe('describeCapabilityNotice for a Skill that did not load', () => {
  it('never shows the Skill id as its name: an unreadable Skill is named by its id upstream, so it reads as unnamed', () => {
    const presentation = describeCapabilityNotice(
      skillNotice(SKILL_ID, SKILL_ID),
    );
    expect(presentation?.lines.join('\n')).not.toContain(SKILL_ID);
    expect(presentation?.lines).toHaveLength(1);
    // The one place to fix it still names the Skill by its id.
    expect(presentation?.href).toContain(SKILL_ID);
  });

  it('keeps the name of a Skill whose name is known', () => {
    const presentation = describeCapabilityNotice(
      skillNotice('release-notes', SKILL_ID),
    );
    expect(presentation?.lines[0]).toContain('release-notes');
  });
});

describe('describeCapabilityNotice reasons', () => {
  function notice(items: ReadonlyArray<Record<string, string>>) {
    return { type: 'message', [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: { v: 1, items } };
  }

  it('says why in words and never prints a stored code', () => {
    const presentation = describeCapabilityNotice(notice([
      { kind: 'skill', name: 'release-notes', itemId: SKILL_ID, code: 'skills_unavailable', detail: 'content_unreadable' },
      { kind: 'mcp_server', name: 'linear-remote', itemId: 'mcp-1', code: 'mcp_unavailable', detail: 'mcp_request_auth_unavailable' },
      { kind: 'mcp_server', name: 'tracker', itemId: 'mcp-2', code: 'mcp_unavailable', detail: 'some_future_code' },
    ]));
    const text = presentation?.lines.join('\n') ?? '';
    expect(text).not.toMatch(/content_unreadable|mcp_request_auth_unavailable|some_future_code/);
    // Known codes still explain themselves; an unknown code leaves just the title.
    expect(presentation?.lines[0]).toContain(' · ');
    expect(presentation?.lines[1]).toContain(' · ');
    expect(presentation?.lines[2]).not.toContain(' · ');
  });
});
