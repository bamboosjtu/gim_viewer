import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const temporary=fileURLToPath(new URL('../tmp/tests/app/',import.meta.url));mkdirSync(temporary,{recursive:true});
process.env.TEMP=temporary;process.env.TMP=temporary;process.env.TMPDIR=temporary;
