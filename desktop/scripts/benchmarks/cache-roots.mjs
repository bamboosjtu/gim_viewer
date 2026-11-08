import {dirname,join} from 'node:path';
/** A cold/warm pair shares SQLite and WebView2 IndexedDB across processes. */
export const pairedWebviewProfile=dataRoot=>join(dirname(dataRoot),'webview-profile');
