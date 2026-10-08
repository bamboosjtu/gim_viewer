import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Channel } from '@tauri-apps/api/core';
import type { PowerlineProject, ProjectIdentity, TowerPreview } from '@gim/powerline-core';
export interface ProjectMeta { id: string; name: string; sha256: string; size: number; importedAt: number; lastOpenedAt: number; parserVersion: string; counts: Record<string, number> }
export interface Settings { tiandituKey: string; baseLayer: 'imagery' | 'vector' | 'terrain' | 'osm' | 'canvas' }
export interface ImportProgress { stage: string; done?: number; total?: number | null }
export interface Prepared { meta: ProjectMeta; duplicate: boolean; cache?: PowerlineProject | null }
export const native = isTauri();
export const previewMode = import.meta.env.DEV && !native;
async function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const r = indexedDB.open('gim-mobile-preview', 1); r.onupgradeneeded = () => { r.result.createObjectStore('projects'); r.result.createObjectStore('sources'); r.result.createObjectStore('previews'); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function local<T>(store: string, key: string, value?: unknown, remove = false): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => { const tx = d.transaction(store, value !== undefined || remove ? 'readwrite' : 'readonly'); const s = tx.objectStore(store); const r = remove ? s.delete(key) : value !== undefined ? s.put(value, key) : s.get(key); let result: T | undefined; r.onsuccess = () => { result = r.result as T; }; tx.oncomplete = () => { d.close(); resolve(result); }; tx.onerror = () => { d.close(); reject(tx.error); }; });
}
export async function getSettings(): Promise<Settings> { if (native) return invoke('get_settings'); const old = localStorage.getItem('gim-preview-settings'); return old ? JSON.parse(old) : fetch('/__dev/settings').then(r => r.json()); }
export async function saveSettings(settings: Settings): Promise<void> { if (native) return invoke('save_settings', { settings }); localStorage.setItem('gim-preview-settings', JSON.stringify(settings)); }
export async function listProjects(): Promise<ProjectMeta[]> {
  if (native) return invoke('list_projects');
  const d = await db(); return new Promise((resolve, reject) => { const tx = d.transaction('projects'); const r = tx.objectStore('projects').getAll(); r.onsuccess = () => { resolve((r.result as PowerlineProject[]).map(p => ({ id: p.id, name: p.name, sha256: p.sourceSha256, size: p.sourceSize, importedAt: 0, lastOpenedAt: 0, parserVersion: p.parserVersion, counts: p.counts }))); d.close(); }; r.onerror = () => reject(r.error); });
}
export async function chooseNativeFile(onProgress: (p: ImportProgress) => void): Promise<{ path: string; name: string; sha256: string; size: number; copyMs: number }> { return invoke('plugin:gim-import|pick', { progress: new Channel<ImportProgress>(onProgress) }); }
export async function discardImport(path: string): Promise<void> { if (native) await invoke("discard_import", { path }); }
export async function prepareNative(input: Awaited<ReturnType<typeof chooseNativeFile>>): Promise<Prepared> { return invoke('prepare_project', { input }); }
export async function loadCache(id: string): Promise<PowerlineProject | undefined> { return native ? (await invoke<PowerlineProject | null>('get_project_cache', { id })) ?? undefined : local('projects', id); }
export async function readEntries(id: string): Promise<{ path: string; text: string }[]> { return native ? invoke('read_text_entries', { id }) : (await local<{ path: string; text: string }[]>('sources', id)) ?? []; }
export async function commit(project: PowerlineProject): Promise<void> { if (native) return invoke('commit_project', { id: project.id, payloadJson: JSON.stringify(project) }); await local('projects', project.id, project); }
export async function readSource(id: string, path: string): Promise<string> { if (native) return invoke('read_source', { id, path }); return (await readEntries(id)).find(f => f.path.toLowerCase() === path.toLowerCase())?.text ?? ''; }
export async function deleteProject(id: string): Promise<void> { if (native) return invoke('delete_project', { id }); await local('projects', id, undefined, true); await local('sources', id, undefined, true); const d = await db(); const tx = d.transaction('previews', 'readwrite'); tx.objectStore('previews').delete(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`)); await new Promise<void>(r => { tx.oncomplete = () => { d.close(); r(); }; }); }
export async function previewCache(id: string, key: string, data?: TowerPreview): Promise<TowerPreview | undefined> { return native ? (await invoke<TowerPreview | null>('preview_cache', { id, key, data: data ?? null })) ?? undefined : local('previews', `${id}:${key}`, data); }
export async function cancelImport(): Promise<void> { if (native) await Promise.all([invoke('plugin:gim-import|cancel').catch(() => undefined), invoke('cancel_import').catch(() => undefined)]); }
export async function importProgress(callback: (p: ImportProgress) => void): Promise<() => void> {
  if (!native) return () => {};
  const remove = await listen<ImportProgress>('import-progress', e => callback(e.payload));
  return remove;
}
export async function sampleNames(): Promise<string[]> { if (!previewMode) return []; return fetch('/__dev/samples').then(r => r.json()); }
export async function prepareSample(name: string): Promise<{ identity: ProjectIdentity; files: { path: string; text: string }[] }> {
  if (!previewMode || !/^line0[1-6]$/.test(name)) throw new Error('无效预览样本');
  const data = await fetch(`/__dev/sample/${name}`).then(r => { if (!r.ok) throw new Error('样本输入未准备'); return r.json(); }); await local('sources', data.identity.id, data.files); return data;
}

export type LocationPermission = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';
export interface LocationPermissions { location: LocationPermission; coarseLocation: LocationPermission }
export interface CurrentPosition { longitude: number; latitude: number; accuracy: number; timestamp: number }
export function checkLocationPermissions(): Promise<LocationPermissions> { return invoke('plugin:gim-import|check_location_permissions'); }
export function requestLocationPermissions(): Promise<LocationPermissions> { return invoke('plugin:gim-import|request_location_permissions'); }
export function getPosition(): Promise<CurrentPosition> { return invoke('plugin:gim-import|get_position'); }
