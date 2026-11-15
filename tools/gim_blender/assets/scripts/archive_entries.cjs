// One deterministic inventory for the entire extracted package. IFC discovery
// is independent of CBM semantic links and of physical directory names.
const fs = require('node:fs');
const path = require('node:path');
function archiveEntries(root) {
  const entries = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
      const full=path.join(dir,e.name);
      if(e.isDirectory())walk(full);
      else if(e.isFile())entries.push({path:path.relative(root,full).replace(/\\/g,'/'),fullPath:full});
    }
  }
  walk(root);
  return entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
module.exports={archiveEntries};
