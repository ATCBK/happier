import {afterEach,describe,expect,it,vi} from 'vitest';
import axios from 'axios';
import {RegistryFetchResponseV1Schema,FeaturesResponseSchema,accountSettingsParse} from '@happier-dev/protocol';
import {REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,computeGitBlobShaV1,computeGitTreeShaV1} from '@happier-dev/protocol/registries';
import {deriveMarketplaceSourceId} from '@happier-dev/protocol/marketplace/marketplaceSourceRegistryV1';
import {sealSavedSecretResourceStoredContentV1} from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { prepareSavedSecretResourceCreateForOperation } from "@/settings/secrets/hydrateSavedSecretCatalog";
import {runWithServerHttpBaseUrl} from '@/api/client/serverHttpBaseUrl';
import {openEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import tweetnacl from 'tweetnacl';
import {PromptLibraryCatalogKeyV1Schema} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import {emptyPromptLibraryRecordV1} from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import {createCliRegistryHostV1} from '@/registries/createCliRegistryHost';
import {resolveAccountSettingsScopeKey} from '@/settings/accountSettings/accountSettingsScopeKey';
import {RPC_METHODS} from '@happier-dev/protocol/rpc/methods';
import {registerMachineRpcHandlers} from './rpcHandlers';
import {setActiveAccountSettingsSnapshot,resetActiveAccountSettingsSnapshotForTests} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type {RpcHandlerManager} from '../rpc/RpcHandlerManager';
import type {RpcHandler,RpcHandlerContext} from '../rpc/types';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runScmCommand} from '@/scm/runtime';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();resetActiveAccountSettingsSnapshotForTests();});
describe('registry RPC production registration',()=>{
  it('materializes an admitted source against the originating Account even when the active daemon Account differs',async()=>{
    const credentials={token:`e30.${Buffer.from(JSON.stringify({sub:'origin-account'})).toString('base64url')}.sig`,encryption:null};
    const base='https://origin-home.example.invalid';const url='https://registry.example.invalid/catalog';
    const snapshot={settings:accountSettingsParse({}),rawSettings:{},source:'network' as const,settingsVersion:1,loadedAtMs:1,settingsSecretsReadKeys:[],
      scopeKey:runWithServerHttpBaseUrl(base,()=>resolveAccountSettingsScopeKey(credentials)),savedSecretCatalogState:'ready' as const,savedSecretResources:[]};
    const operationContext=createInvocationSavedSecretOperationContextV1({credentials,snapshot,serverHttpBaseUrl:base,isCurrent:async()=>true});
    setActiveAccountSettingsSnapshot({...snapshot,scopeKey:'different-active-account'});
    const source={id:deriveMarketplaceSourceId(url),title:'Origin',format:'happier-catalog' as const,kinds:['plugin' as const],url,enabled:true,addedAt:0,
      token:{secretRef:'happier:shared-secret:v1:origin-secret'}};
    const boundary:{url:string;authorization:string|null}[]=[];
    vi.spyOn(axios,'get').mockImplementation(async(url,config)=>{
      boundary.push({url:String(url),authorization:String(config?.headers?.Authorization)});
      expect(String(url)).toBe(base+'/v1/account/saved-secrets/resources/materials');
      return {status:200,data:{resources:[{resourceId:'origin-secret',encryptionMode:'plain',recipientEnvelope:null,
        entry:{ref:source.token.secretRef,source:'shared_resource',relationship:'owner',name:'Origin',kind:'token',encryptionMode:'plain',ownerAccountId:'origin-account',revision:1,materialStatus:'ready',capabilities:{use:true,rename:true,rotate:true,manageAccess:true,delete:true}},
        storedContent:sealSavedSecretResourceStoredContentV1({resourceId:'origin-secret',mode:'plain',content:{v:1,name:'Origin',kind:'token',value:'origin-private-value'}})}]}};
    });
    vi.stubGlobal('fetch',async(url:unknown,init?:RequestInit)=>{
      boundary.push({url:String(url),authorization:new Headers(init?.headers).get('authorization')});
      if(String(url)===base+'/v1/features/authenticated')return Response.json(FeaturesResponseSchema.parse({features:{teams:{enabled:true}},capabilities:{}}));
      expect(String(url)).toBe(source.url);expect(new Headers(init?.headers).get('authorization')).toBe('Bearer origin-private-value');
      return Response.json({source:{id:source.id,title:source.title,sourceUrl:source.url,kind:'user'},freshness:{state:'fresh',fetchedAtMs:1},entries:[],diagnostics:[]});
    });
    const host=createCliRegistryHostV1({credentials,operationContext,port:{serverId:'origin',assertCurrent(){},
      readCatalog:async()=>({catalog:{status:'ready',rows:[{revision:1,record:{key:'registry-sources',value:{v:2,disabledSourceIds:[],sources:[source]}}}],tombstones:[],diagnostics:[]}}),
      writeRecord:async()=>{throw new Error('Read must not mutate');}}});
    const result=REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list',{sourceIds:[source.id],kind:'plugin'}));
    expect(result.pages[0]?.status.state).toBe('ok');expect(boundary).toHaveLength(3);
    expect(boundary.slice(0,2).every(item=>item.authorization===`Bearer ${credentials.token}`)).toBe(true);
  });
  it('keeps public shared registry bytes usable while refusing foreign private tokens and refreshing custodian material',async()=>{
    const token=`e30.${Buffer.from(JSON.stringify({sub:'daemon-primary',session:'daemon-fixture',provenance:{v:1,kind:'terminal',authority:'account_automation'}})).toString('base64url')}.fixture`;
    const machineKey=new Uint8Array(32).fill(12);const publicKey=tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const credentials={token,encryption:{type:'dataKey' as const,machineKey,publicKey}};
    // Persistence and Home/third-party transports are genuine system boundaries.
    const persistence=await import('@/persistence');vi.spyOn(persistence,'readStoredCredentials').mockResolvedValue(credentials);
    const prepare=(value:string)=>prepareSavedSecretResourceCreateForOperation({credentials,accountId:'daemon-primary',accountMode:'e2ee',resourceId:'daemon-token',displayName:'Daemon token',kind:'token',value});
    const old=prepare('stale-private-token');const fresh=prepare('fresh-private-token');
    if(!old.keyEnvelopes?.length||!fresh.keyEnvelopes?.length)throw new Error('Encrypted secrets must produce recipient envelopes');
    const freshEnvelope=fresh.keyEnvelopes[0]!;
    const handlers=new Map<string,RpcHandler>();
    const rpcHandlerManager={registerHandler(method:string,handler:RpcHandler){handlers.set(method,handler);}} as unknown as RpcHandlerManager;
    const ref='happier:shared-secret:v1:daemon-token';
    setActiveAccountSettingsSnapshot({settings:accountSettingsParse({}),rawSettings:{},source:'network',settingsVersion:1,loadedAtMs:1,settingsSecretsReadKeys:[],scopeKey:resolveAccountSettingsScopeKey(credentials),
      savedSecretCatalogState:'ready',savedSecretResources:[{resourceId:'daemon-token',ownerAccountId:'daemon-primary',displayName:'Daemon token',kind:'token',encryptionMode:'e2ee',revision:1,
        materialStatus:'ready',storedContent:old.storedContent,resourceDataKey:openEncryptedDataKeyEnvelopeV1({envelope:Buffer.from(old.keyEnvelopes[0]!.encryptedDataKey,'base64'),recipientSecretKeyOrSeed:machineKey})!}],
      promptLibraryCatalog:{status:'ready',rows:[{revision:1,record:{key:'registry-sources',value:{v:2,disabledSourceIds:[],sources:[
        {id:'token-repo',title:'Tokened',format:'git',kinds:['skill'],url:'https://github.com/token/repo',enabled:true,addedAt:0,token:{secretRef:ref}},
        {id:'public-repo',title:'Public',format:'git',kinds:['skill'],url:'https://github.com/public/repo',enabled:true,addedAt:0},
      ]}}}],tombstones:[],diagnostics:[]}});
    const observations:{url:string;authorization:string|null}[]=[];
    const skillBytes=new TextEncoder().encode('---\nname: public-skill\n---\nPublic skill bytes\n');
    const treeSha=computeGitTreeShaV1([{path:'SKILL.md',unixMode:0o644,bytes:skillBytes}]);
    let revoked=false;
    vi.spyOn(axios,'get').mockImplementation(async(url,config)=>{
      expect(new URL(String(url)).pathname).toBe('/v1/account/saved-secrets/resources/materials');
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      const envelope=freshEnvelope;
      return {status:200,data:{resources:revoked?[]:[{resourceId:'daemon-token',encryptionMode:'e2ee',storedContent:fresh.storedContent,
        recipientEnvelope:{encryptedDataKey:envelope.encryptedDataKey,recipientContentPublicKeyFingerprint:envelope.recipientContentPublicKeyFingerprint},
        entry:{ref,source:'shared_resource',relationship:'owner',name:'Daemon token',kind:'token',encryptionMode:'e2ee',revision:2,ownerAccountId:'daemon-primary',materialStatus:'ready',capabilities:{use:true,rename:true,rotate:true,manageAccess:true,delete:true}}}]}};
    });
    vi.stubGlobal('fetch',async(url:unknown,init?:RequestInit)=>{
      if(new URL(String(url)).pathname==='/v1/features/authenticated')return Response.json(FeaturesResponseSchema.parse({features:{teams:{enabled:true}},capabilities:{}}));
      observations.push({url:String(url),authorization:new Headers(init?.headers).get('authorization')});
      if(String(url).startsWith('https://raw.githubusercontent.com/'))return new Response(skillBytes);
      return Response.json(String(url).includes('/commits/')?{sha:'1'.repeat(40)}:{sha:treeSha,tree:[{path:'SKILL.md',mode:'100644',type:'blob',sha:computeGitBlobShaV1(skillBytes),size:skillBytes.length}]});
    });
    const root=registerMachineRpcHandlers({rpcHandlerManager,handlers:{spawnSession:async()=>({type:'error',errorCode:'UNEXPECTED',errorMessage:'unused'}),stopSession:async()=>true,requestShutdown(){}}});
    try{
      const handler=handlers.get(RPC_METHODS.DAEMON_REGISTRIES_FETCH);if(!handler)throw new Error('production registry registration missing');
      const foreign:RpcHandlerContext={signal:new AbortController().signal,machineAdmission:{actorAccountId:'foreign-requester',custodianAccountId:'daemon-primary',
        machineId:'fixture-machine',installationId:'fixture-installation',role:'use',encryptionMode:'e2ee'}};
      expect(RegistryFetchResponseV1Schema.parse(await handler({op:'list',kind:'skill',sourceId:'token-repo'},foreign)))
        .toMatchObject({op:'list',page:{status:{state:'auth_failed'}}});
      expect(RegistryFetchResponseV1Schema.parse(await handler({op:'files',kind:'skill',sourceId:'token-repo',itemId:'',version:'1'.repeat(40)},foreign)))
        .toMatchObject({op:'error',status:{state:'auth_failed'}});
      const download=handlers.get(RPC_METHODS.DAEMON_REGISTRIES_DOWNLOAD_INIT);if(!download)throw new Error('production registry download registration missing');
      expect(await download({kind:'skill',sourceId:'token-repo',itemId:'',version:'1'.repeat(40),recipientPublicKeyBase64:Buffer.from(publicKey).toString('base64')},foreign))
        .toMatchObject({success:false,error:'auth_failed'});
      expect(observations).toEqual([]);
      expect(RegistryFetchResponseV1Schema.parse(await handler({op:'list',kind:'skill',sourceId:'public-repo'},foreign)))
        .toMatchObject({op:'list',page:{status:{state:'ok'}}});
      const publicFiles=RegistryFetchResponseV1Schema.parse(await handler({op:'files',kind:'skill',sourceId:'public-repo',itemId:'',version:'1'.repeat(40)},foreign));
      if(publicFiles.op!=='files')throw new Error('Expected public shared registry files');
      expect(Buffer.from(publicFiles.files[0]!.contentBase64,'base64')).toEqual(Buffer.from(skillBytes));
      const publicDownload=await download({kind:'skill',sourceId:'public-repo',itemId:'',version:'1'.repeat(40),recipientPublicKeyBase64:Buffer.from(publicKey).toString('base64')},foreign);
      expect(publicDownload).toMatchObject({success:true});
      const abort=handlers.get(RPC_METHODS.DAEMON_REGISTRIES_DOWNLOAD_ABORT);if(!abort)throw new Error('production registry abort registration missing');
      await abort({downloadId:publicDownload.downloadId},foreign);
      expect(observations.length).toBeGreaterThan(0);expect(observations.every(item=>item.authorization===null)).toBe(true);
      observations.splice(0);
      const custodian:RpcHandlerContext={...foreign,machineAdmission:{...foreign.machineAdmission!,actorAccountId:'daemon-primary',role:'manage'}};
      expect(RegistryFetchResponseV1Schema.parse(await handler({op:'list',kind:'skill',sourceId:'token-repo'},custodian))).toMatchObject({op:'list',page:{status:{state:'ok'}}});
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every(item=>item.authorization==='Bearer fresh-private-token')).toBe(true);
      const disclosed=observations.length;revoked=true;
      expect(RegistryFetchResponseV1Schema.parse(await handler({op:'list',kind:'skill',sourceId:'token-repo'}))).toMatchObject({op:'list',page:{status:{state:'auth_failed'}}});
      expect(observations).toHaveLength(disclosed);
    }finally{await root.dispose();}
  });
  it('passes a headerless HTTP rate limit to the strict RPC reader and permits the next manual request',async()=>{
    const handlers=new Map<string,RpcHandler>();
    const rpcHandlerManager={registerHandler(method:string,handler:RpcHandler){handlers.set(method,handler);}} as unknown as RpcHandlerManager;
    setActiveAccountSettingsSnapshot({settings:accountSettingsParse({}),source:'network',settingsVersion:1,loadedAtMs:1,settingsSecretsReadKeys:[],scopeKey:'headerless-account-fixture',
      promptLibraryCatalog:{status:'ready',rows:[{revision:1,record:{key:'registry-sources',value:{v:2,disabledSourceIds:[],sources:[
        {id:'headerless-repo',title:'GitHub',format:'git',kinds:['skill'],url:'https://github.com/headerless/rate',enabled:true,addedAt:0} ]}}}],tombstones:[],diagnostics:[]}});
    let limited=true;
    vi.stubGlobal('fetch',async(url:unknown)=>limited?new Response(null,{status:429}):Response.json(String(url).includes('/commits/')?{sha:'1'.repeat(40)}:{sha:'2'.repeat(40),tree:[]}));
    const root=registerMachineRpcHandlers({rpcHandlerManager,handlers:{spawnSession:async()=>({type:'error',errorCode:'UNEXPECTED',errorMessage:'unused'}),stopSession:async()=>true,requestShutdown(){}}});
    try{
      const handler=handlers.get(RPC_METHODS.DAEMON_REGISTRIES_FETCH);if(!handler)throw new Error('production registry registration missing');
      const input={op:'list',kind:'skill',sourceId:'headerless-repo'};
      expect(RegistryFetchResponseV1Schema.parse(await handler(input))).toEqual({op:'list',page:{sourceId:'headerless-repo',status:{state:'rate_limited'},items:[],nextCursor:null}});
      limited=false;
      expect(RegistryFetchResponseV1Schema.parse(await handler(input))).toMatchObject({op:'list',page:{status:{state:'ok'}}});
    }finally{await root.dispose();}
  });
  it('reads a retained local Git source through real daemon registration and SCM, preserving its pinned files',async()=>{
    const cwd=await mkdtemp(join(tmpdir(),'happier-registry-rpc-git-'));
    const command=async(args:string[])=>{const result=await runScmCommand({bin:'git',cwd,args});if(!result.success)throw new Error(result.stderr);return result.stdout.trim();};
    const handlers=new Map<string,RpcHandler>();
    const rpcHandlerManager={registerHandler(method:string,handler:RpcHandler){handlers.set(method,handler);}} as unknown as RpcHandlerManager;
    const root=registerMachineRpcHandlers({rpcHandlerManager,handlers:{spawnSession:async()=>({type:'error',errorCode:'UNEXPECTED',errorMessage:'unused'}),stopSession:async()=>true,requestShutdown(){}}});
    try{
      await command(['init']);await command(['config','user.name','Registry fixture']);await command(['config','user.email','registry-fixture@example.invalid']);
      await writeFile(join(cwd,'SKILL.md'),'---\nname: daemon-pinned\n---\nReviewed\n');
      await command(['add','SKILL.md']);await command(['commit','-m','reviewed']);
      const commit=await command(['rev-parse','HEAD']);
      setActiveAccountSettingsSnapshot({settings:accountSettingsParse({}),source:'network',settingsVersion:1,loadedAtMs:1,settingsSecretsReadKeys:[],scopeKey:'local-registry-account-fixture',
        promptLibraryCatalog:{status:'ready',rows:[{revision:1,record:{key:'registry-sources',value:{v:2,disabledSourceIds:[],sources:[
          {id:'local-repo',title:'Local',format:'git',kinds:['skill'],url:cwd,enabled:true,addedAt:0} ]}}}],tombstones:[],diagnostics:[]}});
      const handler=handlers.get(RPC_METHODS.DAEMON_REGISTRIES_FETCH);if(!handler)throw new Error('production registry registration missing');
      const list=RegistryFetchResponseV1Schema.parse(await handler({op:'list',kind:'skill',sourceId:'local-repo'}));
      expect(list).toMatchObject({op:'list',page:{status:{state:'ok'},items:[{itemId:'',version:commit}]}});
      await writeFile(join(cwd,'SKILL.md'),'Changed\n');await command(['add','SKILL.md']);await command(['commit','-m','moved']);
      const item=RegistryFetchResponseV1Schema.parse(await handler({op:'read',kind:'skill',sourceId:'local-repo',itemId:'',version:commit}));
      expect(item).toMatchObject({op:'read',item:{summary:{version:commit},payload:{kind:'skill',skill:{skillMarkdown:expect.stringContaining('Reviewed')}}}});
      const files=RegistryFetchResponseV1Schema.parse(await handler({op:'files',kind:'skill',sourceId:'local-repo',itemId:'',version:commit}));
      if(files.op!=='files')throw new Error('Expected pinned file bytes');
      expect(new TextDecoder().decode(Buffer.from(files.files[0]!.contentBase64,'base64'))).toContain('Reviewed');
    }finally{await root.dispose();await rm(cwd,{recursive:true,force:true});}
  });
  it('demands persisted sources on a fresh daemon without prior Prompt catalog demand',async()=>{
    const credentials={token:`e30.${Buffer.from(JSON.stringify({sub:'fresh-registry-daemon'})).toString('base64url')}.signature`,encryption:null};
    // Daemon Settings warm has completed, but no Session or Prompt reader has demanded its catalog.
    setActiveAccountSettingsSnapshot({settings:accountSettingsParse({}),rawSettings:{},source:'network',settingsVersion:7,loadedAtMs:1,
      settingsSecretsReadKeys:[],scopeKey:resolveAccountSettingsScopeKey(credentials)});
    const commit='2'.repeat(40);const handlers=new Map<string,RpcHandler>();
    const rpcHandlerManager={registerHandler(method:string,handler:RpcHandler){handlers.set(method,handler);}} as unknown as RpcHandlerManager;
    // Only the captured Home HTTP and third-party GitHub transports are substituted.
    vi.spyOn(axios,'get').mockImplementation(async url=>{
      const path=new URL(String(url)).pathname;
      if(path==='/v1/account/encryption/currentness')return {status:200,data:{mode:'plain',version:1,settingsVersion:7,signingKeyFingerprint:null,contentKeyFingerprint:null,updatedAt:1}};
      if(path==='/v1/account/entity-rows/prompt-library')return {status:200,data:{status:'listed',rows:PromptLibraryCatalogKeyV1Schema.options.map(key=>({key,revision:3,
        content:{t:'plain',v:key==='registry-sources'?{key,value:{v:2,disabledSourceIds:[],sources:[{id:'fresh-account-repo',title:'Persisted',format:'git',kinds:['skill'],url:'https://github.com/a/b',enabled:true,addedAt:0}]}}:emptyPromptLibraryRecordV1(key)}}))}};
      if(path==='/v2/account/settings')return {status:200,data:{content:{t:'plain',v:{}},version:7}};
      if(path==='/v1/account/entity-rows/profiles/transfer')return {status:200,data:{status:'absent'}};
      if(path==='/v2/account/settings/history')return {status:200,data:{snapshots:[]}};
      throw new Error(`Unexpected Home boundary: ${path}`);
    });
    vi.stubGlobal('fetch',async(url:unknown)=>new Response(JSON.stringify(String(url).includes('/commits/')?{sha:commit}:{sha:'tree',tree:[{path:'review/SKILL.md',type:'blob',mode:'100644',sha:'blob',size:3}]}),{headers:{'content-type':'application/json'}}));
    const root=registerMachineRpcHandlers({rpcHandlerManager,handlers:{spawnSession:async()=>({type:'error',errorCode:'UNEXPECTED',errorMessage:'unused'}),stopSession:async()=>true,requestShutdown(){}},
      deps:{createRegistryHost:signal=>createCliRegistryHostV1({credentials,signal})}});
    try{
      const handler=handlers.get(RPC_METHODS.DAEMON_REGISTRIES_FETCH);if(!handler)throw new Error('production registry registration missing');
      const response=RegistryFetchResponseV1Schema.parse(await handler({op:'list',kind:'skill',sourceId:'fresh-account-repo'}));
      expect(response).toMatchObject({op:'list',page:{sourceId:'fresh-account-repo',status:{state:'ok'},items:[{itemId:'review',version:commit}]}});
    }finally{await root.dispose();}
  });
  it('resolves the daemon Account row, with strict requests and producer-to-consumer response admission',async()=>{
    const handlers=new Map<string,RpcHandler>();
    // Machine transport boundary only. The production registration, host, source reader, adapters and schemas remain real.
    const rpcHandlerManager={registerHandler(method:string,handler:RpcHandler){handlers.set(method,handler);}} as unknown as RpcHandlerManager;
    const commit='1'.repeat(40);
    vi.stubGlobal('fetch',async(url:unknown)=>new Response(JSON.stringify(String(url).includes('/commits/')?{sha:commit}:{sha:'tree',tree:[{path:'review/SKILL.md',type:'blob',mode:'100644',sha:'blob',size:3},{path:'review',type:'tree',mode:'040000',sha:'subtree'}]}),{headers:{'content-type':'application/json'}}));
    setActiveAccountSettingsSnapshot({settings:accountSettingsParse({}),source:'network',settingsVersion:1,loadedAtMs:1,settingsSecretsReadKeys:[],scopeKey:'account-fixture',
      promptLibraryCatalog:{status:'ready',rows:[{revision:3,record:{key:'registry-sources',value:{v:2,disabledSourceIds:[],sources:[
        {id:'account-repo',title:'Account repo',format:'git',kinds:['skill'],url:'https://github.com/a/b',enabled:true,addedAt:0} ]}}}],tombstones:[],diagnostics:[]}});
    const root=registerMachineRpcHandlers({rpcHandlerManager,handlers:{spawnSession:async()=>({type:'error',errorCode:'UNEXPECTED',errorMessage:'unused'}),stopSession:async()=>true,requestShutdown(){}}});
    try{
      const handler=handlers.get(RPC_METHODS.DAEMON_REGISTRIES_FETCH);expect(handler).toBeDefined();if(!handler)throw new Error('production registry registration missing');
      const response=RegistryFetchResponseV1Schema.parse(await handler({op:'list',kind:'skill',sourceId:'account-repo'}));
      expect(response).toMatchObject({op:'list',page:{sourceId:'account-repo',status:{state:'ok'},items:[{itemId:'review',version:commit}]}});
      expect(await handler({op:'list',kind:'skill',sourceId:'account-repo',configuredSources:[]})).toEqual({op:'error',status:{state:'invalid_source'}});
      expect(handlers.has('daemon.promptRegistry.scanSource')).toBe(false);
      expect(handlers.has('daemon.promptRegistry.install')).toBe(false);
    }finally{await root.dispose();}
  });
});
