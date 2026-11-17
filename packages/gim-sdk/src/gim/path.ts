export function normalizeFilePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}
