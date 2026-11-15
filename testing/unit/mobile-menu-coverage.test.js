// Every command in a desktop toolbar menu must be reachable on the phone (More / Studies / nav / header /
// selection bar) or be on the allow-list below with a reason. Adding a menu item that the phone cannot reach
// fails here instead of going unnoticed.
//   node testing/unit/mobile-menu-coverage.test.js
const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../../frontend/index.html', 'utf8');
const mobile = fs.readFileSync(__dirname + '/../../frontend/js/mobile.js', 'utf8');

// The markup of one <div class="toolbar-menu" id="..."> by counting div depth.
function menuBlock(id) {
  const start = html.indexOf(`id="${id}"`);
  assert(start > 0, `menu ${id} not found`);
  const from = html.lastIndexOf('<div', start);
  const re = /<div\b|<\/div>/g; re.lastIndex = from;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(from, re.lastIndex);
  }
  throw new Error('unbalanced ' + id);
}
const itemIds = (block) => [...block.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map(m => m[1]);

// What mobile.js builds from
const pages = mobile.match(/MENU_PAGES: \{([\s\S]*?)\n  \},/)[1];
const pageMenus = [...pages.matchAll(/menus: \[([^\]]*)\]/g)].flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
const skip = new Set([...mobile.match(/MENU_SKIP: new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
const tiles = new Set([...mobile.match(/MENU_TILES: \[([\s\S]*?)\n  \],/)[1].matchAll(/\['(btn-[a-z-]+)'/g)].map(x => x[1]));

// Reachable some other way on a phone
const elsewhere = {
  'btn-save': 'header Save button', 'btn-top-open': 'duplicate of File › Open', 'btn-top-save': 'header Save button', 'btn-top-share': 'duplicate of File › Share',
  'btn-edit-copy': 'selection bar', 'btn-edit-duplicate': 'selection bar', 'btn-edit-rotate': 'selection bar', 'btn-delete': 'selection bar',
  'btn-shape-rect': 'canvas Annotate mode', 'btn-shape-ellipse': 'canvas Annotate mode', 'btn-shape-note': 'canvas Annotate mode',
  'btn-undo': 'header undo', 'btn-redo': 'header redo',
  'btn-boq': 'Quantities page (btn-q-boq)', 'btn-cable-schedules': 'Quantities page (btn-q-cables)', 'btn-rates': 'Quantities page (btn-q-rates)', 'btn-meter-schedule': 'Quantities page (btn-q-meters)',
  'btn-toggle-ribbon': 'desktop component ribbon; the Parts sheet replaces it',
};
// File-menu items are all reachable through More search; the Analyse menu is the Studies sheet.
const viaSearch = new Set(pageMenus);
const reachableMenus = new Set(['menu-file', 'menu-analyse', ...pageMenus]);

let n = 0; const missing = [];
for (const menu of ['menu-file', 'menu-annotate', 'menu-edit', 'menu-view', 'menu-results', 'menu-analyse', 'menu-scenario', 'menu-export', 'menu-quantities']) {
  for (const id of itemIds(menuBlock(menu))) {
    n++;
    if (elsewhere[id] || tiles.has(id)) continue;
    if (reachableMenus.has(menu) && !skip.has(id)) continue;
    missing.push(`${menu} › ${id}`);
  }
}
assert.deepStrictEqual(missing, [], 'Not reachable on a phone: ' + missing.join(', '));
console.log(`ok ${n} desktop menu items are reachable on the phone`);
