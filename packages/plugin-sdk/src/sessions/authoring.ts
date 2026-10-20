import type { PluginActionInputById } from '../actions/actionTypeMap.generated.js';

export type ProjectKeyV1 =
    | Readonly<{ id: string; serverId?: string }>
    | Readonly<{ serverId: string; machineId: string; rootPath: string }>
    | Readonly<{ serverId: string; projectKey: string }>;

export type SessionSpawnNewInputV2 = PluginActionInputById['session.spawn_new'];
export type SessionServerStartSpawnDraftV1 = Omit<
    SessionSpawnNewInputV2,
    'creationKey' | 'initialInput' | 'environmentVariables' | 'attestedContext'
>;
