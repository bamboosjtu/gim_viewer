import {dirname,join} from 'node:path';
import {existsSync,readdirSync} from 'node:fs';
import {workspacePath} from './samples.mjs';
/** A cold/warm pair shares SQLite and WebView2 IndexedDB across processes. */
export const pairedWebviewProfile=dataRoot=>join(dirname(dataRoot),'webview-profile');
export function checkedWebviewProfile(root,dataRoot,cacheState){
  const proposed=pairedWebviewProfile(dataRoot);
  const profile=workspacePath(root,proposed,existsSync(proposed));
  if(cacheState==='cold'&&existsSync(profile)&&readdirSync(profile).length)
    throw Error('Cold WebView2 profile must be new/empty');
  return profile;
}
