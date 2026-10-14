// Named screen set-ups for capture.mjs. Each runs on a fresh page of the app.
import { seedPlan, planPoint } from './lib.mjs';
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

export const SETUPS = {
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
    await page.click('[data-action="push"]');
    for (let i = 0; i < 3; i++) {   // "not calibrated" confirm, then the "Pushed to Reticulation" notice
      await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1500);
    if (await page.evaluate(() => !document.getElementById('plan-workspace') || document.getElementById('plan-workspace').style.display === 'none')) await page.evaluate(() => switchWorkspace('plan'));
    await page.waitForTimeout(500);
    const p = await planPoint(page, 'K2');
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(600);
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

