import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {join} from 'node:path';
import * as https from 'node:https';
import type {ClientRequest,IncomingMessage} from 'node:http';
import * as undici from 'undici';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createPluginCompatibilityProjectionV1,PluginManifestV2Schema} from '@happier-dev/protocol';
import {createMarketplaceNpmDiscoveryProjectionV1} from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import {requestExactMarketplaceInstall} from './exactInstall';
import {createMarketplaceIndexService} from './service';
import {createNpmRegistryProfileService} from '@/plugins/distribution/npm/profiles/service';
import {SAMPLE_PLUGIN_ID} from '@/plugins/testkit/samplePackage';
import {createPluginManifestV2Fixture} from '@/plugins/testkit/manifestV2Fixture';
import {accountMarketplaceUserSourceFixture,curatedMarketplaceSourceFixture,communityMarketplaceSourceFixture,publishAccountRegistrySourcesFixture} from '@/plugins/testkit/accountRegistrySources';
import {resetActiveAccountSettingsSnapshotForTests} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {createTempDir,removeTempDir} from '@/testkit/fs/tempDir';
import {createCliActionExecutor} from '@/session/actions/createCliActionExecutor';
import {createCliActionExecutorFromCredentials} from '@/session/actions/createCliActionExecutorFromCredentials';
import {getActionSpec} from '@happier-dev/protocol/actions/actionSpecs';
import {ExpectedMarketplaceListingV1Schema, PluginChangePendingReviewResultSchema} from '@happier-dev/protocol/marketplace/internal';
import {createPluginInstallationReviewFixture} from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import fastify, {type FastifyInstance} from 'fastify';
import {installAxiosFastifyAdapter} from '@/testkit/http/axiosAdapter';
import {runWithServerHttpBaseUrl} from '@/api/client/serverHttpBaseUrl';
import {getActiveAccountSettingsSnapshot,setActiveAccountSettingsSnapshot} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {resolveAccountSettingsScopeKey} from '@/settings/accountSettings/accountSettingsScopeKey';
import {emptyPromptLibraryRecordV1} from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import {PROMPT_LIBRARY_ROWS_ROUTE_V1,PromptLibraryCatalogKeyV1Schema,PromptLibraryRowsListResponseV1Schema,sealPromptLibraryContentV1} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import {AccountEncryptionCurrentnessResponseSchema} from '@happier-dev/protocol/account/encryptionMode';
import {API_TOKEN_FULL_GRANT_V1} from '@happier-dev/protocol/auth/apiTokenGrant';
import {createCliActionExecutorHarness} from '@/session/actions/createCliActionExecutorHarness';
import * as persistence from '@/persistence';
import {accountSettingsParse} from '@happier-dev/protocol/account/settings/accountSettings';
import {createPluginCliActionHost} from '@/plugins/testkit/pluginCliActionHost';
import {ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import {resolveApprovalRequestApproveAdmission} from '@happier-dev/protocol/actions/actionApprovalPresentation';
import {projectPluginInstallationReview} from '@/plugins/daemon/installationReview';
import {handlePluginsRegistryCommand} from '@/cli/commands/pluginsRegistry';

const daemonBoundary=vi.hoisted(()=>({request:vi.fn(),decide:vi.fn(),status:vi.fn()}));
vi.mock('@/daemon/controlClient',async original=>({...await original<typeof import('@/daemon/controlClient')>(),requestDaemonPluginChange:daemonBoundary.request,decideDaemonPluginChange:daemonBoundary.decide,readDaemonPluginChangeStatus:daemonBoundary.status}));
vi.mock('@/daemon/ensureDaemon',async original=>({...await original<typeof import('@/daemon/ensureDaemon')>(),ensureDaemonRunningForSessionCommand:async()=>undefined}));

// DNS, Home credentials and third-party HTTP are the substituted system boundaries.
vi.mock('node:dns/promises',async original=>({...await original<typeof import('node:dns/promises')>(),lookup:async()=>[{address:'93.184.216.34',family:4}]}));
vi.mock('undici',async original=>{const actual=await original<typeof import('undici')>();return {...actual,fetch:vi.fn(actual.fetch)};});
vi.mock('node:https',async original=>{const actual=await original<typeof import('node:https')>();return {...actual,request:vi.fn(actual.request)};});
const homes:string[]=[];
const accountHttp:Array<{app:FastifyInstance;restore:()=>void}>=[];
const COMMUNITY_NPM_MARKETPLACE_SOURCE=communityMarketplaceSourceFixture();
const INTEGRITY='sha512-'+Buffer.alloc(64,1).toString('base64');
const MANIFEST_DIGEST='sha256:'+'a'.repeat(64);
const user=()=>accountMarketplaceUserSourceFixture({sourceUrl:'https://catalog.example/team.json',title:'Team'});
function snapshot(source:{id:string;title:string;sourceUrl:string;origin:'curated'|'user'},options:{updatePolicy?:'pinned'|'allowed';review?:'approved'|'withdrawn';registryOrigin?:string;registryProfileId?:string;packageName?:string}={}){
  return {source:{id:source.id,title:source.title,kind:source.origin,sourceUrl:source.sourceUrl},freshness:{state:'fresh',fetchedAtMs:1},diagnostics:[],entries:[{
    pluginId:SAMPLE_PLUGIN_ID,publisher:{id:'acme',displayName:'Acme'},display:{title:'Sample',description:null},
    distribution:{kind:'npm',registryOrigin:options.registryOrigin??'https://registry.npmjs.org',packageName:options.packageName??'@acme/sample',version:'1.0.0',integrity:INTEGRITY,...(options.registryProfileId?{registryProfileId:options.registryProfileId}:{})},
    manifestDigest:MANIFEST_DIGEST,compatibility:{platforms:['linux']},summary:{contributions:[],requiredHostAccess:[],optionalHostAccess:[],executableRealms:['daemon']},
    review:source.origin==='curated'?{status:options.review??'approved',reviewedAt:'2026-07-22T00:00:00.000Z'}:{status:'unreviewed',reviewedAt:null},
    categories:[],media:[],updatePolicy:options.updatePolicy??'allowed',links:{},
  }]};
}
const committedChange=()=>vi.fn(async()=>({kind:'committed' as const,pluginId:SAMPLE_PLUGIN_ID,desiredGeneration:'generation-1',appliedGeneration:'generation-1',pendingSurfaces:[]}));
async function home(){const value=await createTempDir('happier-exact-account-marketplace-');homes.push(value);return value;}
async function marketplaceActionComposition(happyHomeDir:string){
  const origin='http://selected-marketplace-home.test';
  const credentials={token:`e30.${Buffer.from(JSON.stringify({sub:'selected-account'})).toString('base64url')}.fixture`,credentialProvenance:'stored_session' as const,encryption:null};
  const active=getActiveAccountSettingsSnapshot();
  if(!active||active.promptLibraryCatalog?.status!=='ready')throw new Error('Expected source fixture');
  const registryRow=active.promptLibraryCatalog.rows.find(row=>row.record.key==='registry-sources');
  if(!registryRow)throw new Error('Expected registry row');
  const settings=accountSettingsParse({...active.settings,actionsSettingsV1:{v:1,approvalWaivedSurfaces:{'plugins.install':['cli','agent']}}});
  const app=fastify({logger:false});
  app.addHook('preHandler',async request=>{expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);});
  app.get('/v1/account/encryption/currentness',async()=>AccountEncryptionCurrentnessResponseSchema.parse({mode:'plain',version:1,signingKeyFingerprint:null,contentKeyFingerprint:null,updatedAt:1}));
  app.get(PROMPT_LIBRARY_ROWS_ROUTE_V1,async()=>PromptLibraryRowsListResponseV1Schema.parse({status:'listed',rows:PromptLibraryCatalogKeyV1Schema.options.map(key=>({key,revision:1,content:sealPromptLibraryContentV1({mode:'plain',material:null,record:key==='registry-sources'?registryRow.record:emptyPromptLibraryRecordV1(key)})}))}));
  await app.ready();accountHttp.push({app,restore:installAxiosFastifyAdapter({app,origin})});
  return runWithServerHttpBaseUrl(origin,()=>{
    setActiveAccountSettingsSnapshot({...active,settings,scopeKey:resolveAccountSettingsScopeKey(credentials)});
    vi.mocked(persistence.readStoredCredentials).mockResolvedValue({token:`e30.${Buffer.from(JSON.stringify({sub:'custodian-account'})).toString('base64url')}.fixture`,credentialProvenance:'stored_session',encryption:null});
    const params={token:credentials.token,credentials,sessionId:'fixture-session',rawSession:{path:'/fixture-workspace'},mode:'plain' as const,ctx:null,happyHomeDir,serverId:'selected-home',serverHttpBaseUrl:origin};
    return {executor:createCliActionExecutor({...params,pluginActionExecutionOwner:'current_process'}),harness:createCliActionExecutorHarness(params),
      requester:createCliActionExecutorFromCredentials({credentials,serverId:'selected-home',serverApiUrl:origin,pluginActionExecutionOwner:'current_process'})};
  });
}
afterEach(async()=>{for(const fixture of accountHttp.splice(0).reverse()){fixture.restore();await fixture.app.close();}vi.restoreAllMocks();vi.mocked(undici.fetch).mockReset();vi.mocked(https.request).mockReset();daemonBoundary.request.mockReset();daemonBoundary.decide.mockReset();daemonBoundary.status.mockReset();resetActiveAccountSettingsSnapshotForTests();await Promise.all(homes.splice(0).map(removeTempDir));});

describe('exact Account marketplace install',()=>{
  it.each(['@acme/sample','happier-plugin-qa-capabilities'])('produces an approvable external marketplace review with the source-bound private-network profile for %s',async packageName=>{
    const happyHomeDir=await home();
    const registryOrigin='https://127.0.0.1:41261';
    const stored=accountMarketplaceUserSourceFixture({sourceUrl:registryOrigin+'/catalog.json',registryProfileId:'registry_external'});
    publishAccountRegistrySourcesFixture([stored]);
    const source={...stored,sourceUrl:stored.url,origin:'user' as const};
    const profiles=createNpmRegistryProfileService({happyHomeDir,probe:async()=>({status:'available'})});
    const registryCli={service:profiles,machineId:'machine-1',promptSecret:async()=>{throw new Error('Anonymous registry must not ask for a token');},write:()=>{}};
    await handlePluginsRegistryCommand(['add',registryOrigin,'--id','registry_external','--name','External','--allow-private-network',...(packageName.startsWith('@')?['--scope','@acme']:[])],registryCli);
    await handlePluginsRegistryCommand(['test','registry_external'],registryCli);
    expect((await profiles.snapshot()).profiles).toMatchObject([{profileId:'registry_external',availability:'available',useAsDefault:false}]);
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(snapshot(source,{registryOrigin,packageName})),{status:200}));
    const pending=PluginChangePendingReviewResultSchema.parse({kind:'reviewRequired',reviewKind:'installation',pendingChangeId:'external-review',reason:'firstInstall',currentVersion:null,authorityExpansion:[],
      review:projectPluginInstallationReview({
        manifest:PluginManifestV2Schema.parse(createPluginManifestV2Fixture({id:SAMPLE_PLUGIN_ID,version:'1.0.0',contributes:{skills:[{id:'external',directory:'./resources/skills/external'}]}})),
        source:{kind:'npm',locator:packageName+'@1.0.0',integrity:INTEGRITY,integrityBasis:'expected',packageName,registryOrigin,registryProfileId:'registry_external',
          marketplaceSource:{id:source.id,kind:'user',sourceUrl:source.sourceUrl},publisher:{status:'unavailable'},signature:{status:'notProvided'},provenance:{status:'notProvided'},curation:{status:'notApplicable'},updatePolicy:'allowed'},
        uiArtifacts:{verification:'verified',contributionIds:[]},
      })});
    daemonBoundary.request.mockResolvedValue(pending);
    const {harness}=await marketplaceActionComposition(happyHomeDir);
    const input={machineId:'machine-1',source:{kind:'marketplace',sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID,version:'1.0.0'}};
    const preview=await harness.deps.buildApprovalPreview?.({actionId:'plugins.install',input,context:{surface:'ui',authority:'present_user',actionCaller:{kind:'host'}},defaultPreview:{actionId:'plugins.install',actionArgs:input,summary:'Install external plugin'}});
    const request=ApprovalRequestV2Schema.parse({v:2,status:'open',createdAtMs:1,updatedAtMs:1,createdBy:{surface:'system'},actionId:'plugins.install',actionArgs:input,summary:'Install external plugin',preview,
      executionOriginV1:{v:1,authority:'present_user',caller:{kind:'host'},requestId:'external-install',surface:'ui',serverId:'selected-home',machineId:'machine-1',target:{kind:'machine',machineId:'machine-1'},actionId:'plugins.install'}});
    expect(resolveApprovalRequestApproveAdmission(JSON.parse(JSON.stringify(request))).status).toBe('available');
    if(pending.reviewKind!=='installation')throw new Error('Expected the installation review');
    expect(pending.review.contributions).toContainEqual({family:'skills',count:1});
    expect(daemonBoundary.request).toHaveBeenCalledWith(expect.objectContaining({kind:'installNpm',registryProfileId:'registry_external',expectedMarketplaceListing:expect.objectContaining({pluginId:SAMPLE_PLUGIN_ID,version:'1.0.0'})}));
    expect(daemonBoundary.decide).not.toHaveBeenCalled();
  });
  it('derives original CLI placement from the semantic install Machine and refuses conflicting outer targets',async()=>{
    publishAccountRegistrySourcesFixture();
    const source=curatedMarketplaceSourceFixture();
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(snapshot(source)),{status:200}));
    daemonBoundary.request.mockImplementation(committedChange());
    const happyHomeDir=await home();
    const host=await createPluginCliActionHost({happyHomeDir});
    try {
      const input={machineId:'machine-2',source:{kind:'marketplace',sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID,version:'1.0.0'}};
      const result=await host.executeInstall(input);
      expect(result,JSON.stringify(result)).toMatchObject({ok:true,result:{ok:true,kind:'plugins_install',outcome:'applied',change:{kind:'committed'}}});
      expect(host.delivered).toHaveLength(1);
      expect(host.delivered[0]).toMatchObject({target:{kind:'machine',machineId:'machine-2'},input});
      expect(await host.executeInstall(input,{},'machine-2')).toMatchObject({ok:true,result:{outcome:'applied'}});
      const mounted={kind:'machine' as const,machineId:'machine-2',project:{machineId:'machine-2',directory:'/fixture-workspace'}};
      expect(await host.executeInstall(input,{externalActionTarget:mounted},'machine-2'))
        .toMatchObject({ok:true,result:{outcome:'applied'}});
      expect(host.delivered[2]).toMatchObject({target:mounted,input});
      expect(await host.executeInstall(input,{},'machine-1')).toMatchObject({ok:false,errorCode:'target_unavailable'});
      expect(await host.executeInstall(input,{externalActionTarget:{kind:'machine',machineId:'machine-1'}}))
        .toMatchObject({ok:false,errorCode:'target_unavailable'});
      expect(await host.executeInstall(input,{externalActionTarget:{kind:'machine',machineId:'machine-2'}},'machine-1'))
        .toMatchObject({ok:false,errorCode:'target_unavailable'});
      expect(host.delivered).toHaveLength(3);
      const localInput={path:join(happyHomeDir,'missing-plugin'),kind:'path'};
      expect(await host.executeInstall(localInput,{},'machine-2'))
        .toMatchObject({ok:true,result:{ok:false,kind:'plugins_install'}});
      expect(host.delivered).toHaveLength(4);
      expect(host.delivered[3]).toMatchObject({target:{kind:'machine',machineId:'machine-2'},input:localInput});
    } finally {await host.dispose();}
  });
  it('routes a pinned marketplace Action through the real CLI composition and refuses a substituted release',async()=>{
    const happyHomeDir=await home();publishAccountRegistrySourcesFixture();const source=curatedMarketplaceSourceFixture();
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(snapshot(source)),{status:200}));
    const {executor}=await marketplaceActionComposition(happyHomeDir);
    const input={machineId:'machine-1',source:{kind:'marketplace' as const,sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID,version:'2.0.0'}};
    expect(getActionSpec('plugins.install').inputSchema.safeParse(input).success).toBe(true);
    const result=await executor.execute('plugins.install',input,{surface:'cli'});
    expect(result).toMatchObject({ok:true,result:{ok:false,kind:'plugins_install',outcome:'failed',diagnostics:[{code:'install_unavailable'}]}});
    if(result.ok)expect(getActionSpec('plugins.install').outputSchema?.safeParse(result.result).success).toBe(true);
    expect(daemonBoundary.request).not.toHaveBeenCalled();
  });
  it('executes the policy-waived exact candidate through production Action wiring',async()=>{
    const happyHomeDir=await home(),stored=user();publishAccountRegistrySourcesFixture([stored]);const source={...stored,sourceUrl:stored.url,origin:'user' as const};
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(snapshot(source)),{status:200}));
    const pending=PluginChangePendingReviewResultSchema.parse({kind:'reviewRequired',reviewKind:'installation',pendingChangeId:'pending-exact-marketplace',reason:'firstInstall',currentVersion:null,authorityExpansion:[],review:createPluginInstallationReviewFixture({pluginId:SAMPLE_PLUGIN_ID,version:'1.0.0',source:{kind:'npm',locator:'@acme/sample@1.0.0',integrity:INTEGRITY,integrityBasis:'expected'},updateChannel:{kind:'npm',packageName:'@acme/sample',registryOrigin:'https://registry.npmjs.org',marketplaceSource:{id:source.id,kind:'user',sourceUrl:source.sourceUrl}}})});
    daemonBoundary.request.mockResolvedValue(pending);
    daemonBoundary.status.mockResolvedValue(pending);
    daemonBoundary.decide.mockImplementation(committedChange());
    const {executor,harness,requester}=await marketplaceActionComposition(happyHomeDir);
    const input={machineId:'machine-1',source:{kind:'marketplace',sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID,version:'1.0.0'}};
    const result=await executor.execute('plugins.install',input,{surface:'cli'});
    expect(result).toMatchObject({ok:true,result:{ok:true,kind:'plugins_install',outcome:'applied',change:{kind:'committed'}}});
    if(result.ok)expect(getActionSpec('plugins.install').outputSchema?.safeParse(result.result).success).toBe(true);
    const request=daemonBoundary.request.mock.calls[0]?.[0];
    expect(request).toMatchObject({kind:'installNpm',packageName:'@acme/sample',selector:'1.0.0'});
    expect(ExpectedMarketplaceListingV1Schema.safeParse(request?.expectedMarketplaceListing).success).toBe(true);
    expect(daemonBoundary.decide).toHaveBeenCalledWith({pendingChangeId:pending.pendingChangeId,decision:'installAndTrust',optionalSelections:[]});
    // D22 permits an explicit Agent-surface waiver too. It still goes through
    // the same daemon-issued review and decision, rather than a second installer.
    const requestsBeforeAgent=daemonBoundary.request.mock.calls.length;
    // Stay at the receiving factory: the HTTP fixture represents a terminal.
    const agentResult=await requester.execute('plugins.install',input,{surface:'agent'});
    expect(agentResult).toMatchObject({ok:true,result:{ok:true,kind:'plugins_install',outcome:'applied'}});
    expect(daemonBoundary.request).toHaveBeenCalledTimes(requestsBeforeAgent+1);
    expect(daemonBoundary.decide).toHaveBeenLastCalledWith({pendingChangeId:pending.pendingChangeId,decision:'installAndTrust',optionalSelections:[]});
    const requestsBefore=daemonBoundary.request.mock.calls.length;
    const foreign=await harness.deps.pluginsDevLoopAction?.({actionId:'plugins.install',input:{machineId:'machine-1',source:{kind:'marketplace',sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID,version:'1.0.0'}},context:{surface:'rpc',authority:'present_user',externalActionCredential:{accountId:'foreign-account',principalId:'foreign-principal',credentialId:'foreign-credential',grant:API_TOKEN_FULL_GRANT_V1}}});
    expect(foreign).toMatchObject({ok:false,errorCode:'approval_context_unavailable'});
    expect(daemonBoundary.request).toHaveBeenCalledTimes(requestsBefore);
  });
  it('does not replace the selected pinned release with the catalog latest release',async()=>{
    const happyHomeDir=await home();publishAccountRegistrySourcesFixture();const source=curatedMarketplaceSourceFixture();
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(snapshot(source)),{status:200}));
    const requestChange=committedChange();
    expect(await requestExactMarketplaceInstall({happyHomeDir,sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID,version:'2.0.0'},{requestChange})).toMatchObject({ok:false,code:'install_unavailable'});
    expect(requestChange).not.toHaveBeenCalled();
  });
  it.each(['pinned','allowed'] as const)('carries curated %s facts unchanged to mandatory daemon review',async updatePolicy=>{
    const happyHomeDir=await home();publishAccountRegistrySourcesFixture();const source=curatedMarketplaceSourceFixture();
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(snapshot(source,{updatePolicy})),{status:200}));
    const requestChange=committedChange();
    const result=await requestExactMarketplaceInstall({happyHomeDir,sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID},{requestChange});
    expect(result).toMatchObject({ok:true,change:{kind:'committed',desiredGeneration:'generation-1',appliedGeneration:'generation-1'}});
    expect(requestChange).toHaveBeenCalledWith({request:{kind:'installNpm',packageName:'@acme/sample',selector:'1.0.0',registryOrigin:'https://registry.npmjs.org',expectedMarketplaceListing:{source:{id:source.id,kind:'curated',sourceUrl:source.sourceUrl},pluginId:SAMPLE_PLUGIN_ID,publisher:{id:'acme',displayName:'Acme'},packageName:'@acme/sample',registryOrigin:'https://registry.npmjs.org',version:'1.0.0',integrity:INTEGRITY,manifestDigest:MANIFEST_DIGEST,review:{status:'approved',reviewedAt:'2026-07-22T00:00:00.000Z'},updatePolicy}},approval:'none'});
  });
  it.each(['pinned','allowed'] as const)('preserves user %s policy without granting published curation',async updatePolicy=>{
    const happyHomeDir=await home(),stored=user();publishAccountRegistrySourcesFixture([stored]);
    const source={...stored,sourceUrl:stored.url,origin:'user' as const};const document=snapshot(source,{updatePolicy});
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(document),{status:200}));const requestChange=committedChange();
    const result=await requestExactMarketplaceInstall({happyHomeDir,sourceId:stored.id,pluginId:SAMPLE_PLUGIN_ID},{requestChange});
    expect(result,JSON.stringify(result)).toMatchObject({ok:true});
    expect(requestChange).toHaveBeenCalledWith(expect.objectContaining({request:expect.objectContaining({expectedMarketplaceListing:expect.objectContaining({source:{id:stored.id,kind:'user',sourceUrl:stored.url},review:{status:'unreviewed',reviewedAt:null},updatePolicy})})}));
  });
  it('rejects forged user-source curation before any daemon effect',async()=>{
    const happyHomeDir=await home(),stored=user();publishAccountRegistrySourcesFixture([stored]);
    const source={...stored,sourceUrl:stored.url,origin:'user' as const};const document=snapshot(source);
    document.entries[0]!.review={status:'approved',reviewedAt:'2026-07-22T00:00:00.000Z'};
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(document),{status:200}));
    const requestChange=committedChange();
    expect(await requestExactMarketplaceInstall({happyHomeDir,sourceId:stored.id,pluginId:SAMPLE_PLUGIN_ID},{requestChange}))
      .toMatchObject({ok:false,code:'install_unavailable'});
    expect(requestChange).not.toHaveBeenCalled();
  });
  it('targets the clicked Community npm package through real search and metadata projection',async()=>{
    const happyHomeDir=await home();publishAccountRegistrySourcesFixture();const requested:string[]=[];
    vi.mocked(undici.fetch).mockImplementation(async url=>{requested.push(String(url));return new undici.Response(JSON.stringify({total:1,objects:[{package:{name:'@acme/sample',version:'1.0.0',publisher:{username:'acme'}}}]}),{status:200});});
    const compatibility=createPluginCompatibilityProjectionV1({manifest:PluginManifestV2Schema.parse(createPluginManifestV2Fixture({id:SAMPLE_PLUGIN_ID,displayName:'Sample'})),uiArtifacts:{version:2,entries:[]}});
    const discovery=createMarketplaceNpmDiscoveryProjectionV1({compatibility,manifestDigest:MANIFEST_DIGEST});
    const metadata={name:'@acme/sample',versions:{'1.0.0':{name:'@acme/sample',version:'1.0.0',happier:{compatibilityProjection:compatibility,marketplaceDiscovery:discovery},dist:{integrity:INTEGRITY,tarball:'https://registry.npmjs.org/sample.tgz'}}}};
    vi.mocked(https.request).mockImplementation(((options:unknown,callback:(message:IncomingMessage)=>void)=>{const emitter=new EventEmitter() as EventEmitter & {end():void;destroy(error?:Error):void};emitter.end=()=>queueMicrotask(()=>callback(Object.assign(Readable.from([JSON.stringify(metadata)]),{statusCode:200,headers:{'content-type':'application/json'}}) as unknown as IncomingMessage));emitter.destroy=error=>{if(error)emitter.emit('error',error);};return emitter as unknown as ClientRequest;}) as typeof https.request);
    const requestChange=committedChange();expect(await requestExactMarketplaceInstall({happyHomeDir,sourceId:COMMUNITY_NPM_MARKETPLACE_SOURCE.id,pluginId:SAMPLE_PLUGIN_ID,packageName:'@acme/sample'},{requestChange})).toMatchObject({ok:true});
    expect(new URL(requested[0]!).searchParams.get('text')).toContain('@acme/sample');
    expect(requestChange).toHaveBeenCalledWith(expect.objectContaining({request:expect.objectContaining({expectedMarketplaceListing:expect.objectContaining({source:{id:COMMUNITY_NPM_MARKETPLACE_SOURCE.id,kind:'community-npm',sourceUrl:COMMUNITY_NPM_MARKETPLACE_SOURCE.sourceUrl},review:{status:'unreviewed',reviewedAt:null},updatePolicy:'allowed'})})}));
  });
  it('rejects withdrawn, removed and disabled sources before daemon effects',async()=>{
    const happyHomeDir=await home();publishAccountRegistrySourcesFixture();const source=curatedMarketplaceSourceFixture();const requestChange=committedChange();
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(snapshot(source,{review:'withdrawn'})),{status:200}));
    expect(await requestExactMarketplaceInstall({happyHomeDir,sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID},{requestChange})).toMatchObject({ok:false,code:'install_unavailable'});
    publishAccountRegistrySourcesFixture([],[source.id]);
    expect(await requestExactMarketplaceInstall({happyHomeDir,sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID},{requestChange})).toMatchObject({ok:false,code:'install_unavailable'});
    expect(await requestExactMarketplaceInstall({happyHomeDir,sourceId:'removed',pluginId:SAMPLE_PLUGIN_ID},{requestChange})).toMatchObject({ok:false,code:'install_unavailable'});expect(requestChange).not.toHaveBeenCalled();
  });
  it('uses the persisted user profile, not a catalog-controlled profile, and names missing profile currentness',async()=>{
    const happyHomeDir=await home(),stored=user();publishAccountRegistrySourcesFixture([stored]);const source={...stored,sourceUrl:stored.url,origin:'user' as const};
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(snapshot(source,{registryOrigin:'https://npm.acme.example.test',registryProfileId:'catalog-controlled'})),{status:200}));
    const requestChange=committedChange(),install=()=>requestExactMarketplaceInstall({happyHomeDir,sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID},{requestChange});
    expect(await install()).toMatchObject({ok:false,code:'registry_profile_required',requirement:{registryProfileId:null}});
    await createNpmRegistryProfileService({happyHomeDir}).mutate({action:'add',machineId:'machine-1',expectedRevision:0,mutationId:'add-acme',profileId:'registry_acme',profile:{displayName:'Acme',origin:'https://npm.acme.example.test',scopes:['@acme'],useAsDefault:false,allowPrivateNetwork:false}});
    publishAccountRegistrySourcesFixture([{...stored,npmRegistryProfileId:'registry_acme'}]);
    expect(await install()).toMatchObject({ok:false,code:'registry_profile_required',requirement:{registryProfileId:'registry_acme'}});expect(requestChange).not.toHaveBeenCalled();
  });
  it('rejects source-profile rebinding while HTTP is in flight rather than submitting changed facts',async()=>{
    const happyHomeDir=await home(),stored=user();publishAccountRegistrySourcesFixture([stored]);const source={...stored,sourceUrl:stored.url,origin:'user' as const};
    vi.mocked(undici.fetch).mockImplementation(async()=>{publishAccountRegistrySourcesFixture([{...stored,npmRegistryProfileId:'new-profile'}]);return new undici.Response(JSON.stringify(snapshot(source)),{status:200});});
    const requestChange=committedChange();expect(await requestExactMarketplaceInstall({happyHomeDir,sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID},{requestChange})).toMatchObject({ok:false,code:'source_changed'});expect(requestChange).not.toHaveBeenCalled();
  });
  it('refuses stale offline facts acquired through the real on-disk cache',async()=>{
    const happyHomeDir=await home(),stored=user();publishAccountRegistrySourcesFixture([stored]);const source={...stored,sourceUrl:stored.url,origin:'user' as const};
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(snapshot(source)),{status:200}));
    expect(await createMarketplaceIndexService({happyHomeDir}).queryExactListing({sourceId:stored.id,pluginId:SAMPLE_PLUGIN_ID})).toMatchObject({ok:true});
    vi.mocked(undici.fetch).mockRejectedValue(new TypeError('offline'));const requestChange=committedChange();
    expect(await requestExactMarketplaceInstall({happyHomeDir,sourceId:source.id,pluginId:SAMPLE_PLUGIN_ID},{requestChange})).toMatchObject({ok:false,code:'install_unavailable'});expect(requestChange).not.toHaveBeenCalled();
  });
});
