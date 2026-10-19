/**
 * Narrows a dynamic Resource read to the text payload the Channels Resources
 * actually publish. The generic Resource contract also permits bytes, so this
 * fails loudly if one of these Resources ever stops answering JSON text
 * instead of silently handing a `Uint8Array` to `JSON.parse`.
 */
export function resourceText(content: string | Uint8Array): string {
  if (typeof content !== 'string') {
    throw new Error('Expected the Channels Resource to answer JSON text, received bytes.');
  }
  return content;
}
