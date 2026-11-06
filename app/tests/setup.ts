import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const temporary=resolve('.tmp/tests');mkdirSync(temporary,{recursive:true});
process.env.TEMP=temporary;process.env.TMP=temporary;process.env.TMPDIR=temporary;
