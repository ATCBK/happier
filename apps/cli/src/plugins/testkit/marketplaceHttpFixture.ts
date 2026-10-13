import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import * as https from 'node:https';
import type {ClientRequest,IncomingMessage} from 'node:http';
import * as undici from 'undici';
import {vi} from 'vitest';
import {createPluginCompatibilityProjectionV1,PluginManifestV2Schema,type MarketplaceIndexSourceSnapshotV1} from '@happier-dev/protocol';
import {createMarketplaceNpmDiscoveryProjectionV1} from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import {createPluginManifestV2Fixture} from './manifestV2Fixture';

/** Callers mock only undici.fetch/node:https.request; every loader and parser stays real. */
export function installMarketplaceHttpBoundaryFixture(read: (kind:'catalog'|'npm')=>Promise<MarketplaceIndexSourceSnapshotV1>|MarketplaceIndexSourceSnapshotV1):void {
  vi.mocked(undici.fetch).mockImplementation(async url=>{
    const npm=new URL(String(url)).pathname==='/-/v1/search';
    const snapshot=await read(npm?'npm':'catalog');
    const body=npm?{total:snapshot.entries.length,objects:snapshot.entries.map(entry=>({package:{name:entry.distribution.packageName,version:entry.distribution.version,publisher:{username:entry.publisher.id}}}))}:snapshot;
    return new undici.Response(JSON.stringify(body),{status:200});
  });
  // This cast isolates the overloaded, genuinely external native HTTPS boundary.
  vi.mocked(https.request).mockImplementation(((options:unknown,callback:(message:IncomingMessage)=>void)=>{
    const emitter=new EventEmitter() as EventEmitter & {end():void;destroy(error?:Error):void};
    emitter.end=()=>{void Promise.resolve().then(async()=>{
      const snapshot=await read('npm');const entry=snapshot.entries[0];if(!entry)throw Error('npm HTTP fixture requires metadata');
      const compatibility=createPluginCompatibilityProjectionV1({manifest:PluginManifestV2Schema.parse(createPluginManifestV2Fixture({id:entry.pluginId,version:entry.distribution.version,displayName:entry.display.title,
        description:entry.display.description??undefined,engines:{happier:entry.compatibility.happier??'>=0.0.0'}})),uiArtifacts:{version:2,entries:[]}});
      const discovery=createMarketplaceNpmDiscoveryProjectionV1({compatibility,manifestDigest:entry.manifestDigest});
      const metadata={name:entry.distribution.packageName,versions:{[entry.distribution.version]:{name:entry.distribution.packageName,version:entry.distribution.version,happier:{compatibilityProjection:compatibility,marketplaceDiscovery:discovery},
        dist:{integrity:entry.distribution.integrity,tarball:new URL('/fixture.tgz',entry.distribution.registryOrigin).href}}}};
      callback(Object.assign(Readable.from([JSON.stringify(metadata)]),{statusCode:200,headers:{'content-type':'application/json'}}) as unknown as IncomingMessage);
    }).catch(error=>emitter.emit('error',error));};
    emitter.destroy=error=>{if(error)emitter.emit('error',error);};return emitter as unknown as ClientRequest;
  }) as typeof https.request);
}
