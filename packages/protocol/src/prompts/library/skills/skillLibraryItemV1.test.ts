import { describe, expect, it } from 'vitest';
import { readSkillFrontmatterV1 } from './skillLibraryItemV1.js';

describe('readSkillFrontmatterV1', () => {
  it('reads the delivery and picker flags with the existing simple frontmatter format', () => {
    expect(readSkillFrontmatterV1('---\nname: sample\ndescription: A useful skill\ndisable-model-invocation: true\nuser-invocable: false\n---\nBody'))
      .toEqual({ name: 'sample', description: 'A useful skill', disableModelInvocation: true, userInvocable: false });
  });
  it('rejects folder-escaping skill names and defaults missing invocation flags', () => {
    expect(readSkillFrontmatterV1('---\nname: ../escape\n---\n')).toEqual({ disableModelInvocation: false, userInvocable: true });
    expect(readSkillFrontmatterV1('---\nname: hello-world\n---\n')).toEqual({ name: 'hello-world', disableModelInvocation: false, userInvocable: true });
  });
});
