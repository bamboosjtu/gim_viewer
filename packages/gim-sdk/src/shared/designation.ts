export function mainNumber(value: string): string {
  const match = value.match(
    /(?:#\s*(\d+)\s*(?:备用|预留)?主变)|(?:(\d+)\s*(?:号|#)\s*(?:备用|预留)?主变)|(?:主变(?:系统)?\s*(\d+))/,
  );
  return match ? String(Number(match.slice(1).find(Boolean))) : "";
}
