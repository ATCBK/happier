import { describe, expect, it } from 'vitest';

import { teamMembershipFixture } from '@/dev/testkit/fixtures/teamFixtures';

import {
  resolveTeamMemberManagementChoices,
} from './teamMemberPresentation';


describe('resolveTeamMemberManagementChoices', () => {
  const sources = [
    { id: 'source-a', displayName: 'Acme directory' },
    { id: 'source-b', displayName: 'Contractors' },
  ];

  it('offers the source that manages the member first, then the others, then Happier', () => {
    const choices = resolveTeamMemberManagementChoices(
      teamMembershipFixture({
        management: {
          kind: 'directory_source',
          directorySourceId: 'source-b',
          label: 'Contractors',
        },
      }),
      sources,
    );
    expect(choices.selectedId).toBe('source-b');
    expect(choices.options.map((option) => option.id)).toEqual([
      'source-b',
      'source-a',
      'native',
    ]);
  });

  it('keeps the managing source as a choice even when the sources could not be read', () => {
    const choices = resolveTeamMemberManagementChoices(
      teamMembershipFixture({
        management: {
          kind: 'directory_source',
          directorySourceId: 'source-b',
          label: 'Contractors',
        },
      }),
      [],
    );
    expect(choices.selectedId).toBe('source-b');
    expect(choices.options.map((option) => option.id)).toEqual([
      'source-b',
      'native',
    ]);
    expect(choices.options[0]?.label).toBe('Contractors');
  });

  it('selects Happier for a member the Team manages itself', () => {
    const choices = resolveTeamMemberManagementChoices(
      teamMembershipFixture(),
      sources,
    );
    expect(choices.selectedId).toBe('native');
    expect(choices.options.map((option) => option.id)).toEqual([
      'source-a',
      'source-b',
      'native',
    ]);
  });
});
