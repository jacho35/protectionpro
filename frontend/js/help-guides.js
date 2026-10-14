/* ProtectionPro — illustrated how-to guides (Help ▸ Guides).
 *
 * Task-based walkthroughs with annotated screenshots, beside the formula
 * articles of Calculations & tools. Each guide is data:
 *
 *   { id, group, title, where, time, phone, intro, steps: [{ title, html, shot? }],
 *     tips: [...], related: [{ help, label }] }
 *
 * `shot` describes one picture: { file, alt, setup, clip?, phone?, callouts: [{ sel, label, all? }] };
 * `all` outlines the union of every element `sel` matches instead of the first.
 * The same data drives testing/help-guides/capture.mjs, which opens the app,
 * runs the named `setup`, draws the numbered callouts over `sel` and writes
 * img/help/<file>. The legend under each picture is built from the callout
 * labels, so the numbers in the picture and the text can't drift apart.
 * Re-run the capture after a UI change: node testing/help-guides/capture.mjs
 *
 * User-facing text: say the result, never cite a documentation file.
 */

const HELP_GUIDE_GROUPS = [
  { id: 'boards', title: 'Distribution boards' },
  { id: 'earthing', title: 'Earthing' },
  { id: 'output', title: 'Drawings & export' },
];

const HELP_GUIDES = [

// ───────────────────────────────────────────────────────────────────────────
{ id: 'db-schedule', group: 'boards', title: 'Build a board’s circuit schedule',
  where: 'Schedules ▸ board ▸ Schedule', time: '10 min', phone: 'Card list with an edit sheet (see the phone guide)',
  intro: 'The schedule is one row per way: breaker, cable, load and phase. Everything else on the board (single line, front view, bill of quantities, circuit check) is drawn from it.',
  steps: [
    { title: 'Open the board',
      html: 'Open the <strong>Schedules</strong> workspace and pick the board in the rail on the left. Boards come from <em>Distribution Board</em> symbols on the single-line diagram; <strong>Generate SLD</strong> draws the other direction.',
      shot: { file: 'db-schedule-1.png', alt: 'The Schedules workspace with a board selected and its circuit schedule',
        setup: 'schedule-grid', clip: '#schedules-workspace',
        callouts: [
          { sel: '#sch-board-list', label: 'Board rail — every distribution board in the project' },
          { sel: '.sch-grid-head .sch-tabs', label: 'Schedule, Single Line and Layout (GA) views of the same board' },
          { sel: '.db-phase-bars', label: 'Load on each phase — R / W / B' },
          { sel: '.db-schedule-grid thead th.db-grp-h', label: 'Column groups — click a group heading to fold it' },
        ] } },
    { title: 'Add the loads',
      html: 'Under the grid, choose a load type, set how many, and press <strong>+ Add circuit</strong>. The quick buttons add a batch (10 lights, 5 sockets). <strong>+ Add Way</strong> adds an empty way. Each new way takes the next way number and the next phase, so the board stays balanced as you add.',
      shot: { file: 'db-schedule-2.png', alt: 'The add-load row and quick buttons under the schedule grid',
        setup: 'schedule-grid', clip: '#schedules-workspace',
        callouts: [
          { sel: '#db-load-type', label: 'Load type — sets a typical load, breaker and cable' },
          { sel: '#db-quick-lights', label: 'Quick batches' },
        ] } },
    { title: 'Edit like a spreadsheet',
      html: 'Click a cell and type. Arrow keys move, <kbd>Enter</kbd> goes down, <kbd>Tab</kbd> goes right, <kbd>F2</kbd> edits inside a cell. Select a block with <kbd>Shift</kbd>+arrows or by dragging, then <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> to copy to and from Excel, and <kbd>Ctrl</kbd>+<kbd>D</kbd> to fill down. Text pasted into a number cell is refused and marked, never turned into zero.' },
    { title: 'Change many ways at once',
      html: 'Tick the boxes at the left of several ways. A bar appears with the fields you can set for all of them — leave a field blank to keep each way’s own value — then press <strong>Apply</strong>.',
      shot: { file: 'db-schedule-3.png', alt: 'Two ways ticked and the bulk edit bar showing',
        setup: 'schedule-bulk', clip: '#schedules-workspace',
        callouts: [
          { sel: '.db-schedule-grid tbody tr:nth-child(3) .db-sel-cell input', label: 'Tick the ways to change' },
          { sel: '#db-bulk-bar', label: 'Bulk bar — blank means leave unchanged' },
        ] } },
    { title: 'Check the circuits',
      html: 'Press <strong>Check circuits</strong>. Each way is checked for breaker against load and cable, volt drop from the origin, earth conductor and earth-fault loop, and the result columns fill in with a pass, warning or fail mark. A change after the check marks the results stale; press the button again.',
      shot: { file: 'db-schedule-4.png', alt: 'The schedule after Check circuits, with the result columns filled in',
        setup: 'schedule-checked', clip: '#schedules-workspace',
        callouts: [
          { sel: '#db-check-circuits', label: 'Check circuits' },
          { sel: '.db-schedule-grid thead th[data-label="FLA (A)"], .db-schedule-grid thead th:nth-last-child(5)', label: 'Results — current, rating, volt drop, earth conductor' },
        ] } },
    { title: 'Move data in and out',
      html: '<strong>Export Excel</strong> writes the schedule to a workbook; <strong>Import Excel</strong> reads one back, with a preview before anything changes. Paste from a spreadsheet works directly in the grid too.' },
  ],
  tips: [
    'A way with no load and a breaker set is a <em>Spare</em>; it still takes a position on the front view.',
    'Folding a column group to its one-line chip is only a view; nothing is removed.',
  ],
  related: [{ help: 'cable-dbcheck', label: 'Distribution-board circuit check (the maths)' }, { help: 'cable-raceway', label: 'Conduit fill & grouping derating' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'db-sections', group: 'boards', title: 'Split a board into Normal, Essential and UPS sections',
  where: 'Schedules ▸ board ▸ Schedule ▸ Sections / compartments', time: '5 min', phone: 'Sections sheet from the ⋯ menu or the Sections chip',
  intro: 'One board can hold physically separate compartments, each with its own supply, incomer, busbar and N/PE bars. Ways belong to a section, and the single line, front view, circuit check and bill of quantities all follow.',
  steps: [
    { title: 'Open the Sections panel',
      html: 'Above the grid, open <strong>Sections / compartments</strong>. A board with no sections is one compartment; the first section you add takes all its existing ways.',
      shot: { file: 'db-sections-1.png', alt: 'The Sections panel with three section cards and the add buttons',
        setup: 'sections-panel', clip: '#schedules-workspace',
        callouts: [
          { sel: '.dbs-actions', label: 'Add a Normal, Essential, UPS or Other section' },
          { sel: '.dbs-card:nth-of-type(2) .dbs-card-h', label: 'Section name, kind and way-number prefix' },
          { sel: '.dbs-card:nth-of-type(2) .dbs-card-b', label: 'Supply, incomer and the cable that feeds the section' },
        ] } },
    { title: 'Describe each section’s supply',
      html: 'For each section set <strong>Fed</strong> (its own supply, the board incomer, or from another section), the source (a generator or UPS name and kVA), the incomer rating and the feed cable. An Essential section fed from a generator usually has its own source and a changeover; a UPS section is fed from the UPS output.' },
    { title: 'Put ways in sections',
      html: 'Each way has a <strong>Section</strong> cell. Pick the section there, or open a section tab and add ways while it is active: they take that section’s prefix (N1, E1, U1…). Changing the section can renumber the way.',
      shot: { file: 'db-sections-2.png', alt: 'Section tabs above the grid and the Section column',
        setup: 'sections-tabs', clip: '#schedules-workspace',
        callouts: [
          { sel: '.dbs-tabs', label: 'Section tabs — show one section, or all' },
          { sel: '.db-schedule-grid tbody tr:nth-child(6) .db-col-sec', label: 'Section of this way' },
        ] } },
    { title: 'Set the form of separation',
      html: 'The <strong>Form of separation</strong> (1 to 4b) at the bottom of the panel sets the partition allowance between compartments on the front view.' },
    { title: 'See it on the drawings',
      html: 'Open <strong>Single Line</strong> and <strong>Layout (GA)</strong>: each section is drawn as its own compartment with its own incomer, bars and colour.' },
  ],
  tips: [
    'Removing a section moves its ways to the first remaining section; nothing is deleted.',
    'The circuit check grades each way against its own section’s source and earth-fault impedance when you declare one.',
  ],
  related: [{ help: 'cable-dbcheck', label: 'Distribution-board circuit check' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'db-single-line', group: 'boards', title: 'Draw the board single line and add accessories',
  where: 'Schedules ▸ board ▸ Single Line', time: '5 min', phone: 'View only',
  intro: 'The Single Line tab draws the board from its schedule: incomer, busbar, every outgoing way with its breaker, cable and load, and the accessories that are not circuits — indicator lamps, surge arrestors, metering and the like.',
  steps: [
    { title: 'Read the drawing',
      html: 'Open <strong>Single Line</strong>. Each way hangs from the busbar with its breaker, phase colour, cable and load. The incomer is read from the main single-line diagram: wire the board to a supply and its breaker, and the incomer shows its rating; until then it reads <em>rating unknown</em>.',
      shot: { file: 'db-single-line-1.png', alt: 'The board single line with the accessory bay and the accessories panel',
        setup: 'single-line', clip: '#schedules-workspace',
        callouts: [
          { sel: '.dbd-canvas svg g[data-dxf-block][data-dxf-attrs*=\'"WAY":"3"\']', all: true, label: 'A way: breaker, cable, phase and load' },
          { sel: '#dbd-accessories', label: 'Board accessories panel' },
          { sel: '.dbd-toolbar', label: 'Show or hide cable, load, phase, earth leakage, N/PE bars and accessories' },
        ] } },
    { title: 'Add an accessory',
      html: 'In the <strong>Board accessories</strong> panel pick a kind (live / phase indicators, surge arrestor, metering, enclosure utilities) and press <strong>+ Add accessory</strong>. It occupies no way number and carries no load. Set where it taps from (the busbar after the main switch, or before it on the supply side), then its own fields: lamp and fuse, SPD type and backup fuse, meter and CT.',
      shot: { file: 'db-single-line-2.png', alt: 'An indicator and a surge arrestor in the accessories panel',
        setup: 'single-line', clip: '#dbd-accessories',
        callouts: [
          { sel: '#dba-kind', label: 'Choose the kind, then + Add accessory' },
          { sel: '#dbd-accessories .dba-row:nth-of-type(1)', label: 'Tap point and the accessory’s own fields' },
        ] } },
    { title: 'Read the advisories',
      html: 'Notes under an accessory are advice, not errors: a surge arrestor that needs a backup fuse above the incomer rating, an indicator fuse that is too large, an incomer that is unknown. They follow the incomer on the single-line diagram, so there is no second rating to keep in step.' },
    { title: 'Show an information table',
      html: 'Tick <strong>Info table</strong> to add a table under the load symbols that lists each way’s numbers, for a drawing that has to stand on its own.' },
    { title: 'Print or export',
      html: '<strong>SVG</strong>, <strong>PNG</strong> and <strong>DXF</strong> download the drawing; <strong>Print sheet</strong> makes a PDF with a title block; <strong>All boards</strong> makes one sheet per board. See <em>Export drawings to CAD (DXF)</em>.' },
  ],
  tips: ['Circuit breakers are drawn open or closed to match their state on the single-line diagram.'],
  related: [{ help: 'design-boq', label: 'Bill of quantities (accessories are counted)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'db-ga', group: 'boards', title: 'Lay out a board’s front view (GA)',
  where: 'Schedules ▸ board ▸ Layout (GA)', time: '10 min', phone: 'View only',
  intro: 'The Layout tab turns the schedule, accessories and incomer into a physical front view: devices on rails, section compartments, N/PE bars and an enclosure size with a heat check. You can resize compartments by dragging and paint uneven grids.',
  steps: [
    { title: 'Open the layout',
      html: 'Open <strong>Layout (GA)</strong>. Devices take generic sizes (17.5 mm DIN pole, typical MCCB frames). The card at the top right gives the enclosure it chose, the space used, spare modules and the heat against the allowed rise.',
      shot: { file: 'db-ga-1.png', alt: 'The front view with three compartments and the side panel',
        setup: 'ga-side-by-side', clip: '#schedules-workspace',
        callouts: [
          { sel: '#ga-canvas svg', label: 'Front view, to scale' },
          { sel: '#ga-side > div:first-child, #ga-side .ga-enc', label: 'Enclosure chosen, space used and heat' },
          { sel: '[data-ga-set="section_layout"]', label: 'Arrangement: side by side, stacked or grid' },
          { sel: '[data-ga-set="enclosure"]', label: 'Size: auto, or pick a size' },
        ] } },
    { title: 'Choose the arrangement and size',
      html: '<strong>Arrangement</strong> sets how compartments sit: side by side, stacked, or a grid with columns and rows (blank is automatic). Under <strong>Enclosure</strong> leave <em>Auto</em> to get the smallest enclosure that fits, or pick a size. <strong>Spare %</strong> keeps free modules for future ways and <strong>Rise K</strong> is the allowed temperature rise for the heat check.' },
    { title: 'Resize by dragging a partition',
      html: 'Each internal partition has a grip. Drag it to resize the two compartments either side. Sizes snap to 10 mm with a 100 mm minimum, a readout shows both sizes, and the devices reflow while you drag. With a grip focused, the arrow keys move it 10 mm (<kbd>Shift</kbd>: 50 mm). <strong>Equal sizes</strong> or <strong>Fit to devices</strong> undo the resizing.',
      shot: { file: 'db-ga-2.png', alt: 'A partition grip between two compartments',
        setup: 'ga-side-by-side', clip: '#ga-canvas',
        callouts: [
          { sel: '#ga-canvas .ga-grip', label: 'Partition grip — drag, or focus and use the arrow keys' },
        ] } },
    { title: 'Paint an uneven grid',
      html: 'Set <strong>Arrangement</strong> to <em>Grid</em>, then under <strong>Paint cells</strong> pick a section or <strong>Spare</strong> and click or drag across cells on the drawing. A section can take several cells, including an L-shape; its devices flow through them top to bottom and its N/PE bars sit in the bottom strip. <kbd>Esc</kbd> or <strong>Done</strong> leaves painting; <strong>Reset cells</strong> goes back to one cell per section.',
      shot: { file: 'db-ga-3.png', alt: 'A 2 by 2 grid with an L-shaped Normal compartment and a spare cell',
        setup: 'ga-painted', clip: '#schedules-workspace',
        callouts: [
          { sel: '.ga-paint', label: 'Brushes: each section, and Spare' },
          { sel: '#ga-canvas svg', label: 'Painted cells; partitions only where two owners meet' },
        ] } },
    { title: 'Reorder devices and add items',
      html: 'The <strong>Devices</strong> table lists everything in the board. Use the arrows to move a device earlier or later, tick <em>new row</em> to start a new rail row there, and change a way’s device type if the automatic choice is not what you will fit. <strong>Add item</strong> places extra items such as a meter or a terminal block.' },
    { title: 'Print or export',
      html: '<strong>Print sheet</strong> makes a PDF with a title block and a parts list, <strong>All boards</strong> one sheet per board, <strong>SVG</strong> and <strong>DXF</strong> download the drawing for CAD in millimetres.',
      shot: { file: 'db-ga-4.png', alt: 'The GA toolbar with the output buttons',
        setup: 'ga-side-by-side', clip: '.sch-grid-pane',
        callouts: [
          { sel: '[data-ga="svg"]', label: 'SVG' },
          { sel: '[data-ga="dxf"]', label: 'DXF for CAD' },
          { sel: '[data-ga="pdf"]', label: 'Print sheet — PDF with title block and parts list' },
          { sel: '[data-ga="pdf-all"]', label: 'One sheet per board' },
        ] } },
  ],
  tips: [
    'Sizes are generic. Confirm against the manufacturer’s catalogue before ordering.',
    'Changing the enclosure keeps your compartment sizes: they are stored as proportions.',
  ],
  related: [{ help: 'design-boq', label: 'Bill of quantities' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'db-phone', group: 'boards', title: 'Use the circuit schedule on a phone',
  where: 'Schedules (under 768 px wide)', time: '3 min', phone: 'This is the phone view',
  intro: 'On a phone the schedule is a list of cards with an edit sheet, so every field is reachable without a wide grid.',
  steps: [
    { title: 'Find a way',
      html: 'Pick the board from <strong>Boards</strong> at the top. The summary shows ways, connected and demand kVA, the R / W / B split and the check counts. Search by description or way number, or tap a filter: <strong>Issues</strong>, a phase, or a section.',
      shot: { file: 'db-phone-1.png', alt: 'The phone schedule with the summary, filters and way cards',
        setup: 'phone-list', clip: 'viewport', phone: true,
        callouts: [
          { sel: '.smb-summary', label: 'Board summary and check counts' },
          { sel: '.smb-filters', label: 'Search and filters' },
          { sel: '.smb-list .smb-card:first-child, .smb-list > *:first-child', label: 'A way — tap to edit' },
          { sel: '.smb-bar', label: '+ Way, Add load and the ⋯ menu' },
        ] } },
    { title: 'Edit a way',
      html: 'Tap a card to open the edit sheet. Fields are grouped as Circuit, Device, Load, Cable, Earth leakage and Conduit. The arrows at the top go to the previous or next way; the back button closes the sheet.',
      shot: { file: 'db-phone-2.png', alt: 'The edit sheet for one way',
        setup: 'phone-sheet', clip: 'viewport', phone: true,
        callouts: [
          { sel: '.smb-sheet-head', label: 'Previous, next and close' },
          { sel: '#smb-sheet.open .smb-sheet-body section', label: 'Grouped fields' },
        ] } },
    { title: 'Add loads and sections',
      html: '<strong>Add load</strong> opens the load list. <strong>+ Sections</strong> (or <strong>⋯</strong> ▸ Board sections) opens the Sections sheet to add Normal, Essential and UPS compartments and set their supply.',
      shot: { file: 'db-phone-3.png', alt: 'The Sections sheet on a phone',
        setup: 'phone-sections', clip: 'viewport', phone: true,
        callouts: [
          { sel: '.smb-sheet.open .dbs-actions', label: 'Add a section' },
          { sel: '.smb-sheet.open [data-sec-close]', label: 'Done' },
        ] } },
    { title: 'Check and share',
      html: '<strong>⋯</strong> has Check circuits, Auto balance phases, Fill missing ECC, and Excel export and import. The front view and single line are view-only on a phone; use a wider screen to edit them.' },
  ],
  tips: ['Rotate the phone, or open the project on a wider screen, to get the full grid.'],
  related: [] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'earth-grid', group: 'earthing', title: 'Design an earth grid',
  where: 'Analyse ▸ Earthing & lightning ▸ Earth grids…', time: '15 min', phone: 'Use a wider screen',
  intro: 'The earth grid designer builds a grid of any shape — rectangle or L-shape, uneven spacing, diagonals, rods anywhere, fences — and shows it live as a plan or in 3-D. A bus then uses the grid for its grounding study.',
  steps: [
    { title: 'Create a grid',
      html: 'Open <strong>Analyse ▸ Earthing &amp; lightning ▸ Earth grids…</strong>. Press <strong>New</strong> in the rail (or <strong>Create from bus</strong> when you open it from a bus) and name the grid. The plan on the right redraws as you change anything on the left.',
      shot: { file: 'earth-grid-1.png', alt: 'The earth grid editor with the rail, plan and form',
        setup: 'earth-grid', clip: '#earth-grid-modal .modal-content',
        callouts: [
          { sel: '#eg-rail', label: 'Grids in the project' },
          { sel: '#eg-preview', label: 'Live plan — Plan / 3-D and tools' },
          { sel: '#eg-form', label: 'Soil, conductor, layout, rods, fences and calculation' },
          { sel: '#btn-eg-save', label: 'Save writes to the project; nothing changes until then' },
        ] } },
    { title: 'Describe soil and conductor',
      html: 'Under <strong>Soil</strong> set the resistivity (two layers if you have a measurement), under <strong>Surface layer</strong> the crushed-stone resistivity and depth, and under <strong>Conductor</strong> the material, size, burial depth and joint type. The conductor size is also checked against the minimum the fault current needs.' },
    { title: 'Shape the layout',
      html: 'Under <strong>Layout</strong> choose <em>Rectangle</em>, <em>L-shape</em> (set where the notch starts) or <em>None</em> if you will place every conductor by hand. Enter conductors across and along, or type their positions for uneven spacing (for example 0, 3, 8, 15, 22, 27, 30). <strong>Diagonal conductors</strong> adds corner meshes, every mesh, or full corner to corner.',
      shot: { file: 'earth-grid-2.png', alt: 'An L-shaped grid with uneven spacing and diagonal corner meshes',
        setup: 'earth-grid-l', clip: '#earth-grid-modal .modal-content',
        callouts: [
          { sel: '[data-eg-sec="layout"]', label: 'Layout — shape, spacing, notch, diagonals' },
          { sel: '#eg-preview .eg-plan', label: 'The L-shape with its notch and diagonals' },
        ] } },
    { title: 'Add rods, fences and extra metal',
      html: '<strong>Rods</strong> places them by rule: round the perimeter, at the corners, at every crossing. <strong>Fences</strong> take an offset (positive outside the grid) and are either bonded to the grid or separately earthed, in which case their touch and transfer voltages are reported. <strong>Added conductors</strong> and <strong>Added rods</strong> take anything the rules do not give you.' },
    { title: 'Place conductors and rods on the plan',
      html: 'On the plan choose <strong>+ Conductor</strong> or <strong>+ Rod</strong>. Click the start and the end of a conductor (it snaps to crossings, ends and other conductors; hold <kbd>Alt</kbd> for a free point), or click to drop a rod. Click the same point again or press <kbd>Esc</kbd> to finish. The plan hint tells you what the next click does.',
      shot: { file: 'earth-grid-3.png', alt: 'The plan tools with a conductor being placed',
        setup: 'earth-grid-tools', clip: '#earth-grid-modal .modal-content',
        callouts: [
          { sel: '.eg-tb', label: 'Select, + Conductor, + Rod' },
          { sel: '.eg-tb-hint', label: 'Hint for the next click' },
        ] } },
    { title: 'Check it in 3-D',
      html: 'Switch to <strong>3-D</strong> to turn the grid, check depths of rods and conductors with <strong>Depth ×1 / ×2 / ×5</strong>, and spot a conductor that is not where you meant.',
      shot: { file: 'earth-grid-4.png', alt: 'The 3-D view of a grid with rods',
        setup: 'earth-grid-3d', clip: '#earth-grid-modal .modal-content',
        callouts: [
          { sel: '[data-eg-view="3d"]', label: '3-D view' },
          { sel: '[data-eg-exag]', label: 'Depth scale' },
        ] } },
    { title: 'Choose the method and limits',
      html: 'Under <strong>Calculation</strong>, <em>Auto</em> uses the simplified equations where they apply (a plain rectangle) and the numerical method otherwise. <strong>Limit basis</strong> is IEEE 80 (body weight, optional footwear) or EN 50522 (touch voltage and the measures applied).' },
    { title: 'Use it on a bus',
      html: 'Press <strong>Save</strong>, then select the bus on the single-line diagram and pick the grid in its <strong>Earth Grid</strong> field (or use <em>Use for bus</em> when you opened the editor from it). Run <strong>Analyse ▸ Earthing &amp; lightning ▸ Grounding</strong>: the result shows touch and step voltage on the plan.' },
  ],
  tips: [
    'The editor works on a copy. Closing with unsaved changes asks before discarding them.',
    'A bus with no earth grid keeps its own simple grounding fields.',
  ],
  related: [{ help: 'prot-earth-grid', label: 'Earth grids of any shape (the method)' }, { help: 'prot-grounding', label: 'Substation grounding' }, { help: 'prot-en50522', label: 'Touch voltage to EN 50522' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'dxf-export', group: 'output', title: 'Export drawings to CAD (DXF)',
  where: 'Output ▸ Drawing ▸ Diagram (DXF) and the DXF button on each drawing page', time: '3 min', phone: 'Use a wider screen',
  intro: 'Every drawing page exports a DXF in millimetres: symbols are blocks, their labels are visible attributes, and ratings and other data ride along as hidden attributes. Open it in any CAD package and the data is there to read or extract.',
  steps: [
    { title: 'Find the DXF button',
      html: 'On the single-line diagram, use <strong>Output ▸ Drawing ▸ Diagram (DXF)</strong>. On the board Single Line and Layout (GA) tabs, the street-lighting schematic and the Demand topology, each has a <strong>DXF</strong> button in its toolbar. The plan drawing has its own export on the plan toolbar.',
      shot: { file: 'dxf-export-1.png', alt: 'The Output menu with the Drawing group and Diagram (DXF)',
        setup: 'output-menu', clip: 'viewport',
        callouts: [
          { sel: '#btn-export-dxf', label: 'Diagram (DXF)' },
        ] } },
    { title: 'Open it in CAD',
      html: 'Units are millimetres and the Y axis points up. Line types keep their dash patterns, fills are solid, and text is real text. Circuit breakers and other symbols are <em>blocks</em> inserted at scale 1.' },
    { title: 'Read the data',
      html: 'The label beside a symbol is a visible attribute. Use your CAD package’s attribute display or data extraction to list a board’s breakers with their rating, cable and load, since those are hidden attributes on the block. A block inserted fresh prompts for the same fields.' },
  ],
  tips: [
    'Layers keep a drawing’s parts apart so you can freeze text, fills or a section.',
    'Export again after changing the project; a DXF is a snapshot, not a link.',
  ],
  related: [{ help: 'design-boq', label: 'Bill of quantities' }] },

];

// ─────────────────────────────────────────────────────────────────────────────
// Viewer: a list of guides, one guide at a time. On a narrow screen the pane
// shows the list or the guide, with its own back link.
// ─────────────────────────────────────────────────────────────────────────────
const HelpGuides = {
  _built: false,
  _current: null,

  _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },

  init() {
    if (this._built) return;
    const pane = document.getElementById('help-tab-guides');
    if (!pane) return;
    this._built = true;
    pane.innerHTML = `<div class="hg-wrap"><nav class="hg-list" id="hg-list" aria-label="Guides"></nav><article class="hg-guide" id="hg-guide"></article></div>`;
    this._renderList();
    pane.addEventListener('click', (e) => {
      const g = e.target.closest('[data-hg-open]');
      if (g) { this.open(g.dataset.hgOpen); return; }
      if (e.target.closest('[data-hg-back]')) { this._current = null; this._sync(); return; }
      const h = e.target.closest('[data-help]');
      if (h && typeof HelpCenter !== 'undefined') { e.preventDefault(); HelpCenter.open(h.dataset.help); return; }
      const img = e.target.closest('.hg-shot img');
      if (img) img.closest('.hg-shot').classList.toggle('hg-zoom');
    });
    this._sync();
  },

  _renderList() {
    const el = document.getElementById('hg-list');
    el.innerHTML = HELP_GUIDE_GROUPS.map(g => {
      const items = HELP_GUIDES.filter(x => x.group === g.id);
      if (!items.length) return '';
      return `<div class="hg-group">${this._esc(g.title)}</div>` + items.map(x =>
        `<button type="button" class="hg-item${this._current === x.id ? ' on' : ''}" data-hg-open="${x.id}">
           <span class="hg-item-t">${this._esc(x.title)}</span><span class="hg-item-s">${this._esc(x.time)}</span></button>`).join('');
    }).join('');
  },

  open(id) {
    this.init();
    const g = HELP_GUIDES.find(x => x.id === id);
    if (!g) return;
    this._current = id;
    document.getElementById('hg-guide').innerHTML = this._guideHtml(g);
    document.getElementById('hg-guide').scrollTop = 0;
    this._renderList();
    this._sync();
  },

  _sync() {
    const w = document.querySelector('#help-tab-guides .hg-wrap');
    if (w) w.classList.toggle('hg-reading', !!this._current);
    if (!this._current) {
      const el = document.getElementById('hg-guide');
      if (el && !el.dataset.empty) {
        el.dataset.empty = '1';
        el.innerHTML = `<div class="hg-empty"><h4>Guides</h4><p>Step-by-step walkthroughs with annotated screenshots. Pick one on the left.</p>
          <p class="hg-muted">The formulas and standards behind each feature are under <em>Calculations &amp; tools</em>.</p></div>`;
      }
    } else {
      const el = document.getElementById('hg-guide');
      if (el) delete el.dataset.empty;
    }
  },

  _guideHtml(g) {
    const e = this._esc;
    const steps = g.steps.map((s, i) => {
      let shot = '';
      if (s.shot) {
        const legend = (s.shot.callouts || []).map((c, k) => `<li><span class="hg-n">${k + 1}</span>${e(c.label)}</li>`).join('');
        shot = `<figure class="hg-shot${s.shot.phone ? ' hg-phone' : ''}"><img src="img/help/${e(s.shot.file)}" alt="${e(s.shot.alt)}" loading="lazy">
          <figcaption><ol class="hg-legend">${legend}</ol><span class="hg-hint">Click the picture to enlarge.</span></figcaption></figure>`;
      }
      return `<li class="hg-step"><h5>${e(s.title)}</h5><div class="hg-step-b"><p>${s.html}</p>${shot}</div></li>`;
    }).join('');
    const tips = (g.tips || []).map(t => `<li>${t}</li>`).join('');
    const rel = (g.related || []).map(r => `<a href="#" data-help="${e(r.help)}">${e(r.label)}</a>`).join(' · ');
    return `<button type="button" class="hg-back" data-hg-back>‹ All guides</button>
      <h3>${e(g.title)}</h3>
      <div class="hg-meta"><span>${e(g.where)}</span><span>${e(g.time)}</span><span>Phone: ${e(g.phone)}</span></div>
      <p class="hg-intro">${g.intro}</p>
      <ol class="hg-steps">${steps}</ol>
      ${tips ? `<div class="hg-tips"><h5>Good to know</h5><ul>${tips}</ul></div>` : ''}
      ${rel ? `<p class="hg-rel">Related: ${rel}</p>` : ''}`;
  },
};

document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.help-tab[data-tab="guides"]')?.addEventListener('click', () => HelpGuides.init());
});
