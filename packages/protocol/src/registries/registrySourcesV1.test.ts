import { describe, expect, it } from 'vitest';
import { deriveRegistrySourceIdV1, listRegistrySourcesV1, normalizeRegistrySourceUrlV1, readRegistrySourcesRecordV1 } from './registrySourcesV1.js';
import { openPromptLibraryContentV1, PromptLibraryRecordV1Schema } from '../prompts/library/promptLibraryRowsV1.js';

describe('Account registry sources', () => {
  // cd2bb4d853a259ae00ebc3e5981224e3e4bb5380: src/promptLibrary/promptRegistriesV1.ts.
  const predecessor = { v: 1, sources: [{ id: 'team', adapterId: 'git', title: 'Team', enabled: true,
    config: { repositoryUrl: 'git@github.com:team/skills.git', subdirectory: 'skills' } }, { id: 'bad' }] };
  it('reads predecessor sources individually, preserves identity, and writes the strict current row', () => {
    const record = readRegistrySourcesRecordV1(predecessor);
    expect(PromptLibraryRecordV1Schema.safeParse({key:'registry-sources',value:predecessor}).success).toBe(false);
    expect(record).toEqual({ v: 2, disabledSourceIds: [], sources: [{ id: 'team', title: 'Team', enabled: true,
      format: 'git', kinds: ['skill'], url: 'git@github.com:team/skills.git', path: 'skills', addedAt: 0 }] });
    expect(PromptLibraryRecordV1Schema.parse({ key: 'registry-sources', value: record }).value).toEqual(record);
    expect(openPromptLibraryContentV1({ key: 'registry-sources', mode: 'plain', material: null,
      content: { t: 'plain', v: { key: 'registry-sources', value: predecessor } } })).toMatchObject({ status: 'opened', record: { value: record } });
    expect(openPromptLibraryContentV1({key:'registry-sources',mode:'plain',material:null,content:{t:'plain',v:{key:'registry-sources',value:{...record,future:'drop',sources:record.sources.map(source=>({...source,future:'drop'}))}}}})).toEqual({status:'opened',record:{key:'registry-sources',value:record}});
  });
  it('deduplicates normalized repository URLs and applies disabled state to non-user sources', () => {
    expect(normalizeRegistrySourceUrlV1('https://GitHub.com/acme/skills.git/')).toBe('https://github.com/acme/skills');
    expect(deriveRegistrySourceIdV1('https://GitHub.com/acme/skills.git')).toBe(deriveRegistrySourceIdV1('https://github.com/acme/skills'));
    expect(() => normalizeRegistrySourceUrlV1('https://secret@github.com/acme/skills')).toThrow();
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: ['builtin:skills-sh'] }, pluginSources: [] });
    expect(sources.find(source=>source.id==='builtin:skills-sh')).toMatchObject({ id: 'builtin:skills-sh', enabled: false, removable: false, origin: { kind: 'built_in' } });
  });
  it('fails closed when tolerant projection would discard a token reference', () => {
    const source = { id: 'private', title: 'Private', format: 'git', kinds: ['skill'],
      url: 'https://github.com/acme/private', enabled: true, addedAt: 1, token: { secretRef: 'personal-token' } };
    for (const sources of [[{ ...source, futureCredential: { secretRef: 'hidden-token' } }],
      [{ ...source, title: null }], [source, { ...source, token: { secretRef: 'second-token' } }]]) {
      const value = { v: 2, sources, disabledSourceIds: [] };
      expect(openPromptLibraryContentV1({ key: 'registry-sources', mode: 'plain', material: null,
        content: { t: 'plain', v: { key: 'registry-sources', value } } }))
        .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    }
  });
  it.each([null,42,{v:3,sources:[]},{v:2},{sources:[]}])('keeps invalid stored envelope %j unavailable',value=>{
    expect(openPromptLibraryContentV1({key:'registry-sources',mode:'plain',material:null,content:{t:'plain',v:{key:'registry-sources',value}}})).toEqual({status:'unavailable',reason:'invalid-stored-content'});
  });
});
