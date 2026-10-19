/** The one compact number for tool counts and token costs ("1.2k"), wherever a capability states them. */
export function formatCapabilityCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
    .format(value)
    .toLowerCase();
}
