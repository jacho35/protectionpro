// Named screen set-ups for capture.mjs. Each runs on a fresh page of the app.
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
};
