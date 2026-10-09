// Regenerates protectionpro_mcp/component_catalog.json (types, ports, default props) from the
// frontend's COMPONENT_DEFS:  node clients/mcp/build_catalog.mjs
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../../frontend/js/constants.js'), 'utf8');
const ctx = vm.createContext({ console, structuredClone });
vm.runInContext(src + '\n;globalThis.__defs = COMPONENT_DEFS;', ctx);
const out = {};
for (const [type, d] of Object.entries(ctx.__defs)) {
  out[type] = {
    name: d.name, category: d.category,
    ports: (d.ports || []).map(p => p.id),
    dynamicPorts: !!d.dynamicPorts,
    defaults: JSON.parse(JSON.stringify(d.defaults || {})),
  };
}
fs.writeFileSync(path.join(here, 'protectionpro_mcp', 'component_catalog.json'), JSON.stringify(out, null, 1) + '\n');
console.log(Object.keys(out).length, 'types');
