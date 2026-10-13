import {describe,expect,it} from 'vitest';
import {createRegistryHostV1} from './registryHostV1.js';
import type {RegistrySourceDescriptorV1} from './registrySourcesV1.js';

describe('retained Git source fetch placement',()=>{
  it.each(['https://git.example.org/a/b.git','git@github.com:a/b.git','ssh://git@example.org/a/b','git://example.org/a/b','/srv/skills','C:\\skills'])('reads %s through the native daemon boundary',async url=>{
    const source:RegistrySourceDescriptorV1={id:'legacy',title:'Legacy',format:'git',kinds:['skill'],url,enabled:true,addedAt:0,origin:{kind:'user'},removable:true};
    const forbidden=async()=>{throw new Error('retained daemon-only source queried in native host');};
    const host=createRegistryHostV1({host:'native',http:{getJson:forbidden,getText:forbidden,getBytes:forbidden},readSources:async()=>[source],
      daemonFetch:async request=>{expect(request).toEqual({op:'list',kind:'skill',sourceId:'legacy'});return {op:'list',page:{sourceId:'legacy',status:{state:'ok',fetchedAt:1},items:[],nextCursor:null}};}});
    expect(await host.fetchRequest({op:'list',kind:'skill',sourceId:'legacy'})).toEqual({op:'list',page:{sourceId:'legacy',status:{state:'ok',fetchedAt:1},items:[],nextCursor:null}});
  });
});
