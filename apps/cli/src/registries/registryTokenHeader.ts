import type { RegistrySourceV1 } from '@happier-dev/protocol/registries';

/** HTTP and Git share the source's declared header, including a raw custom header. */
export function registryTokenHeader(source: RegistrySourceV1, token: string): Readonly<{ name: string; value: string }> {
  const header = source.token?.header;
  const name = header?.name ?? 'Authorization';
  const value = header ? header.scheme ? `${header.scheme} ${token}` : token : `Bearer ${token}`;
  // Both transports apply the platform's HTTP header syntax check before dispatch.
  const checked = new Headers([[name, value]]);
  return { name, value: checked.get(name)! };
}
