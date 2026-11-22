/** Release only a complete, exclusively owned buffer. Borrowed slices keep
 * their original backing store and older runtimes fall back to collection. */
export function releaseOwnedBytes(bytes: Uint8Array): void {
  const { buffer } = bytes;
  if (
    !(buffer instanceof ArrayBuffer) ||
    bytes.byteOffset !== 0 ||
    bytes.byteLength !== buffer.byteLength
  )
    return;
  try {
    (buffer as ArrayBuffer & { transfer?: (length: number) => ArrayBuffer }).transfer?.(0);
  } catch {
    // Some native buffers cannot be detached.
  }
}
