const paths: Record<string, string> = {
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15m6-12v15"/>',
  tree: '<path d="M5 3v15h4M5 7h4M5 13h4"/><rect x="9" y="4" width="11" height="6" rx="1"/><rect x="9" y="13" width="11" height="6" rx="1"/>',
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  fit: '<path d="M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6"/>',
  tower: '<path d="m12 2-7 20m7-20 7 20M8 8h8M6 14h12M5 20l11-12M19 20 8 8M3 8h18"/>',
  cross: '<path d="M4 4l16 16M20 4 4 20"/><circle cx="12" cy="12" r="9"/>',
  span: '<circle cx="4" cy="12" r="2"/><circle cx="20" cy="12" r="2"/><path d="M6 12h12"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  settings: '<path d="m10 2-1 3-3 1-3-1-1 4 2 2v3l-2 2 2 4 3-1 3 1 1 2h4l1-3 3-1 3 1 1-4-2-2v-3l2-2-2-4-3 1-3-1-1-2z"/><circle cx="12" cy="12" r="3"/>',
  chevron: '<path d="m8 4 8 8-8 8"/>', close: '<path d="m5 5 14 14M19 5 5 19"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  back: '<path d="m15 4-8 8 8 8"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
};
export function icon(name: string, size = 20): string { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.info}</svg>`; }
export function esc(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
