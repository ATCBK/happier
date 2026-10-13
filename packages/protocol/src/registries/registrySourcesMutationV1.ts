import type { RegistrySourceV1, RegistrySourceDescriptorV1 } from './registrySourcesV1.js';
export type RegistrySourcesMutationV1 = Readonly<{ kind:'create'; source:RegistrySourceV1 }>
  | Readonly<{kind:'update';sourceId:string;title?:string;enabled?:boolean}>
  | Readonly<{kind:'delete';sourceId:string}>
  | Readonly<{kind:'setToken';sourceId:string;token?:RegistrySourceV1['token']|null;npmRegistryProfileId?:string|null}>
  | Readonly<{kind:'setBuiltInEnabled';sourceId:string;enabled:boolean}>;
export type RegistrySourcesMutationResultV1 = Readonly<{status:'updated';revision:number}>
  | Readonly<{status:'conflict';revision:number}>
  | Readonly<{status:'unavailable';reason:string}>
  | Readonly<{status:'invalid';reason:'not_found'|'not_removable'|'not_editable'}>;
export type RegistrySourcesActionMutationV1 = RegistrySourcesMutationV1;
export type RegistrySourcesReadV1 = () => Promise<readonly RegistrySourceDescriptorV1[]>;
