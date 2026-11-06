export interface DecodedGimText { text: string; encoding: 'utf-8' | 'gb18030'; }
/** Only GIM key/value text; XML/STEP encoding remains owned by its parser. */
export function decodeGimText(bytes: AllowSharedBufferSource): DecodedGimText {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'gb18030' }; }
}
export async function readGimText(file: File): Promise<string> {
  if (typeof file.arrayBuffer !== 'function') return file.text();
  return decodeGimText(await file.arrayBuffer()).text;
}
