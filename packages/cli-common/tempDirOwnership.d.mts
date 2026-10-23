export type HappierTempDirOwnerV1 = Readonly<{
  v: 1;
  purpose: string;
  pid: number;
  processInstanceFingerprint: string | null;
}>;
export type HappierTempDirOwnerLiveness = 'alive' | 'gone' | 'unknown';
export function validateHappierTempDirPurpose(purpose: string): void;
export function getHappierTempRoot(root?: string): string;
export function getHappierTempRootForUid(root: string, ownerUid: number): string;
export function isHappierTempRootForUid(directory: string, ownerUid: number): boolean;
export function getHappierTempDirOwnerPath(directory: string): string;
export function readHappierTempDirOwner(directory: string): HappierTempDirOwnerV1 | null;
export function readHappierTempDirOwnerForDirectory(directory: string, ownerUid?: number): HappierTempDirOwnerV1 | null;
export function prepareHappierTempDirOwnerCleanup(directory: string, ownerUid?: number,
  retainMarker?: (markerPath: string, identity: Readonly<{ dev: string; ino: string }>) => Promise<void>): () => Promise<void>;
export function readHappierTempDirOwnerLiveness(owner: HappierTempDirOwnerV1): HappierTempDirOwnerLiveness;
