// Named screen set-ups for capture.mjs. Each runs on a fresh page of the app.
import { seedPlan, planPoint, seedBoard } from './lib.mjs';

// A building project on the Plan tab with an empty, uncalibrated floor.
async function seedFloor(page) {
  await page.evaluate(() => { Workspaces.setType('building', []); switchWorkspace('plan'); });
  await page.waitForTimeout(600);
}

// A small floor-plan DXF as the import endpoint returns it: 42.3 × 18 m in
// millimetres, outer walls, partitions, two off/frozen layers.
function fakeDxf() {
  const L = (x1, y1, x2, y2, l) => ({ t: 'l', l: l || 'A-WALL', p: [x1, y1, x2, y2] });
  const ents = [L(0, 0, 42300, 0), L(42300, 0, 42300, 18000), L(42300, 18000, 0, 18000), L(0, 18000, 0, 0),
    L(0, 9000, 17000, 9000), L(17000, 0, 17000, 8000), L(17000, 10000, 17000, 18000), L(27000, 0, 27000, 18000),
    L(27000, 9800, 42300, 9800), L(17000, 8000, 17800, 8800, 'A-DOOR'), L(20000, 4000, 24000, 4000, 'A-FURN'), L(20000, 14000, 24000, 14000, 'A-FURN')];
  return { format: 2, units: { code: 4, m: 0.001, name: 'mm', metric: true }, origin: [0, 0], bbox: [0, 0, 42300, 18000],
    layers: [{ name: 'A-WALL', color: '#334155', on: true, frozen: false, n: 9 }, { name: 'A-DOOR', color: '#64748b', on: true, frozen: false, n: 1 },
      { name: 'A-FURN', color: '#94a3b8', on: false, frozen: false, n: 2 }, { name: 'A-DIMS', color: '#94a3b8', on: true, frozen: true, n: 0 }],
    blocks: {}, inserts: [], entities: ents, count: ents.length };
}
const toWorkspace = async (page, id, tab) => {
  await page.evaluate(() => switchWorkspace('schedules'));
  await page.waitForSelector('.sch-tab');
  await page.evaluate(i => Schedules.selectBoard(i), id);
  await page.click(`[data-sch-tab="${tab}"]`);
  await page.waitForTimeout(700);
};

const grid = (o) => async (page, h) => { const id = await h.seedBoard(page, o); await toWorkspace(page, id, 'grid'); return id; };

async function earthGrid(page) {
  await page.evaluate(() => {
    const bus = Canvas.placeComponent('bus', 600, 300);
    bus.props.name = 'MV Substation';
  });
  await page.click('#menu-analyse .toolbar-menu-btn');
  await page.click('#btn-earth-grids');
  await page.waitForSelector('#eg-rail');
  await page.click('[data-eg-act="new"]');
  await page.waitForSelector('#eg-preview .eg-plan', { timeout: 15000 });
}


// Road lighting: Street lighting ▸ Lighting design with a generic optic and a new design.
const roadDesign = async (page, { sweep = false, optimise = false, spacing } = {}) => {
  await page.evaluate(() => { Workspaces.setType('reticulation', []); switchWorkspace('streetlight'); });
  await page.waitForTimeout(500);
  await page.click('[data-sl="view"][data-view="design"]');
  await page.waitForTimeout(600);
  await page.click('[data-rl="new"]');
  await page.waitForSelector('#rl-main .rl-card', { timeout: 15000 });
  await page.waitForSelector('#rl-results .rl-verdict', { timeout: 20000 });
  if (spacing) {
    await page.fill('[data-dz="spacing"]', String(spacing));
    await page.dispatchEvent('[data-dz="spacing"]', 'change');
    await page.waitForTimeout(1500);
  }
  if (sweep) { await page.click('[data-rl="sweep"]'); await page.waitForSelector('.rl-best', { timeout: 30000 }); }
};


// A small radial single line: utility → CB → transformer → bus → CB → motor, drawn in the page.
const seedSld = async (page, { wired = true, select = null } = {}) => {
  await page.evaluate(() => { Workspaces.setType('network', []); switchWorkspace('sld'); });
  await page.waitForTimeout(500);
  return page.evaluate(({ wired, select }) => {
    const P = (t, x, y, props = {}) => { const c = Canvas.placeComponent(t, x, y); Object.assign(c.props, props); return c; };
    const u = P('utility', 560, 140, { name: 'Grid', voltage_kv: 11, fault_mva: 250 });
    const cb1 = P('cb', 560, 230, { name: 'CB1' });
    const t = P('transformer', 560, 330, { name: 'T1', rated_mva: 1, voltage_hv_kv: 11, voltage_lv_kv: 0.4 });
    const bus = P('bus', 560, 440, { name: 'LV Bus', voltage_kv: 0.4 });
    const cb2 = P('cb', 440, 520, { name: 'CB2' });
    const m = P('motor_induction', 440, 620, { name: 'M1' });
    if (wired) {
      AppState.addWire(u.id, 'out', cb1.id, 'top', true);
      AppState.addWire(cb1.id, 'bottom', t.id, 'primary', true);
      AppState.addWire(t.id, 'secondary', bus.id, 'at_0', true);
      AppState.addWire(bus.id, 'at_-120', cb2.id, 'top', true);
      AppState.addWire(cb2.id, 'bottom', m.id, 'in', true);
    }
    if (AppState.clearSelection) AppState.clearSelection();
    Properties.clear();
    Canvas.render();
    return { u: u.id, cb1: cb1.id, t: t.id, bus: bus.id, cb2: cb2.id, m: m.id };
  }, { wired, select });
};

export const SETUPS = {
  'sld-palette': { run: async (page) => {
    await page.evaluate(() => { Workspaces.setType('network', []); switchWorkspace('sld'); });
    await page.waitForTimeout(400);
    await page.fill('#component-search', 'trans');
    await page.waitForTimeout(500);
  } },
  'sld-drawn': { run: async (page) => { await seedSld(page); await page.waitForTimeout(400); }, viewport: { width: 1440, height: 900 } },
  'sld-wire': { run: async (page) => {
    const ids = await seedSld(page, { wired: false });
    await page.click('#btn-wire');
    await page.waitForTimeout(400);
    // Halfway through a drag: transformer secondary toward the bus bar.
    const box = async (id, port) => (await page.locator(`.sld-component[data-id="${id}"] [data-port="${port}"]:not(.conn-port)`).first().boundingBox());
    const a = await box(ids.t, 'secondary'), bus = await page.locator(`.sld-component[data-id="${ids.bus}"]`).first().boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(bus.x + bus.width / 2, bus.y - 8, { steps: 8 });
    await page.waitForTimeout(400);
  }, viewport: { width: 1440, height: 760 } },
  'sld-props': { run: async (page) => {
    const ids = await seedSld(page);
    await page.evaluate((id) => { AppState.select(id); Canvas.render(); Properties.show(id); }, ids.t);
    await page.waitForTimeout(600);
  } },
  'sld-multi': { run: async (page) => {
    const ids = await seedSld(page);
    await page.evaluate((ids) => { AppState.select(ids.cb1); AppState.toggleSelect(ids.t); AppState.toggleSelect(ids.bus); Canvas.render(); }, ids);
    await page.click('#menu-edit .toolbar-menu-btn');
    await page.waitForTimeout(500);
  }, viewport: { width: 1440, height: 900 } },
  'x-sld': { run: async (page) => { await seedSld(page); await page.evaluate(() => Canvas.zoomFit && Canvas.zoomFit()); await page.waitForTimeout(500); } },
  'road-design': { run: (page) => roadDesign(page), viewport: { width: 1500, height: 1000 } },
  'road-fail': { run: (page) => roadDesign(page, { spacing: 50 }), viewport: { width: 1500, height: 1000 } },
  'road-sweep': { run: (page) => roadDesign(page, { sweep: true, spacing: 50 }), viewport: { width: 1500, height: 1060 } },
  'road-suggest': { run: async (page) => { await roadDesign(page); await page.click('[data-rl-suggest="1"]'); await page.waitForTimeout(800); } },
  'road-opt': { run: async (page) => { await roadDesign(page); await page.click('[data-rl="optimise"]'); await page.waitForSelector('#rl-opt-modal [data-m="run"]'); await page.click('#rl-opt-modal [data-m="run"]'); await page.waitForSelector('#rl-opt-modal .rl-opt-table', { timeout: 60000 }); await page.waitForTimeout(500); } },
  'schedule-grid': { run: grid({ sections: false }) },

  'schedule-bulk': { run: async (page, h) => {
    await grid({ sections: false })(page, h);
    for (const n of [2, 3]) await page.check(`.db-schedule-grid tbody tr:nth-child(${n}) .db-sel-cell input`);
    await page.waitForSelector('#db-bulk-bar .db-bulk');
  } },

  'schedule-checked': { run: async (page, h) => {
    await grid({ sections: false })(page, h);
    await page.fill('#sch-group-n', '1'); await page.press('#sch-group-n', 'Enter');
    await page.waitForTimeout(500);
    await page.click('#db-check-circuits');
    await page.waitForTimeout(4000);
  } },

  'sections-panel': { run: async (page, h) => {
    await grid({ sections: true })(page, h);
    await page.click('#dbs-panel > summary');
    await page.waitForSelector('.dbs-card');
  } },

  'sections-tabs': { run: grid({ sections: true }) },

  'single-line': { run: async (page, h) => {
    const id = await h.seedBoard(page, { sections: false, accessories: true });
    await toWorkspace(page, id, 'drawing');
    await page.waitForSelector('.dbd-canvas svg');
    await page.click('[data-dbd="fit"]');
    await page.waitForTimeout(400);
  } },

  'ga-side-by-side': { run: async (page, h) => {
    const id = await h.seedBoard(page, { sections: true });
    await toWorkspace(page, id, 'ga');
    await page.waitForSelector('#ga-canvas svg');
  } },

  'ga-painted': { run: async (page, h) => {
    const id = await h.seedBoard(page, { sections: true });
    await toWorkspace(page, id, 'ga');
    await page.selectOption('[data-ga-set="section_layout"]', 'grid');
    await page.waitForTimeout(300);
    await page.fill('[data-ga-set="grid_cols"]', '3'); await page.press('[data-ga-set="grid_cols"]', 'Enter');
    await page.waitForTimeout(300);
    await page.fill('[data-ga-set="grid_rows"]', '2'); await page.press('[data-ga-set="grid_rows"]', 'Enter');
    await page.waitForTimeout(400);
    const paint = async (brush, cells) => {
      await page.click(`.ga-paint .ga-brush >> nth=${brush}`);
      for (const c of cells) { await page.click(`#ga-canvas [data-ga-cell="${c}"]`); await page.waitForTimeout(150); }
    };
    await paint(0, [3, 4, 5]);        // Normal: its first cell plus the whole bottom row = an L
    await page.waitForTimeout(300);
  } },

  'phone-list': { run: async (page, h) => {
    await h.seedBoard(page, { sections: true });
    await page.evaluate(() => switchWorkspace('schedules'));
    await page.waitForSelector('.smb-card', { timeout: 10000 });
  } },

  'phone-sheet': { run: async (page, h) => {
    await h.seedBoard(page, { sections: true });
    await page.evaluate(() => switchWorkspace('schedules'));
    await page.waitForSelector('.smb-card');
    await page.click('.smb-card >> nth=2');
    await page.waitForSelector('.smb-sheet.open');
  } },

  'phone-sections': { run: async (page, h) => {
    await h.seedBoard(page, { sections: true });
    await page.evaluate(() => switchWorkspace('schedules'));
    await page.waitForSelector('.smb-card');
    await page.click('[data-smb="sections"]');
    await page.waitForSelector('#smb-sec-sheet.open .dbs-card');
    await page.evaluate(() => document.querySelector('#smb-sec-sheet .dbs-actions').scrollIntoView({ block: 'end' }));
    await page.waitForTimeout(300);
  } },

  'output-menu': { run: async (page, h) => {
    await h.seedBoard(page, { sections: false });
    await page.evaluate(() => { AppState.clearSelection(); Canvas.render(); });
    await page.click('#menu-export .toolbar-menu-btn');
    await page.waitForSelector('#btn-export-dxf');
  } },

  'earth-grid': { run: earthGrid },

  'earth-grid-l': { run: async (page) => {
    await earthGrid(page);
    await page.selectOption('#eg-f-layout-type', 'l');
    await page.fill('#eg-f-layout-x_lines', '0, 3, 8, 15, 22, 27, 30'); await page.press('#eg-f-layout-x_lines', 'Enter');
    await page.selectOption('#eg-f-layout-diagonals', 'corner_meshes');
    await page.waitForTimeout(2000);
  } },

  'earth-grid-tools': { run: async (page) => {
    await earthGrid(page);
    await page.click('[data-eg-tool="conductor"]');
    const r = await page.evaluate(() => { const b = document.querySelector('#eg-preview .eg-plan').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    await page.mouse.click(r.x + r.w * 0.35, r.y + r.h * 0.4);
    await page.mouse.move(r.x + r.w * 0.6, r.y + r.h * 0.55);
    await page.waitForTimeout(400);
  } },

  'earth-grid-3d': { run: async (page) => {
    await earthGrid(page);
    await page.click('[data-eg-view="3d"]');
    await page.waitForTimeout(1500);
  } },

  // ── Tier 2 ──
  'plan-stacked': { run: async (page) => {
    await seedPlan(page);
    await page.evaluate(() => {
      const e1 = AppState.planMarkup.elements.find(x => x.name === 'E1');
      AppState.planMarkup.elements.push({ id: AppState.planGenId('pmel'), type: 'erf', x: e1.x + 1, y: e1.y, rotation: 0, name: 'E10', reticId: null, props: PLAN_DEFS.defaults('erf') });
      PlanEngine.requestDraw({ all: true });
    });
    const p = await planPoint(page, 'E1');
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(250);
  }, viewportFull: true },

  'plan-context': { run: async (page) => {
    await seedPlan(page);
    const p = await planPoint(page, 'K2');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.waitForSelector('#context-menu .dropdown-item');
  } },

  'plan-bulk': { run: async (page) => {
    await seedPlan(page);
    // One kiosk turned, so Rotation reads "mixed" across the selection.
    await page.evaluate(() => { AppState.planMarkup.elements.find(x => x.name === 'K1').rotation = 90; PlanEngine.requestDraw({ all: true }); });
    const p = await planPoint(page, 'K2');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.waitForSelector('#context-menu .dropdown-item');
    await page.click('#context-menu .dropdown-item:has-text("Select similar") >> nth=0');
    await page.waitForTimeout(500);
  } },

  'plan-scale': { run: async (page) => {
    await seedPlan(page, { scale: 0.75 });
    const p = await planPoint(page, 'K1');
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(400);
  } },

  'demand-linked': { run: async (page) => {
    await seedPlan(page);
    await page.click('.plan-mode-btn[data-mode="output"]');
    await page.click('[data-act="push"]');
    for (let i = 0; i < 3; i++) {   // "not calibrated" confirm, then the "Pushed to Reticulation" notice
      await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1500);
    if (await page.evaluate(() => !document.getElementById('plan-workspace') || document.getElementById('plan-workspace').style.display === 'none')) await page.evaluate(() => switchWorkspace('plan'));
    await page.evaluate(() => PlanMarkup.setMode('draw'));
    await page.waitForTimeout(500);
    const p = await planPoint(page, 'K2');
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(600);
  } },

  'plan-dxf-dialog': { run: async (page) => {
    await seedFloor(page);
    await page.evaluate((d) => { PlanDxfImport.askImport(d, 'GF-Electrical'); }, fakeDxf());
    await page.waitForSelector('.dxfi-content');
    await page.waitForTimeout(300);
  } },

  'plan-underlays': { run: async (page) => {
    await seedFloor(page);
    await page.evaluate((d) => { PlanDxfImport._addUnderlay(d, 'GF-Electrical'); }, fakeDxf());
    await page.waitForSelector('.dxfi-content');
    await page.click('.dxfi-actions .btn-primary');
    await page.waitForTimeout(1500);
    await page.evaluate(() => { PlanTools.set('select'); document.querySelectorAll('.toast').forEach(t => t.remove()); });
    await page.click('.plan-ul-name');
    await page.waitForTimeout(400);
  } },

  'plan-placebar': { run: async (page) => {
    await seedFloor(page);
    await page.evaluate(() => {
      AppState.planMarkup.settings.placeMemory = { bd_socket: { mode: 'array', cols: 4, rows: 3 } };
      PlanUI._folded = new Set();
      PlanUI.renderPalette();
    });
    await page.click('.plan-pal-item[data-type="bd_socket"]');
    await page.waitForTimeout(400);
  } },

  'demand-bulk': { run: async (page) => {
    await page.evaluate(() => { Workspaces.setType('reticulation', []); switchWorkspace('retic'); });
    await page.waitForTimeout(500);
    await page.click('button:has-text("Build")');
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelectorAll('.kiosk-card summary, .kiosk-head, [data-action="toggle-kiosk"]').forEach((e, i) => { if (i === 0) e.click(); }));
    await page.waitForTimeout(400);
    const boxes = page.locator('[data-action="sel-erf"]');
    const n = await boxes.count();
    for (let i = 0; i < Math.min(3, n); i++) await boxes.nth(i).check().catch(() => {});
    await page.waitForTimeout(400);
  } },

  'demand-mv': { run: async (page) => {
    await page.evaluate(() => { Workspaces.setType('reticulation', []); switchWorkspace('retic'); });
    await page.waitForTimeout(500);
    await page.click('button:has-text("Build")');
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const m2 = Retic.addMinisub && Retic.addMinisub();
      const ms = Retic.minisubs || AppState.reticulation.minisubs;
      if (ms.length > 1) { ms[1].name = 'Minisub 2'; ms[1].mvFedFrom = ms[0].id; ms[1].mvLength = 350; }
      Retic.render && Retic.render();
    });
    await page.click('[data-action="diagram"]');
    await page.waitForTimeout(900);
  } },

  'sl-circuit': { run: async (page) => {
    await page.evaluate(() => { Workspaces.setType('reticulation', []); switchWorkspace('streetlight'); });
    await page.waitForTimeout(500);
    await page.click('button:has-text("+ New circuit")');
    await page.waitForTimeout(900);
  } },

  'sl-spur': { run: async (page) => {
    await page.evaluate(() => { Workspaces.setType('reticulation', []); switchWorkspace('streetlight'); });
    await page.waitForTimeout(500);
    await page.click('button:has-text("+ New circuit")');
    await page.waitForTimeout(800);
    await page.evaluate(() => { document.querySelector('#streetlight-workspace table')?.scrollIntoView(); });
    // Pole 6 fed from pole 3 makes a spur.
    const sel = page.locator('#streetlight-workspace table tbody tr:nth-child(6) select').first();
    await sel.selectOption({ label: 'P03' });
    await page.waitForTimeout(700);
  } },

  'sl-quick': { run: async (page) => {
    await page.evaluate(() => { Workspaces.setType('reticulation', []); switchWorkspace('streetlight'); });
    await page.waitForTimeout(500);
    await page.click('button:has-text("Quick calc")');
    await page.waitForTimeout(800);
  } },

  'trip-tm': { run: async (page) => {
    await tripSetup(page, 'mccb_160a');
  }, viewport: { width: 1440, height: 1300 } },

  'trip-edited': { run: async (page) => {
    await tripSetup(page, 'mccb_160a');
    const d = page.locator('[data-tu-dial]').first();
    const opts = await d.locator('option').allTextContents();
    await d.selectOption({ index: Math.max(0, opts.length - 2) });
    await page.waitForTimeout(500);
  }, viewport: { width: 1440, height: 1300 } },

  'trip-electronic': { run: async (page) => {
    await tripSetup(page, 'mccb_400a');
  }, viewport: { width: 1440, height: 1400 } },

  'lib-overview': { run: async (page) => { await openLibs(page); await page.click('#lib-main table tbody tr >> nth=3'); await page.waitForTimeout(400); } },

  'lib-edited': { run: async (page) => {
    await openLibs(page);
    const inp = page.locator('#lib-main table tbody tr:nth-child(4) input[data-key="r_per_km"]').first();
    await inp.click(); await inp.fill('0.52'); await inp.press('Enter');
    await page.waitForTimeout(500);
    // Select another row and back so the detail pane re-reads the entry.
    await page.click('#lib-main table tbody tr:nth-child(6) td:nth-child(7)');
    await page.waitForTimeout(250);
    await page.click('#lib-main table tbody tr:nth-child(4) td:nth-child(7)');
    await page.waitForTimeout(500);
  } },

  'lib-teams': { run: async (page) => {
    await page.evaluate(async () => {
      const lib = await API.request('/shared-libraries', 'POST', { name: 'Contractor standards' });
      await StandardData.reloadShared && StandardData.reloadShared();
    });
    await openLibs(page);
    await page.click('[data-lview="teams"]');
    await page.waitForTimeout(900);
  } },

  // Reticulation with a string breaker set and the Demand calculation run, so the earth-fault check has data.
  'retic-ef': { run: async (page) => { await reticEarthFault(page); await page.evaluate(() => ReticTcc.open(Retic.kiosks[0].id)); await page.waitForTimeout(800); } },
  'retic-ef-band': { run: async (page) => { await reticEarthFault(page); await page.evaluate(() => ReticTcc.open(Retic.kiosks[0].id)); await page.waitForTimeout(800);
    await page.evaluate(() => { document.querySelectorAll('#rtcc-body input[type=checkbox]').forEach(c => { if (/i.?t/i.test(c.closest('label')?.textContent || '') && !c.checked) c.click(); }); });
    await page.waitForTimeout(500); } },
  'retic-fault-diagram': { run: async (page) => { await reticEarthFault(page); await page.click('[data-action="diagram"]'); await page.waitForTimeout(800);
    await page.click('.rdg-seg button >> text=Fault current'); await page.waitForTimeout(800); } },

  // A board whose way 1 and incomer are library breakers, checked, with the Coord mini TCC open.
  'db-coord': { run: async (page) => {
    const id = await seedBoard(page);
    await page.evaluate((id) => {
      const b = AppState.components.get(id);
      const cb = STANDARD_CBS.find(x => x.cb_type === 'mccb' && x.trip_rating_a >= 100 && (x.rated_voltage_kv || 0.4) <= 1);
      const mcb = STANDARD_CBS.find(x => x.cb_type === 'mcb' && x.trip_rating_a === 20 && x.mcb_curve === 'C');
      if (cb) b.props.incoming_device = 'cb:' + cb.id;
      b.props.ik_max_ka = 10;
      if (mcb) b.props.circuits.slice(2, 6).forEach(w => { w.device = 'cb:' + mcb.id; });
    }, id);
    await toWorkspace(page, id, 'grid');
    await page.click('#db-check-circuits'); await page.waitForTimeout(4000);
    await page.click('.db-schedule-grid tbody tr:nth-child(3) td.db-coord'); await page.waitForTimeout(1000);
  } },

  'lib-import': { run: async (page) => { await openLibs(page); await page.click('[data-lview="export"]'); await page.waitForTimeout(500);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="import-json"]')]);
    await fc.setFiles(new URL('../vendor-libraries/cbi_breakers.json', import.meta.url).pathname);
    await page.waitForTimeout(600); } },

  'settings-cascading': { run: async (page) => { await page.evaluate(() => { StandardData.openSettings ? StandardData.openSettings() : document.getElementById('btn-settings')?.click(); });
    await page.waitForTimeout(600); } },

  'notifications': { run: async (page) => { await page.click('#btn-notifications'); await page.waitForTimeout(800); } },

  'quote-menu': { run: async (page) => {
    await page.click('#menu-file .toolbar-menu-btn');
    await page.waitForSelector('#btn-quote');
  } },

  'quote-locked': { run: async (page) => {
    await page.evaluate(() => {
      AppState.quoted = { at: new Date().toISOString(), by: 'guides@test.local', note: 'Quote Q-2041' };
      AppState.quoteLog = [{ event: 'quoted', at: AppState.quoted.at, by: AppState.quoted.by, note: AppState.quoted.note }];
      Quote.refresh();
    });
    await page.click('#menu-export .toolbar-menu-btn');
    await page.click('#btn-rates');
    await page.waitForTimeout(900);
  } },
};

async function reticEarthFault(page) {
  await page.evaluate(() => { Workspaces.setType('reticulation', []); switchWorkspace('retic'); });
  await page.waitForTimeout(500);
  const ids = await page.evaluate(() => {
    const lv = STANDARD_CABLES.filter(c => (c.voltage_kv || c.rated_voltage_kv || 0.4) <= 1 && /armou?red|xlpe|pvc/i.test(JSON.stringify(c)));
    const pick = (cores, mm2) => (lv.find(c => c.cores === cores && Number(c.size_mm2 || c.area_mm2 || c.cross_section_mm2) === mm2) || lv.find(c => c.cores === cores) || {}).id;
    const nm = (cores, mm2) => (lv.find(c => c.cores === cores && Number(c.size_mm2) === mm2) || lv.find(c => c.cores === cores) || {}).name;
    return { svc: nm(2, 16), fdr: nm(4, 95) };
  });
  await page.evaluate(({ svc, fdr }) => { Retic.settings.quickServiceCable = svc; Retic.settings.quickFeederCable = fdr; }, ids);
  await page.click('button:has-text("Build")');
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const h = Retic.kiosks[0];
    const cb = STANDARD_CBS.find(x => x.cb_type === 'mccb' && (x.rated_voltage_kv || 0.4) <= 1 && x.trip_rating_a >= 160);
    Retic.kiosks.forEach((k, i) => { k.fedFrom = i ? Retic.kiosks[i - 1].id : Retic.minisubs[0].id; });
    const ecc = (STANDARD_CABLES.find(c => c.construction === 'earth' && c.conductor === 'Cu' && c.size_mm2 === 16) || {}).name;
    Retic.kiosks.forEach(k => { k.feederEarth = ecc; k.erfs.forEach(e => { e.earthCable = ecc; }); });
    h.protection = 'cb:' + cb.id;
    Retic.renderKiosks(); Retic.recompute();
  });
  await page.waitForTimeout(3500);
}

async function openLibs(page) {
  await page.click('#menu-file .toolbar-menu-btn');
  await page.click('#btn-libraries');
  await page.waitForSelector('#lib-main table tbody tr');
}

async function tripSetup(page, cbId) {
  await page.evaluate((id) => {
    const c = Canvas.placeComponent('cb', 600, 300);
    c.props.rated_voltage_kv = 0.4;
    AppState.select(c.id); Properties.show(c.id);
    window.__cb = c.id;
  }, cbId);
  await page.waitForTimeout(500);
  // Choose the library breaker through the same change handler the picker uses.
  await page.evaluate((id) => {
    const sel = document.querySelector('[data-field="standard_type"]');
    if (!sel) throw new Error('no standard_type select');
    if (![...sel.options].some(o => o.value === id)) { const o = document.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o); }
    sel.value = id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, cbId);
  await page.waitForTimeout(800);
}

// ── Tier 3 ──
Object.assign(SETUPS, {
  'lightning-1': { run: async (page) => {
    await page.click('#menu-analyse .toolbar-menu-btn');
    await page.click('#btn-lightning');
    await page.waitForSelector('#lightning-modal [data-lr-panel="1"]');
  } },
  'lightning-2': { run: async (page) => {
    await openLightning(page);
    await page.click('[data-lr-go="2"]'); await page.waitForTimeout(400);
  } },
  'lightning-3': { run: async (page) => {
    await openLightning(page);
    await page.click('[data-lr-go="3"]'); await page.waitForTimeout(400);
  } },
  'lightning-results': { run: async (page) => {
    await openLightning(page);
    await page.click('[data-lr-go="4"]'); await page.waitForTimeout(300);
    await page.click('#btn-run-lightning');
    await page.waitForSelector('.lr-verdict', { timeout: 20000 });
  } },

  'cf-all': { run: async (page) => { await cableNetwork(page); }, viewport: { width: 1440, height: 1300 } },
  'cf-focus': { run: async (page) => {
    await cableNetwork(page);
    await page.evaluate(() => {
      const bus = [...AppState.components.values()].find(c => c.type === 'bus' && /11kV Bus/.test(c.props.name));
      AppState.select(bus.id); Canvas.render();
      CableFocus.enable(bus.id);
    });
    await page.waitForTimeout(500);
  }, viewport: { width: 1440, height: 1300 } },

  'ctrlk': { run: async (page) => { await page.keyboard.press('Control+k'); await page.keyboard.type('arc'); await page.waitForTimeout(400); } },
  'menu-analyse': { run: async (page) => { await page.click('#menu-analyse .toolbar-menu-btn'); await page.waitForTimeout(300); } },
  'menu-results': { run: async (page) => {
    await cableNetwork(page);
    await page.click('#menu-results .toolbar-menu-btn'); await page.waitForTimeout(300);
  } },

  'type-new': { run: async (page) => {
    await page.click('#menu-file .toolbar-menu-btn'); await page.click('#btn-new');
    await page.waitForSelector('.ws-type-card');
    await page.click('.ws-type-card >> nth=0');
  } },
  'type-dialog': { run: async (page) => {
    await page.click('#menu-file .toolbar-menu-btn'); await page.click('#btn-project-type');
    await page.waitForSelector('.ws-type-card');
  } },
});

async function openLightning(page) {
  await page.click('#menu-analyse .toolbar-menu-btn');
  await page.click('#btn-lightning');
  await page.waitForSelector('#lightning-modal [data-lr-panel="1"]');
  await page.waitForTimeout(300);
}

// The 33/11 kV template with a cable sizing run: result boxes on every cable.
async function cableNetwork(page) {
  await page.click('#menu-file .toolbar-menu-btn'); await page.click('#btn-templates');
  await page.click('.template-load-btn[data-id="substation_33_11"]');
  await page.waitForTimeout(1200);
  await page.click('#menu-analyse .toolbar-menu-btn'); await page.click('#btn-cable-sizing');
  for (let i = 0; i < 24; i++) {
    const pv = page.locator('#validation-proceed');
    if (await pv.isVisible().catch(() => false)) await pv.click();
    if (await page.evaluate(() => !!AppState.cableSizingResults)) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelectorAll('.modal').forEach(m => { if (m.id !== 'lightning-modal') m.style.display = 'none'; }));
  await page.evaluate(() => { Canvas.fitToView && Canvas.fitToView(); });
  await page.waitForTimeout(400);
}

// ── Studies and the TCC ──
async function loadTemplate(page, id) {
  await page.click('#menu-file .toolbar-menu-btn'); await page.click('#btn-templates');
  await page.click(`.template-load-btn[data-id="${id}"]`);
  await page.waitForTimeout(1200);
}
async function runStudy(page, btn, field) {
  await page.click('#menu-analyse .toolbar-menu-btn'); await page.click(btn);
  for (let i = 0; i < 30; i++) {
    const pv = page.locator('#validation-proceed');
    if (await pv.isVisible().catch(() => false)) await pv.click();
    if (await page.evaluate(f => !!AppState[f], field)) break;
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(900);
}
// Tag the open results window so a picture can clip to it.
async function markModal(page) {
  await page.evaluate(() => {
    const m = [...document.querySelectorAll('.modal')].filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0)
      .sort((a, b) => (+getComputedStyle(b).zIndex || 0) - (+getComputedStyle(a).zIndex || 0))[0];
    if (m) m.setAttribute('data-hg-cap', '1');
  });
}
async function closeModals(page) {
  await page.evaluate(() => document.querySelectorAll('.modal').forEach(m => { m.style.display = 'none'; }));
  await page.waitForTimeout(300);
}
async function openTcc(page, { miscord = false } = {}) {
  await loadTemplate(page, 'industrial_plant');
  if (miscord) {
    // Make the main incomer trip before the LV main it feeds.
    await page.evaluate(() => {
      const by = n => [...AppState.components.values()].find(c => c.props && c.props.name === n);
      const up = by('Main Incomer'), dn = by('LV Main');
      Object.assign(up.props, { thermal_pickup: 0.7, magnetic_pickup: 2, long_time_delay: 2 });
      Object.assign(dn.props, { long_time_delay: 30, magnetic_pickup: 10 });
    });
  }
  await runStudy(page, '#btn-run-fault', 'faultResults');
  await closeModals(page);
  await page.click('#menu-analyse .toolbar-menu-btn'); await page.click('#btn-tcc');
  await page.waitForSelector('#tcc-modal .tcc-canvas-wrap');
  await page.waitForTimeout(1200);
}

const TCC_VP = { width: 1500, height: 950 };
Object.assign(SETUPS, {
  'tcc-open': { run: async (page) => { await openTcc(page); }, viewport: TCC_VP },
  'tcc-faults': { run: async (page) => { await openTcc(page); await page.click('#btn-tcc-fault-menu'); await page.waitForTimeout(400); }, viewport: TCC_VP },
  'tcc-cursor': { run: async (page) => {
    await openTcc(page);
    await page.click('#btn-tcc-cursor');
    const r = await page.evaluate(() => { const b = document.getElementById('tcc-canvas').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    await page.mouse.click(r.x + r.w * 0.55, r.y + r.h * 0.45);
    await page.waitForTimeout(600);
  }, viewport: TCC_VP },
  'tcc-compare': { run: async (page) => { await openTcc(page); await page.click('#btn-tcc-compare'); await page.waitForTimeout(800); }, viewport: TCC_VP },
  'tcc-select': { run: async (page) => {
    await openTcc(page);
    await page.locator('#tcc-device-list >> text=CB-M1').first().click();
    await page.waitForTimeout(600);
  }, viewport: TCC_VP },
  'tcc-add': { run: async (page) => { await openTcc(page); await page.getByRole('button', { name: '+ Add device' }).click(); await page.waitForTimeout(500); }, viewport: TCC_VP },
  'tcc-saveas': { run: async (page) => { await openTcc(page); await page.click('#btn-tcc-view-saveas'); await page.waitForTimeout(500); }, viewport: TCC_VP },
  'tcc-coord': { run: async (page) => { await openTcc(page, { miscord: true }); await page.click('#btn-tcc-detect-miscord'); await page.waitForTimeout(900); }, viewport: TCC_VP },
  'tcc-autocoord': { run: async (page) => {
    await openTcc(page, { miscord: true });
    await page.click('#btn-tcc-detect-miscord'); await page.waitForTimeout(600);
    await page.click('#btn-tcc-auto-coord'); await page.waitForTimeout(1500);
  }, viewport: TCC_VP },
  'tcc-sequence': { run: async (page) => {
    await openTcc(page);
    await page.locator('.tcc-drawer-tab', { hasText: 'Sequence' }).click();
    await page.click('#btn-tcc-verify-seq'); await page.waitForTimeout(1200);
  }, viewport: TCC_VP },

  'study-fault': { run: async (page) => { await loadTemplate(page, 'industrial_plant'); await runStudy(page, '#btn-run-fault', 'faultResults'); await closeModals(page); }, viewport: { width: 1500, height: 1100 } },
  'study-loadflow': { run: async (page) => { await loadTemplate(page, 'industrial_plant'); await runStudy(page, '#btn-run-loadflow', 'loadFlowResults'); await closeModals(page); }, viewport: { width: 1500, height: 1100 } },
  'study-arcflash': { run: async (page) => { await loadTemplate(page, 'industrial_plant'); await runStudy(page, '#btn-arcflash', 'arcFlashResults'); await markModal(page); } },
  'menu-output': { run: async (page) => {
    await loadTemplate(page, 'industrial_plant'); await runStudy(page, '#btn-arcflash', 'arcFlashResults'); await closeModals(page);
    await page.click('#menu-export .toolbar-menu-btn'); await page.waitForSelector('#btn-export-aflabels');
  } },
  'study-cable': { run: async (page) => { await loadTemplate(page, 'industrial_plant'); await runStudy(page, '#btn-cable-sizing', 'cableSizingResults'); } },
  'study-cable-canvas': { run: async (page) => { await loadTemplate(page, 'industrial_plant'); await runStudy(page, '#btn-cable-sizing', 'cableSizingResults'); await closeModals(page); }, viewport: { width: 1500, height: 1100 } },
  'study-motor': { run: async (page) => { await loadTemplate(page, 'industrial_plant'); await runStudy(page, '#btn-motor-starting', 'motorStartingResults'); await markModal(page); } },
  'study-motor-canvas': { run: async (page) => { await loadTemplate(page, 'industrial_plant'); await runStudy(page, '#btn-motor-starting', 'motorStartingResults'); await closeModals(page); }, viewport: { width: 1500, height: 1100 } },
  'study-duty': { run: async (page) => { await loadTemplate(page, 'industrial_plant'); await runStudy(page, '#btn-duty-check', 'dutyCheckResults'); await markModal(page); }, viewport: { width: 1500, height: 1000 } },
  'study-grounding': { run: async (page) => { await loadTemplate(page, 'ver_grounding'); await runStudy(page, '#btn-grounding', 'groundingResults'); await markModal(page); } },
});

// ── The remaining studies ─────────────────────────────────────────────────
// A plant with a VFD (harmonic source) and a battery on the MCC bus.
async function plantNetwork(page) {
  await loadTemplate(page, 'industrial_plant');
  await page.evaluate(() => {
    const bus = [...AppState.components.values()].find(c => c.type === 'bus' && /MCC/.test(c.props.name));
    const vfd = Canvas.placeComponent('vfd', 700, 520);
    Object.assign(vfd.props, { rated_kw: 110, voltage_kv: 0.4, name: 'VFD P1' });
    const batt = Canvas.placeComponent('battery', 760, 560);
    Object.assign(batt.props, { name: 'BESS', voltage_kv: 0.4 });
    AppState.addWire(vfd.id, 'in', bus.id, 'at_-20', true);
    AppState.addWire(batt.id, 'out', bus.id, 'at_40', true);
    // A compressor that starts repeatedly, so the flicker screening has something to judge.
    for (const c of AppState.components.values()) if (c.type === 'motor_induction' && /Compressor/.test(c.props.name)) c.props.flicker_starts_per_hour = 12;
    AppState.clearSelection(); Canvas.render();
  });
  await page.waitForTimeout(400);
}
// A small control circuit: supply, MCB, start button, coil, and a lamp via the coil's contact.
async function controlCircuit(page) {
  await page.evaluate(() => {
    const P = (t, x, y, props) => { const c = Canvas.placeComponent(t, x, y); Object.assign(c.props, props || {}); return c; };
    const sup = P('ctl_supply', 500, 150), q1 = P('ctl_breaker', 400, 250), s1 = P('ctl_pb_no', 400, 340, { name: 'S1' });
    const k1 = P('ctl_coil', 400, 430, { name: 'K1', tag: 'K1' });
    const c1 = P('ctl_contact_no', 600, 340, { name: 'K1.1', tag: 'K1' }), h1 = P('ctl_lamp', 600, 430, { name: 'H1' });
    const w = (a, ap, b, bp) => AppState.addWire(a.id, ap, b.id, bp, true);
    w(sup, 'l', q1, 'top'); w(q1, 'bottom', s1, 'top'); w(s1, 'bottom', k1, 'top'); w(k1, 'bottom', sup, 'n');
    w(q1, 'bottom', c1, 'top'); w(c1, 'bottom', h1, 'top'); w(h1, 'bottom', sup, 'n');
    AppState.clearSelection(); Canvas.render(); Canvas.fitToView && Canvas.fitToView();
  });
  await page.waitForTimeout(500);
}
async function selectNamed(page, names) {
  await page.evaluate((names) => {
    AppState.clearSelection();
    for (const n of names) { const c = [...AppState.components.values()].find(x => x.props && x.props.name === n); AppState.selectedIds.add(c.id); }
    Canvas.render();
  }, names);
}
async function waitModal(page, timeout = 15000) {
  await page.waitForFunction(() => [...document.querySelectorAll('.modal')].some(m => getComputedStyle(m).display !== 'none' && m.getBoundingClientRect().width > 0), null, { timeout }).catch(() => {});
  await page.waitForTimeout(800);
}
// study(spec): { tpl | seed, pre, btn, run } → { config, results } setups.
function study(spec) {
  const open = async (page) => {
    if (spec.seed === 'plant') await plantNetwork(page); else await loadTemplate(page, spec.tpl);
    if (spec.pre) await spec.pre(page);
    await page.click('#menu-analyse .toolbar-menu-btn'); await page.click(spec.btn);
    await waitModal(page);
    for (let i = 0; i < 3; i++) { const pv = page.locator('#validation-proceed'); if (await pv.isVisible().catch(() => false)) { await pv.click(); await page.waitForTimeout(600); } }
  };
  return {
    config: { run: async (page) => { await open(page); await markModal(page); }, viewport: spec.viewport },
    results: { run: async (page) => {
      await open(page);
      if (spec.run) { await page.click(spec.run); await page.waitForTimeout(2500); await waitModal(page); }
      await markModal(page);
    }, viewport: spec.viewport },
  };
}
const SPECS = {
  'ts': { tpl: 'industrial_plant', btn: '#btn-timeseries', run: '#btn-tsl-run' },
  'lfs': { tpl: 'industrial_plant', btn: '#btn-lf-study' },
  'opf': { tpl: 'industrial_plant', btn: '#btn-opf', run: '#btn-opf-run' },
  'dclf': { tpl: 'ver_dc_lf', btn: '#btn-dc-loadflow' },
  'ansi': { tpl: 'industrial_plant', btn: '#btn-fault-ansi' },
  'openc': { tpl: 'ver_unbalanced_lf', btn: '#btn-open-conductor', pre: p => selectNamed(p, ['Ln']) },
  'twoopen': { tpl: 'ver_unbalanced_lf', btn: '#btn-two-conductor-open', pre: p => selectNamed(p, ['Ln']) },
  'simul': { tpl: 'ver_unbalanced_lf', btn: '#btn-simultaneous-fault', pre: p => selectNamed(p, ['Ln', 'Src']) },
  'dcsc': { tpl: 'ver_dc_sc', btn: '#btn-dc-shortcircuit' },
  'dynmot': { tpl: 'industrial_plant', btn: '#btn-dynamic-motor', run: '#btn-dynmot-run' },
  'trans': { tpl: 'generator_island', btn: '#btn-transient-stability', run: '#btn-stability-run' },
  'vstab': { tpl: 'ver_lf_3bus', btn: '#btn-voltage-stability', run: '#btn-vstab-run' },
  'harm': { seed: 'plant', btn: '#btn-harmonics' },
  'fscan': { seed: 'plant', btn: '#btn-frequency-scan', run: '#btn-fscan-run' },
  'filt': { seed: 'plant', btn: '#btn-filter-sizing', run: '#btn-flt-run' },
  'flk': { seed: 'plant', btn: '#btn-flicker', run: '#btn-flk-run' },
  'cont': { tpl: 'substation_33_11', btn: '#btn-contingency', run: '#btn-contingency-run' },
  'hc': { tpl: 'substation_33_11', btn: '#btn-hosting-capacity', run: '#btn-hc-run' },
  'cpl': { tpl: 'substation_33_11', btn: '#btn-cap-placement', run: '#btn-cpl-run' },
  'rel': { tpl: 'substation_33_11', btn: '#btn-reliability' },
  'bsz': { seed: 'plant', btn: '#btn-battery-sizing', run: '#btn-bsz-run' },
  'backup': { seed: 'plant', btn: '#btn-backup-study' },
  'div': { tpl: 'ver_diversity', btn: '#btn-load-diversity' },
  'race': { tpl: 'industrial_plant', btn: '#btn-raceway' },
  'seq': { tpl: 'industrial_plant', btn: '#btn-sequence-op', run: '#btn-sequence-run', pre: async p => { await runStudy(p, '#btn-run-fault', 'faultResults'); await closeModals(p); } },
  'compl': { tpl: 'industrial_plant', btn: '#btn-compliance', pre: async p => { await runStudy(p, '#btn-run-fault', 'faultResults'); await closeModals(p); await runStudy(p, '#btn-run-loadflow', 'loadFlowResults'); await closeModals(p); } },
  'wenner': { tpl: 'industrial_plant', btn: '#btn-wenner' },
};
for (const [k, spec] of Object.entries(SPECS)) {
  const s = study(spec);
  SETUPS[`x-${k}-config`] = s.config;
  SETUPS[`x-${k}-results`] = s.results;
}
SETUPS['x-unbal'] = { run: async (page) => { await loadTemplate(page, 'ver_unbalanced_lf'); await runStudy(page, '#btn-run-unbalanced-loadflow', 'unbalancedLoadFlowResults'); await closeModals(page); }, viewport: { width: 1500, height: 1000 } };
SETUPS['x-control'] = { run: async (page) => { await controlCircuit(page); await page.click('#menu-analyse .toolbar-menu-btn'); await page.click('#btn-control-sim'); await page.waitForTimeout(1500); } };
SETUPS['x-wenner-results'] = { run: async (page) => {
  await loadTemplate(page, 'industrial_plant');
  await page.click('#menu-analyse .toolbar-menu-btn'); await page.click('#btn-wenner');
  await waitModal(page);
  const rho = ['118', '135', '170', '215', '260'];
  const inputs = page.locator('#wenner-modal input');
  const n = await inputs.count();
  // inputs alternate spacing, resistivity per row
  for (let i = 0; i < Math.min(5, Math.floor(n / 2)); i++) await inputs.nth(i * 2 + 1).fill(rho[i]);
  await page.click('#btn-wenner-run'); await page.waitForTimeout(1500);
  await markModal(page);
} };

