import type {
    DiscoveredPetPackageV1,
    ImportedLocalPetPackageV1,
} from '@happier-dev/protocol';

import type { LocalPetPreviewAsset } from '@/sync/domains/pets/localPetSourceTypes';
import type { PetDeviceOverrideV1 } from '@happier-dev/protocol/pets/selection';

export type PetEnabledOverride = 'inherit' | 'enabled' | 'disabled';
export type DesktopPetOverlayVisibilityModeOverride =
    | 'inherit'
    | 'attentionOrActive'
    | 'alwaysWhenEnabled'
    | 'attentionOnly';

export type ManagedLocalPet = (ImportedLocalPetPackageV1 | DiscoveredPetPackageV1) & {
    source: Extract<DiscoveredPetPackageV1['source'], { kind: 'happierManagedLocal' }>;
};

export type DetectedPet = DiscoveredPetPackageV1 & {
    source: Extract<DiscoveredPetPackageV1['source'], { kind: 'detectedCodexHome' }>;
};

export type PetImportCandidate = DiscoveredPetPackageV1 | ImportedLocalPetPackageV1;

export type LocalDevicePetRow = Readonly<{
    sourceKey: string;
    petId: string;
    displayName: string;
    source: Extract<DiscoveredPetPackageV1['source'], { kind: 'happierManagedLocal' }>;
    previewAsset: LocalPetPreviewAsset;
}>;

export type PetSelectedPetOverride = PetDeviceOverrideV1;

export type CodexDetectionState = 'idle' | 'loading' | 'success' | 'empty' | 'error' | 'noTarget' | 'daemonMismatch';

export type LocalPetImportDiagnostic = Readonly<{
    code: string;
}>;
