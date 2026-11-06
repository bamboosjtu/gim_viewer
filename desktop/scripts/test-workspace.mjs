import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function workspaceTemp() {
 const root=fileURLToPath(new URL('../.tmp/tests/',import.meta.url));mkdirSync(root,{recursive:true});return root;
}
process.env.TEMP=workspaceTemp();process.env.TMP=workspaceTemp();process.env.TMPDIR=workspaceTemp();
