import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {runScmCommand} from '@/scm/runtime';
import {createRegistryGitProtocolV1} from './gitProtocol';
import type {RegistryFetchContextV1,RegistrySourceV1} from '@happier-dev/protocol/registries';
import {createEphemeralTlsServerFixture} from '../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

describe('Node Git registry transport',()=>{
  it('sends a custom token header only to the configured HTTPS destination, never a redirect',async()=>{
    const tls=await createEphemeralTlsServerFixture();
    const options={key:await readFile(tls.privateKeyPath),cert:await readFile(tls.leafCertificatePath)};
    const oldCa=process.env.GIT_SSL_CAINFO;process.env.GIT_SSL_CAINFO=tls.caCertificatePath;
    const forwarded:unknown[]=[];const sourceHeaders:unknown[]=[];
    const target=createServer(options,(req,res)=>{forwarded.push(req.headers['x-api-key']);res.writeHead(404);res.end();});
    await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
    const address=target.address();if(!address||typeof address==='string')throw new Error('HTTPS fixture port unavailable');
    const sourceServer=createServer(options,(req,res)=>{sourceHeaders.push(req.headers['x-api-key']);res.writeHead(302,{Location:`https://127.0.0.1:${address.port}/other/info/refs?service=git-upload-pack`});res.end();});
    await new Promise<void>(resolve=>sourceServer.listen(0,'127.0.0.1',resolve));
    try{
      const sourceAddress=sourceServer.address();if(!sourceAddress||typeof sourceAddress==='string')throw new Error('HTTPS fixture port unavailable');
      const git=createRegistryGitProtocolV1({resolveToken:async()=> 'fixture-secret'});
      const source:RegistrySourceV1={id:'redirect',title:'Redirect',format:'git',url:`https://127.0.0.1:${sourceAddress.port}/repo`,kinds:['skill'],enabled:true,addedAt:0,
        token:{secretRef:'happier:shared-secret:v1:redirect',header:{name:'X-Api-Key'}}};
      const forbidden=async()=>{throw new Error('Git transport must not use registry HTTP');};
      await expect(git.list({git,http:{getJson:forbidden,getText:forbidden,getBytes:forbidden}},{source,kind:'skill'})).rejects.toMatchObject({status:{state:'unreachable'}});
      expect(sourceHeaders).toEqual(['fixture-secret']);expect(forwarded).toEqual([]);
      await expect(git.latest({git,http:{getJson:forbidden,getText:forbidden,getBytes:forbidden}},[{
        sourceId:source.id,format:'git',sourceUrl:source.url,itemId:'',importedAt:1,
        ref:{kind:'gitTree',repo:`https://127.0.0.1:${address.port}/other`,path:'',commit:'1'.repeat(40),treeSha:'tree'},
      }],{source})).rejects.toMatchObject({status:{state:'invalid_source'}});
      expect(forwarded).toEqual([]);
    }finally{
      await Promise.all([new Promise<void>(resolve=>sourceServer.close(()=>resolve())),new Promise<void>(resolve=>target.close(()=>resolve()))]);
      if(oldCa===undefined)delete process.env.GIT_SSL_CAINFO;else process.env.GIT_SSL_CAINFO=oldCa;
      await tls.cleanup();
    }
  });
  it('lists an exact SHA source ref and downloads its pinned files after the branch changes',async()=>{
    const cwd=await mkdtemp(join(tmpdir(),'happier-registry-git-test-'));
    const command=async(args:string[])=>{const result=await runScmCommand({bin:'git',cwd,args});if(!result.success)throw new Error(result.stderr);return result.stdout.trim();};
    try{
      await command(['init']);await command(['config','user.name','Registry fixture']);await command(['config','user.email','registry-fixture@example.invalid']);
      const binary=new Uint8Array(5_550_001).fill(255);
      await writeFile(join(cwd,'SKILL.md'),'---\nname: pinned\n---\nReviewed\n');await writeFile(join(cwd,'asset.bin'),binary);await command(['add','SKILL.md','asset.bin']);await command(['commit','-m','reviewed']);
      const commit=await command(['rev-parse','HEAD']);
      await writeFile(join(cwd,'SKILL.md'),'Changed\n');await command(['add','SKILL.md']);await command(['commit','-m','moved']);
      const source:RegistrySourceV1={id:'node-git',title:'Fixture',format:'git',kinds:['skill'],url:cwd,ref:commit,enabled:true,addedAt:0};
      const git=createRegistryGitProtocolV1({});
      const forbidden=async()=>{throw new Error('Non-GitHub registry must not use HTTP');};
      const ctx:RegistryFetchContextV1={git,http:{getJson:forbidden,getText:forbidden,getBytes:forbidden}};
      expect(await git.list(ctx,{source,kind:'skill'})).toMatchObject({status:{state:'ok'},items:[{itemId:'',version:commit}]});
      const item=await git.read(ctx,{source,kind:'skill',itemId:'',version:commit});
      expect(item.payload.skill.skillMarkdown).toContain('Reviewed');
      const latest=await git.latest(ctx,[{sourceId:source.id,format:'git',sourceUrl:source.url,itemId:'',
        ref:item.payload.skill.ref,importedAt:item.fetchedAt}],{source});
      expect(latest.get('')).toEqual(item.payload.skill.ref);
      const downloaded=await git.files(item.payload.skill,source);
      expect(new TextDecoder().decode(downloaded.find(file=>file.path==='SKILL.md')!.bytes)).toContain('Reviewed');
      expect(downloaded.find(file=>file.path==='asset.bin')!.bytes).toEqual(binary);
    }finally{await rm(cwd,{recursive:true,force:true});}
  });
});
