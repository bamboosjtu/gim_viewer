import {
  MOBILE_COMMANDS,
  IMPORT_PLUGIN_COMMANDS,
  MOBILE_PARSER_VERSION,
} from "@gim/contracts-native";
import type {
  ProjectMeta,
  Settings,
  ImportProgress,
  Prepared as NativePrepared,
} from "@gim/contracts-native";
export type {
  ProjectMeta,
  Settings,
  ImportProgress,
} from "@gim/contracts-native";
import { nativeError } from "@gim/contracts-native/errors.js";
import { invoke, isTauri } from "@tauri-apps/api/core";
async function invokeCommand<T>(
  command:
    | import("@gim/contracts-native").MobileCommand
    | import("@gim/contracts-native").ImportPluginCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw nativeError(error);
  }
}

import { listen } from "@tauri-apps/api/event";
import { Channel } from "@tauri-apps/api/core";
import type {
  PowerlineProject,
  ProjectIdentity,
  TowerPreview,
} from "@gim/powerline-core";

export type Prepared = NativePrepared<PowerlineProject>;
export const native = isTauri();
export const previewMode = import.meta.env.DEV && !native;
async function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("gim-mobile-preview", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("projects");
      r.result.createObjectStore("sources");
      r.result.createObjectStore("previews");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("本地预览存储读取失败"));
  });
}
async function local<T>(
  store: string,
  key: string,
  value?: unknown,
  remove = false,
): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(
      store,
      value !== undefined || remove ? "readwrite" : "readonly",
    );
    const s = tx.objectStore(store);
    const r = remove
      ? s.delete(key)
      : value !== undefined
        ? s.put(value, key)
        : s.get(key);
    let result: T | undefined;
    r.onsuccess = () => {
      result = r.result as T;
    };
    tx.oncomplete = () => {
      d.close();
      resolve(result);
    };
    tx.onerror = () => {
      d.close();
      reject(tx.error ?? new Error("本地预览存储事务失败"));
    };
  });
}
export async function getSettings(): Promise<Settings> {
  if (native) return invokeCommand(MOBILE_COMMANDS.get_settings);
  const old = localStorage.getItem("gim-preview-settings");
  return old
    ? (JSON.parse(old) as Settings)
    : fetch("/__dev/settings").then((r) => r.json() as Promise<Settings>);
}
export async function saveSettings(settings: Settings): Promise<void> {
  if (native) return invokeCommand(MOBILE_COMMANDS.save_settings, { settings });
  localStorage.setItem("gim-preview-settings", JSON.stringify(settings));
}
export async function listProjects(): Promise<ProjectMeta[]> {
  if (native) return invokeCommand(MOBILE_COMMANDS.list_projects);
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("projects");
    const r = tx.objectStore("projects").getAll();
    r.onsuccess = () => {
      resolve(
        (r.result as PowerlineProject[]).map((p) => ({
          id: p.id,
          name: p.name,
          sha256: p.sourceSha256,
          size: p.sourceSize,
          importedAt: 0,
          lastOpenedAt: 0,
          parserVersion: p.parserVersion,
          counts: p.counts,
        })),
      );
      d.close();
    };
    r.onerror = () => reject(r.error ?? new Error("本地预览存储读取失败"));
  });
}
export async function chooseNativeFile(
  onProgress: (p: ImportProgress) => void,
): Promise<{
  path: string;
  name: string;
  sha256: string;
  size: number;
  copyMs: number;
}> {
  return invokeCommand(IMPORT_PLUGIN_COMMANDS.pick, {
    progress: new Channel<ImportProgress>(onProgress),
  });
}
export async function discardImport(path: string): Promise<void> {
  if (native) await invokeCommand(MOBILE_COMMANDS.discard_import, { path });
}
export async function prepareNative(
  input: Awaited<ReturnType<typeof chooseNativeFile>>,
): Promise<Prepared> {
  const { path, name, sha256, size } = input;
  return invokeCommand(MOBILE_COMMANDS.prepare_project, {
    input: { path, name, sha256, size },
  });
}
export async function loadCache(
  id: string,
): Promise<PowerlineProject | undefined> {
  const project = native
    ? await invokeCommand<PowerlineProject | null>(
        MOBILE_COMMANDS.get_project_cache,
        { id },
      )
    : await local<PowerlineProject>("projects", id);
  return project?.parserVersion === MOBILE_PARSER_VERSION ? project : undefined;
}
export async function readEntries(
  id: string,
): Promise<{ path: string; text: string }[]> {
  return native
    ? invokeCommand(MOBILE_COMMANDS.read_text_entries, { id })
    : ((await local<{ path: string; text: string }[]>("sources", id)) ?? []);
}
export async function commit(project: PowerlineProject): Promise<void> {
  if (native)
    return invokeCommand(MOBILE_COMMANDS.commit_project, {
      id: project.id,
      payloadJson: JSON.stringify(project),
    });
  await local("projects", project.id, project);
}
export async function readSource(id: string, path: string): Promise<string> {
  if (native) return invokeCommand(MOBILE_COMMANDS.read_source, { id, path });
  return (
    (await readEntries(id)).find(
      (f) => f.path.toLowerCase() === path.toLowerCase(),
    )?.text ?? ""
  );
}
export async function deleteProject(id: string): Promise<void> {
  if (native) return invokeCommand(MOBILE_COMMANDS.delete_project, { id });
  await local("projects", id, undefined, true);
  await local("sources", id, undefined, true);
  const d = await db();
  const tx = d.transaction("previews", "readwrite");
  tx.objectStore("previews").delete(
    IDBKeyRange.bound(`${id}:`, `${id}:\uffff`),
  );
  await new Promise<void>((r) => {
    tx.oncomplete = () => {
      d.close();
      r();
    };
  });
}
export async function previewCache(
  id: string,
  key: string,
  data?: TowerPreview,
): Promise<TowerPreview | undefined> {
  return native
    ? ((await invokeCommand<TowerPreview | null>(
        MOBILE_COMMANDS.preview_cache,
        { id, key, data: data ?? null },
      )) ?? undefined)
    : local("previews", `${id}:${key}`, data);
}
export async function cancelImport(): Promise<void> {
  if (native)
    await Promise.all([
      invokeCommand(IMPORT_PLUGIN_COMMANDS.cancel).catch(() => undefined),
      invokeCommand(MOBILE_COMMANDS.cancel_import).catch(() => undefined),
    ]);
}
export async function importProgress(
  callback: (p: ImportProgress) => void,
): Promise<() => void> {
  if (!native) return () => {};
  const remove = await listen<ImportProgress>("import-progress", (e) =>
    callback(e.payload),
  );
  return remove;
}
export async function sampleNames(): Promise<string[]> {
  if (!previewMode) return [];
  return fetch("/__dev/samples").then((r) => r.json() as Promise<string[]>);
}
type PreviewSample = {
  identity: ProjectIdentity;
  files: { path: string; text: string }[];
};
export async function prepareSample(name: string): Promise<PreviewSample> {
  if (!previewMode || !/^line0[1-6]$/.test(name))
    throw new Error("无效预览样本");
  const data = await fetch(`/__dev/sample/${name}`).then((r) => {
    if (!r.ok) throw new Error("样本输入未准备");
    return r.json() as Promise<PreviewSample>;
  });
  await local("sources", data.identity.id, data.files);
  return data;
}

export type LocationPermission =
  "prompt" | "prompt-with-rationale" | "granted" | "denied";
export interface LocationPermissions {
  location: LocationPermission;
  coarseLocation: LocationPermission;
}
export interface CurrentPosition {
  longitude: number;
  latitude: number;
  accuracy: number;
  timestamp: number;
}
export function checkLocationPermissions(): Promise<LocationPermissions> {
  return invokeCommand(IMPORT_PLUGIN_COMMANDS.check_location_permissions);
}
export function requestLocationPermissions(): Promise<LocationPermissions> {
  return invokeCommand(IMPORT_PLUGIN_COMMANDS.request_location_permissions);
}
export function getPosition(): Promise<CurrentPosition> {
  return invokeCommand(IMPORT_PLUGIN_COMMANDS.get_position);
}

export interface WindowState {
  top: number;
  bottom: number;
  left: number;
  right: number;
  immersive: boolean;
  portraitLocked?: boolean;
}
export function getWindowState(): Promise<WindowState> {
  return invokeCommand(IMPORT_PLUGIN_COMMANDS.get_window_state);
}
export function setImmersive(enabled: boolean): Promise<WindowState> {
  return invokeCommand(IMPORT_PLUGIN_COMMANDS.set_immersive, { enabled });
}
export async function readHeader(id: string): Promise<number[]> {
  if (native) return invokeCommand(MOBILE_COMMANDS.read_project_header, { id });
  const names = await sampleNames();
  for (const name of names) {
    const data = await fetch(`/__dev/sample/${name}`).then(
      (r) => r.json() as Promise<PreviewSample>,
    );
    if (data.identity.id === id)
      return fetch(`/__dev/header/${name}`).then((r) => {
        if (!r.ok) throw new Error("头部读取失败");
        return r.json() as Promise<number[]>;
      });
  }
  throw new Error("源包头部不可用");
}
