import type { ConnectedServiceId } from '@happier-dev/protocol';


export type ConnectedServiceCredentialBinding = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;

export class ConnectedServiceCredentialResolutionError extends Error {
  readonly name = 'ConnectedServiceCredentialResolutionError';
  readonly kind = 'missing_credential' as const;
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;

  constructor(binding: ConnectedServiceCredentialBinding & Readonly<{ kind?: 'missing_credential' }>) {
    super(`Missing connected service credential (${binding.serviceId}/${binding.profileId})`);
    this.serviceId = binding.serviceId;
    this.profileId = binding.profileId;
  }
}
