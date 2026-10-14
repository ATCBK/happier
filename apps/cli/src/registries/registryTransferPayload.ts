import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistrySkillFilesPayloadV1Schema } from '@happier-dev/protocol/registries/registryRpcV1';
import type { RegistryDownloadRequestV1, createRegistryHostV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { DownloadTransferSource } from '@happier-dev/transfers/node';
import { configuration } from '@/configuration';
import { estimateJsonUtf8BytesBounded } from '@/transfers/shared/estimateJsonUtf8BytesBounded';
export async function resolveRegistryItemDownloadSource(input:Readonly<{host:ReturnType<typeof createRegistryHostV1>;request:RegistryDownloadRequestV1}>):Promise<Readonly<
  {success:true;source:DownloadTransferSource}|{success:false;error:string}>> {
  try{
    const files=await input.host.filesForPointer(input.request);
    const payload=RegistrySkillFilesPayloadV1Schema.parse(files.map(file=>({path:file.path,unixMode:file.unixMode,contentBase64:encodeBase64(file.bytes)})));
    if(estimateJsonUtf8BytesBounded(payload,configuration.promptTransferJsonMaxBytes)>configuration.promptTransferJsonMaxBytes)return {success:false,error:'too_large'};
    const body=JSON.stringify(payload);const dir=join(tmpdir(),'happier','registry-items');const filePath=join(dir,`${randomUUID()}.json`);
    await mkdir(dir,{recursive:true});await writeFile(filePath,body,'utf8');
    return {success:true,source:{filePath,deleteFileOnClose:true,sizeBytes:Buffer.byteLength(body),name:'registry-skill-files.json'}};
  }catch(error){return {success:false,error:error instanceof Error?error.message:'registry_download_failed'};}
}
