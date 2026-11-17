import {DESKTOP_COMMANDS} from './contracts.js';
import { invoke } from '@tauri-apps/api/core';
export function saveEngineeringTreeJson(filename: string, content: string): Promise<string | null> {
  return invoke(DESKTOP_COMMANDS.save_engineering_tree_json, { filename, content });
}
