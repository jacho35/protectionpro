/* ProtectionPro — illustrated how-to guides (Help ▸ Guides).
 *
 * Task-based walkthroughs with annotated screenshots, beside the formula
 * articles of Calculations & tools. Each guide is data:
 *
 *   { id, group, title, where, time, phone, intro, steps: [{ title, html, shot? }],
 *     tips: [...], related: [{ help, label }] }
 *
 * `shot` describes one picture: { file, alt, setup, clip?, phone?, callouts: [{ sel, label, all? }] };
 * `all` outlines the union of every element `sel` matches instead of the first;
 * `text` picks, among the matches, the smallest element whose text contains it.
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
  { id: 'retic', title: 'Reticulation & plans' },
  { id: 'protection', title: 'Protection devices' },
  { id: 'earthing', title: 'Earthing' },
  { id: 'analyses', title: 'Running studies' },
  { id: 'studies', title: 'Studies & navigation' },
  { id: 'libs', title: 'Libraries & quoting' },
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

// ───────────────────────────────────────────────────────────────────────────
{ id: 'plan-select', group: 'retic', title: 'Select and edit many items on a plan',
  where: 'Plan workspace (site and floor plans)', time: '5 min', phone: 'Tap to select; right-click is a long press',
  intro: 'A plan quickly collects hundreds of items. These tools find the ones you mean, including ones lying on top of each other, and change them together.',
  steps: [
    { title: 'Select, add and box-select',
      html: 'With the <strong>Select</strong> tool, click an item to select it. <kbd>Shift</kbd>+click adds or removes one, and dragging across empty space draws a box that takes everything inside it. <kbd>Esc</kbd> clears the selection.' },
    { title: 'Reach an item that is covered',
      html: 'When items lie on top of each other (two glyphs, or a cable running along another), a message says how many are under the pointer. <strong>Click again in the same spot</strong> to move to the next one, nearest first. Measurement lines, crossings and trenches take part too.',
      shot: { file: 'plan-select-1.png', alt: 'A message saying two items are here, 1 of 2',
        setup: 'plan-stacked', clip: 'viewport',
        callouts: [
          { sel: '.toast', label: 'How many items are here and which one is selected' },
        ] } },
    { title: 'Right-click for the menu',
      html: 'Right-click an item. <strong>Select similar</strong> offers the same type, the same type and circuit, or everything on this circuit, each with its count. The menu also has <strong>Duplicate</strong>, <strong>Rotate 90°</strong>, <strong>Zoom to selection</strong> and <strong>Delete</strong>. Right-click on empty space for Select all, Clear selection and Zoom to fit.',
      shot: { file: 'plan-select-2.png', alt: 'The right-click menu on a kiosk with Select similar choices',
        setup: 'plan-context', clip: '#plan-workspace',
        callouts: [
          { sel: '#context-menu .dropdown-item', label: 'Select similar — with the number it will select', all: false },
          { sel: '#context-menu', label: 'The menu for the item under the pointer' },
        ] } },
    { title: 'Change them all at once',
      html: 'With several items of one kind and type selected, the properties panel shows that type’s fields. A change is written to every selected item, and a field where they differ reads <em>— mixed —</em>. If you selected different kinds, the panel asks you to use Select similar first.',
      shot: { file: 'plan-select-3.png', alt: 'Three kiosks selected and the properties panel showing a mixed rotation',
        setup: 'plan-bulk', clip: '#plan-workspace',
        callouts: [
          { sel: '#plan-props', label: 'Properties of the whole selection' },
        ] } },
    { title: 'Make symbols bigger or smaller',
      html: 'The <strong>Symbols ×</strong> box in the toolbar scales every symbol on the plan (0.25 to 5). A selected item also has its own <strong>Symbol scale ×</strong>, which multiplies with the plan-wide value. Drawing exports keep the standard size.',
      shot: { file: 'plan-select-4.png', alt: 'The Symbols box in the toolbar and a symbol scale on a selected item',
        setup: 'plan-scale', clip: '#plan-workspace',
        callouts: [
          { sel: '#plan-symbol-scale', label: 'Plan-wide symbol size' },
          { sel: '#plan-props', label: 'Symbol scale for the selected item' },
        ] } },
  ],
  tips: ['Duplicate makes untagged copies of elements that are not linked to Demand.', 'Delete works on the whole selection.'],
  related: [{ help: 'design-plan', label: 'Plan markup (site & floor plans)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'demand-plan', group: 'retic', title: 'Keep Demand and the site plan in step',
  where: 'Reticulation ▸ Demand and Plan', time: '10 min', phone: 'Demand: card layout; Plan: view and select',
  intro: 'Demand holds the electrical numbers (kiosks, erven, cables, volt drop) and the plan holds the geometry (where they are and how long the routes are). The two stay linked, so a cable changed on one changes on the other.',
  steps: [
    { title: 'Rough out the network in Demand',
      html: 'In <strong>Demand</strong>, <strong>Quick Build</strong> adds a number of kiosks with erven in one go, using the service and feeder cables and lengths you set. <strong>Feed from</strong> chooses the minisub and <strong>Daisy-chain</strong> feeds each kiosk from the one before. You can also add kiosks and erven by hand.' },
    { title: 'Push the plan into Demand',
      html: 'Draw the network on the <strong>Plan</strong>, then press <strong>→ Push to Schedules</strong>. Minisubs, kiosks, erven, route lengths and cables become Demand rows. Push again at any time: it updates rows rather than adding duplicates.' },
    { title: 'See and change the link',
      html: 'Select a kiosk, erf or minisub on the plan. <strong>From Demand</strong> shows what Demand says about it (load, cable, volt drop). <strong>Linked Demand item</strong> lists the unlinked rows of its kind, so an item drawn after the row existed can be attached, or detached. Once linked, editing a name or erf number in Demand updates the label on the plan.',
      shot: { file: 'demand-plan-1.png', alt: 'A kiosk selected on the plan with the From Demand panel and the link picker',
        setup: 'demand-linked', clip: '#plan-workspace',
        callouts: [
          { sel: '.plan-demand', label: 'What Demand says about this item' },
          { sel: '#plan-props select', label: 'Link or unlink a Demand row' },
          { sel: '[data-action="push"]', label: 'Push to Schedules' },
        ] } },
    { title: 'Change cables on many erven at once',
      html: 'In Demand, tick erven (<kbd>Shift</kbd>+click for a range), a kiosk’s header box for all its erven and its feeder, or a kiosk’s <em>change feeder</em> box. A bar docks at the bottom with pickers for <strong>Service cable</strong>, <strong>Earth cable</strong> and <strong>LV feeder cable</strong>, plus <strong>Phase</strong> and a quick rename. A picker left on <em>leave unchanged</em> touches nothing. <strong>Apply</strong> is one undo step and updates the drawn routes.',
      shot: { file: 'demand-plan-2.png', alt: 'Three erven ticked and the bulk change bar at the bottom of Demand',
        setup: 'demand-bulk', clip: '#retic-workspace',
        callouts: [
          { sel: '#retic-bulkbar', label: 'Bulk change bar' },
        ] } },
    { title: 'Give each string a breaker',
      html: 'A string is the kiosk fed from a minisub and everything fed on from it. Each minisub block in the side bar lists its strings with a <strong>String breaker</strong> picker. A string with no breaker shows <em>to complete</em>, and the earth-fault checks wait for it. The kiosks fed on from the head kiosk show the same breaker and are checked against it.',
      shot: { file: 'demand-plan-3.png', alt: 'The minisub block with its string and breaker picker',
        setup: 'demand-bulk', clip: '#retic-workspace',
        callouts: [
          { sel: '.ms-prot + .ss', label: 'Breaker for the string' },
        ] } },
    { title: 'Add the MV network',
      html: 'Each minisub has <strong>MV fed from</strong>, <strong>MV cable</strong> and <strong>MV length</strong>. A drawn MV route between two minisubs, even through RMUs and joints, stays in step with them both ways, and a route that closes a ring is drawn as a dashed tie. <strong>Diagram</strong> shows the MV tree with the plan’s RMUs as nodes and the cable and length of each leg.',
      shot: { file: 'demand-plan-4.png', alt: 'The Demand diagram with two minisubs on an MV feed',
        setup: 'demand-mv', clip: 'viewport',
        callouts: [
          { sel: '.modal-content svg', label: 'MV topology: minisubs, cable and length per leg' },
        ] } },
  ],
  tips: ['A route’s cable on the plan and the matching erf or kiosk cable in Demand are one value; changing either updates the other.', 'Select a route and use <em>Use as default for this route type</em> to set the cable new routes start with.'],
  related: [{ help: 'design-admd', label: 'Reticulation demand (ADMD)' }, { help: 'design-retic-vd', label: 'Reticulation volt drop & feeder legs' }, { help: 'design-plan', label: 'Plan markup' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'street-light', group: 'retic', title: 'Design a street-lighting circuit',
  where: 'Street lighting ▸ Circuits', time: '10 min', phone: 'Use a wider screen',
  intro: 'A circuit is a tree of poles fed from a kiosk or minisub. Each pole has its own luminaire, spacing and phase, and the verdict checks volt drop at every pole, the earth-fault loop at the far pole and phase balance.',
  steps: [
    { title: 'Start a circuit',
      html: 'Open <strong>Street lighting</strong> and press <strong>+ New circuit</strong>. Choose the kiosk or minisub it is <strong>Fed from</strong>, the <strong>System</strong> (three-phase red-white-blue rotation, or single phase), the cable, luminaire, pole spacing and the circuit’s protective device. <strong>Ze at source</strong> and <strong>Supply VD</strong> are taken from Demand unless you enter them.',
      shot: { file: 'street-light-1.png', alt: 'A street-lighting circuit with its settings, pole table and verdict',
        setup: 'sl-circuit', clip: '#streetlight-workspace',
        callouts: [
          { sel: '.sl-settings, #streetlight-workspace .sl-form', label: 'Source, system, cable, luminaire and protection' },
          { sel: '#streetlight-workspace .sl-verdict, #streetlight-workspace [class*="verdict"]', label: 'Verdict: worst volt drop, earth loop, load' },
        ] } },
    { title: 'Add and arrange poles',
      html: 'Press <strong>+ Poles</strong> to add poles (set how many in <em>Add</em>). In the table each pole has <strong>Fed from</strong> (the source or another pole), its own spacing and luminaire (or the circuit default) and a phase. Choose another pole in <em>Fed from</em> to make a <strong>spur</strong>; it carries on the phase rotation.',
      shot: { file: 'street-light-2.png', alt: 'The pole table with a spur fed from an earlier pole',
        setup: 'sl-spur', clip: '#streetlight-workspace',
        callouts: [
          { sel: '#streetlight-workspace table', label: 'Pole table — fed from, spacing, luminaire, phase, result per pole' },
        ] } },
    { title: 'Read the results',
      html: 'Each pole row shows its distance, span current, volt drop, cumulative volt drop, earth-loop impedance and fault current, with a check. The charts show volt drop along the circuit against the limit, and the current each phase carries at the source. <em>Limits for this build-up</em> gives the most poles and longest route the cable allows, what limits it, and the smallest cable that passes.' },
    { title: 'Size a string before there is a design',
      html: '<strong>Quick calc</strong> sizes a uniform string from a few numbers: system, luminaire, cable, number of poles, spacing and the supply. Change a value and the verdict and charts update. <strong>Save as circuit</strong> keeps it, under the kiosk or minisub you choose.',
      shot: { file: 'street-light-3.png', alt: 'The Quick calc dialog',
        setup: 'sl-quick', clip: 'viewport',
        callouts: [
          { sel: '.modal-content', label: 'Quick calc — change an input and the verdict follows' },
        ] } },
    { title: 'Pull the poles in from the plan',
      html: 'If you have drawn street-light poles and routes on the plan, <strong>Sync from plan</strong> creates the circuits from them. Each circuit’s load goes to its kiosk or minisub as street-lighting kVA in Demand.' },
  ],
  tips: ['<strong>Diagram</strong> draws the circuit as a schematic you can export as PNG, SVG or DXF.', 'Snaking and loop-in allowances are set in the toolbar and add to every span.'],
  related: [{ help: 'design-roadlight', label: 'Road lighting design' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'trip-unit', group: 'protection', title: 'Set up a breaker’s trip unit',
  where: 'Select a circuit breaker ▸ Standard CB ▸ Trip unit', time: '5 min', phone: 'Same panel in the sheet',
  intro: 'Pick a moulded-case or air circuit breaker from the library and it comes with a trip unit: the dials it really has, set to the library’s defaults. The TCC, arc flash and compliance use those settings.',
  steps: [
    { title: 'Pick the breaker',
      html: 'Select a <strong>Circuit Breaker</strong>. In <strong>Standard CB</strong> type to search the library (MCB, MCCB, ACB) and pick one. The rating, breaking capacity and trip settings are filled in, and a <strong>Trip unit</strong> section appears.',
      shot: { file: 'trip-unit-1.png', alt: 'The Standard CB picker and the Trip unit section for an adjustable thermal-magnetic MCCB',
        setup: 'trip-tm', clip: '#properties-panel',
        callouts: [
          { sel: '[data-field="standard_type"] + .ss', label: 'Standard CB — type to search the library' },
          { sel: '.tu-section', label: 'Trip unit: the dials this breaker really has' },
        ] } },
    { title: 'Turn the dials',
      html: 'Each dial offers its real positions, with the tripping amps beside it. A dial changed from the library default is marked, and the <strong>reset</strong> button puts one (or all of them) back. The footer says how many dials are changed. Fixed settings are shown as <em>(fixed)</em>.',
      shot: { file: 'trip-unit-2.png', alt: 'A dial changed from default and its reset button',
        setup: 'trip-edited', clip: '#properties-panel',
        callouts: [
          { sel: '.tu-row--edited', label: 'Changed from default — reset it here' },
          { sel: '.tu-foot', label: 'How many dials are changed' },
        ] } },
    { title: 'Electronic trip units',
      html: 'Larger MCCBs and every ACB have an electronic unit with long-time (Ir, tr), short-time (Isd, tsd) and instantaneous (Ii) settings. An electronic MCCB gets its short-time and instantaneous elements on the TCC, in arc flash and in the compliance checks.',
      shot: { file: 'trip-unit-3.png', alt: 'The Trip unit section of an electronic MCCB with long, short and instantaneous settings',
        setup: 'trip-electronic', clip: '#properties-panel',
        callouts: [
          { sel: '.tu-section', label: 'Ir, tr, Isd, tsd and Ii' },
        ] } },
    { title: 'Let the load and cable suggest Ir',
      html: 'After a cable sizing or load flow run, the section suggests an Ir with the load current at or below it and the cable’s current rating at or above it, and <strong>Apply</strong> sets it. If no setting fits, it says why.' },
    { title: 'Change the breaker later',
      html: 'Picking a different breaker after you changed dials asks whether to keep your changes (the Ir is kept in amps) or take the new defaults. The TCC settings drawer shows the same dial pickers, and dragging a curve moves to the next real dial position.' },
  ],
  tips: ['Choose <em>None — free settings</em> to type any number. Breakers saved before trip units existed keep their settings until you choose one.', 'The library’s own values are the defaults, so a company or team library edit changes them.'],
  related: [{ help: 'prot-tcc', label: 'Time-current curves & relay settings' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'libraries', group: 'libs', title: 'Work with your libraries and your team’s',
  where: 'Project ▸ Libraries…', time: '10 min', phone: 'Use a wider screen',
  intro: 'Cables, breakers, fuses, transformers, load classes and prices come in layers: the shipped defaults, your company standard, libraries shared by your team, then your own edits. The Libraries manager shows where each entry comes from and what changed.',
  steps: [
    { title: 'Open the manager',
      html: 'Open <strong>Project ▸ Libraries…</strong>. The rail lists the five libraries and <strong>Rates &amp; prices</strong>, then <strong>Out of date</strong>, <strong>Team libraries</strong>, <strong>Submissions</strong>, <strong>Activity log</strong> and <strong>Import / export</strong>. Click an entry to see where it comes from, its history and what you can do with it.',
      shot: { file: 'libraries-1.png', alt: 'The Libraries manager with a cable selected and its source and history on the right',
        setup: 'lib-overview', clip: 'viewport',
        callouts: [
          { sel: '#lib-rail', label: 'Libraries and management views' },
          { sel: '#lib-main', label: 'The library table — edit values in place' },
          { sel: '#lib-detail', label: 'Source, values and history of the selected entry' },
        ] } },
    { title: 'Edit an entry',
      html: 'Change a value directly in the table. The entry becomes <em>Edited by me</em> and is saved to your account as an override of the shipped, company or team entry; the original is untouched. Projects keep only the entries they use.',
      shot: { file: 'libraries-2.png', alt: 'An edited cable entry marked Edited by me',
        setup: 'lib-edited', clip: 'viewport',
        callouts: [
          { sel: '#lib-detail .subm-pill', label: 'Where this entry comes from now' },
          { sel: '#lib-main tr.lib-row-sel', label: 'The row you edited' },
        ] } },
    { title: 'Share with a team',
      html: 'Under <strong>Team libraries</strong>, <strong>+ New shared library</strong> makes a library others can read or edit. The <em>Layer order</em> table shows the order they apply in (the later layer wins) and <em>Clashes</em> lists entries provided by more than one layer. Saving an entry is versioned: if someone changed it first you are told and nothing is overwritten.',
      shot: { file: 'libraries-3.png', alt: 'Team libraries with a shared library in the layer order',
        setup: 'lib-teams', clip: 'viewport',
        callouts: [
          { sel: '.lib-card', label: 'Layer order and clashes' },
          { sel: '.lib-dock', label: 'Your shared libraries' },
        ] } },
    { title: 'Know when something changed',
      html: 'An entry you edited records the version it was based on. If the company or team entry changes later it shows under <strong>Out of date</strong> with a <strong>Review changes…</strong> button, so you decide whether to keep your edit. The notifications bell tells you about library, project and approval events.',
      shot: { file: 'libraries-4.png', alt: 'The notifications panel with its filter tabs',
        setup: 'notifications', clip: 'viewport',
        callouts: [
          { sel: '#notif-panel', label: 'Notifications: all, or filtered to Libraries, Projects and Approvals' },
        ] } },
    { title: 'Propose an entry to the company',
      html: 'If you are not an administrator, select your own entry and press <strong>Submit to company…</strong>. An administrator reviews it under <strong>Project ▸ Library Submissions…</strong>: approve, request changes, or reject (never their own). You see the outcome under <em>My submissions</em> and in the bell.' },
  ],
  tips: ['Opening a project compares the entries it was built with against your libraries and asks; it never overwrites yours.', 'Administrators can retire an entry (hidden from pickers; projects that use it are unaffected) and restore earlier versions.'],
  related: [{ help: 'cable-sizing', label: 'Cable sizing' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'quoted', group: 'libs', title: 'Lock a project’s prices when you quote',
  where: 'Project ▸ Mark as Quoted…', time: '3 min', phone: 'Same menu',
  intro: 'Once a quote has gone out, the numbers behind it must not move. Marking a project as quoted freezes its rates and the library entries it uses, so later changes to your libraries or the company price list cannot alter it.',
  steps: [
    { title: 'Mark it as quoted',
      html: 'Open <strong>Project ▸ Mark as Quoted…</strong>, add a note (a quote number or client), and confirm. Save the project afterwards to keep it.',
      shot: { file: 'quoted-1.png', alt: 'The Project menu with Mark as Quoted',
        setup: 'quote-menu', clip: 'viewport',
        callouts: [
          { sel: '#btn-quote', label: 'Mark as Quoted…' },
        ] } },
    { title: 'See what is locked',
      html: 'A <strong>Quoted</strong> chip with the date appears beside the project type, and the rate library shows a banner that prices and quantity rules are locked. Company price or library changes made later are shown as information only and never applied.',
      shot: { file: 'quoted-2.png', alt: 'The Quoted chip in the header and the locked rate library',
        setup: 'quote-locked', clip: 'viewport',
        callouts: [
          { sel: '#project-quoted-chip', label: 'Quoted chip — click to reopen' },
          { sel: '#rt-banner', label: 'Prices and quantity rules are locked' },
        ] } },
    { title: 'Open it later',
      html: 'Opening a quoted project uses the entries it was quoted with, not your current libraries. To change it, click the <strong>Quoted</strong> chip or choose <strong>Reopen for Editing…</strong>; the reopening is recorded in the project’s quote log with who and when.' },
  ],
  tips: ['The quote log keeps every quoted and reopened event.', 'Reopen only when you mean to re-quote: prices and library entries follow your libraries again.'],
  related: [{ help: 'design-boq', label: 'Bill of quantities, rates & cable schedules' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'lightning', group: 'earthing', title: 'Assess lightning risk for a structure',
  where: 'Analyse ▸ Earthing & lightning ▸ Lightning risk', time: '10 min', phone: 'Use a wider screen',
  intro: 'The assessment works out how often lightning harms a structure and what protection brings that within the tolerable limit. It walks you through four steps, shows a live estimate as you type, and ends with a verdict and a report.',
  steps: [
    { title: 'Start an assessment and choose the edition',
      html: 'Open <strong>Lightning risk</strong>. The assessments saved in the project are in the list at the top left; <strong>New</strong>, <strong>Duplicate</strong>, <strong>Rename</strong> and <strong>Delete</strong> manage them, so you can keep a design alongside the existing building. Choose the <strong>Edition</strong>: <em>2024</em> (the current one, with physical damage and the frequency of damage to internal systems) or <em>2010</em> where that is the adopted standard.',
      shot: { file: 'lightning-1.png', alt: 'The lightning risk assessment with the assessment list, steps and live estimate',
        setup: 'lightning-1', clip: '#lightning-modal .modal-content',
        callouts: [
          { sel: '#lr-assess-select', label: 'Assessments saved in this project' },
          { sel: '[data-lr-ed]', label: 'Edition of the standard' },
          { sel: '[data-lr-go="1"]', label: 'The four steps and the results' },
        ] } },
    { title: 'Describe the structure and site',
      html: 'Step 1 takes the length, width and height, and the site’s <strong>lightning ground flash density</strong> from your national lightning map (or the strike-point density, if your data provider gives it). Beside the form, the <strong>live estimate</strong> updates as you type: the collection area, direct strikes per year, strikes near the building, and the tolerable risk the result will be judged against.',
      shot: { file: 'lightning-2.png', alt: 'Structure and site inputs beside the live estimate',
        setup: 'lightning-1', clip: '#lightning-modal .modal-content',
        callouts: [
          { sel: '[data-lr-panel="1"]', label: 'Size, surroundings and flash density' },
          { sel: '#lightning-modal [class*="live"], #lightning-modal aside:last-of-type', label: 'Live estimate — updates as you type' },
        ] } },
    { title: 'Say who is inside, and what can burn',
      html: 'Step 2 is the people and the fire risk: how many people, for how many hours a year, the kind of structure, and what a fire or damage would cost. The loss class and fire risk set the size of each loss in the result.',
      shot: { file: 'lightning-3.png', alt: 'Step 2, people and fire',
        setup: 'lightning-2', clip: '#lightning-modal .modal-content',
        callouts: [
          { sel: '[data-lr-go="2"]', label: 'Step 2 of 4' },
        ] } },
    { title: 'Add the service lines and any protection already there',
      html: 'Step 3 lists the power and telecom lines that enter the structure: length, aerial or buried, whether a transformer sits on the line, and the equipment withstand voltage. Step 4 records what protection exists: a lightning protection system and its class, entrance surge protectors, coordinated protectors and bonding.',
      shot: { file: 'lightning-4.png', alt: 'Step 3, service lines',
        setup: 'lightning-3', clip: '#lightning-modal .modal-content',
        callouts: [
          { sel: '[data-lr-go="3"]', label: 'Step 3 of 4' },
        ] } },
    { title: 'Read the verdict',
      html: 'On step 4 press <strong>Assess risk</strong>. The result opens with the verdict first: the risk against the tolerable limit and, if it is exceeded, the <strong>lightest protection that meets it</strong>. Under that, a table splits the risk into its causes, largest first, and the protection options are listed lightest to heaviest with the risk each gives. The 2024 edition also shows the frequency of damage to internal systems for each zone.',
      shot: { file: 'lightning-5.png', alt: 'The verdict with the recommended protection and the risk components',
        setup: 'lightning-results', clip: '#lightning-modal .modal-content',
        callouts: [
          { sel: '.lr-verdict', label: 'Verdict and the lightest protection that meets the limit' },
          { sel: '.lr-tbl', label: 'What makes up the risk' },
        ] } },
    { title: 'Save and report',
      html: 'Everything you enter is saved with the project as part of the assessment, and the result is stored with it. A banner warns when inputs have changed since the result was calculated. The report button writes a PDF of the assessment for the file.' },
  ],
  tips: ['Use <strong>Duplicate</strong> to compare a protected and an unprotected case side by side.'],
  related: [{ help: 'prot-lightning', label: 'Lightning risk (the method)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'cable-focus', group: 'studies', title: 'Show only the cables at one bus',
  where: 'Results ▸ Cables at Selected Bus', time: '2 min', phone: 'Use the bus properties button',
  intro: 'After a cable sizing run every cable carries a result box, and a busy diagram becomes unreadable. Focus mode keeps only the cables into and out of one bus and dims everything else.',
  steps: [
    { title: 'Run the cable sizing',
      html: 'Run <strong>Analyse ▸ Cable sizing</strong>. Each cable on the diagram gets a result box with its size, loading and volt drop.',
      shot: { file: 'cable-focus-1.png', alt: 'A network with a cable result box on every cable',
        setup: 'cf-all', clip: '#sld-canvas',
        callouts: [
          { sel: '#sld-canvas', label: 'One result box per cable' },
        ] } },
    { title: 'Focus on a bus',
      html: 'Select a bus, then use <strong>Results ▸ Cables at Selected Bus</strong>, or the <strong>Cables</strong> button in the bus’s properties, or <strong>At bus</strong> in the cable sizing results table. The cables arriving from the source side and leaving toward the loads stay; the rest of the sheet is dimmed.',
      shot: { file: 'cable-focus-2.png', alt: 'The diagram dimmed except for the cables at the 11 kV bus',
        setup: 'cf-focus', clip: '#sld-canvas',
        callouts: [
          { sel: '#cable-focus-bar', label: 'Focus bar — Esc shows everything again' },
        ] } },
    { title: 'Move along the network',
      html: 'The focus follows the selection. Select another bus and it moves there; selecting a cable or empty canvas keeps the last bus. Press <kbd>Esc</kbd> or use the focus bar to show every cable again.' },
  ],
  tips: ['Focus is only for viewing: it is not saved with the project and does not change any result.'],
  related: [{ help: 'cable-sizing', label: 'Cable sizing (thermal, voltage drop, fault)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'find-anything', group: 'studies', title: 'Find any command with Ctrl K and the menus',
  where: 'Ctrl K, or the search box at the top', time: '2 min', phone: 'Search button in the header',
  intro: 'Everything in the menus can be reached by name. The same search finds analyses, exports, settings and workspaces, and runs the one you pick.',
  steps: [
    { title: 'Search by name',
      html: 'Press <kbd>Ctrl</kbd>+<kbd>K</kbd> (or click the search box) and start typing. Each result shows where it lives, for example <em>Analyse › Protection &amp; safety</em>. Use the arrow keys to move, <kbd>Enter</kbd> to run it and <kbd>Esc</kbd> to close.',
      shot: { file: 'find-anything-1.png', alt: 'The command search with three results for arc',
        setup: 'ctrlk', clip: 'viewport',
        callouts: [
          { sel: '#cmdk-panel, .cmdk-panel, .command-palette, [role="dialog"][aria-label*="earch" i]', label: 'Command search' },
        ] } },
    { title: 'Know the menus',
      html: '<strong>Project</strong> is files, templates, sharing, type and libraries. <strong>Edit</strong> and <strong>View</strong> are the diagram tools. <strong>Analyse</strong> groups every study by what it answers: fault, flow, power quality, protection and safety, cables. <strong>Scenarios</strong> and <strong>Run All Studies</strong> are next to <strong>Output</strong>, which holds reports, quantities, data and drawing exports.',
      shot: { file: 'find-anything-2.png', alt: 'The Analyse menu open with its groups',
        setup: 'menu-analyse', clip: 'viewport',
        callouts: [
          { sel: '#menu-analyse .toolbar-menu-panel', label: 'Analyse — studies grouped by what they answer' },
        ] } },
    { title: 'Show only the results you have',
      html: 'The <strong>Results</strong> menu lists a result-box toggle only for studies that have been run, so it stays short. Use <strong>All Result Boxes</strong> to hide or show everything, <strong>Restore hidden boxes</strong> after closing some, and <strong>Reset Result Box Positions</strong> to tidy dragged boxes.',
      shot: { file: 'find-anything-3.png', alt: 'The Results menu listing toggles for the studies that have run',
        setup: 'menu-results', clip: 'viewport',
        callouts: [
          { sel: '#menu-results .toolbar-menu-panel', label: 'Only studies with results are listed' },
        ] } },
  ],
  tips: ['The search is built from the menus every time it opens, so anything added to a menu is searchable at once.'],
  related: [] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'project-types', group: 'studies', title: 'Choose a project type and its workspaces',
  where: 'Project ▸ New Project, Project ▸ Project Type & Workspaces…', time: '3 min', phone: 'Same dialog',
  intro: 'The project type decides which workspace tabs you see, in the order you will use them. Nothing is deleted when a workspace is hidden.',
  steps: [
    { title: 'Pick a type when you start',
      html: '<strong>New Project</strong> asks what you are designing. <strong>Reticulation</strong> is a township or site LV network sized by ADMD: site plan, Demand, street lighting, single line and quantities. <strong>Building</strong> is floors, boards and final circuits: floor plans, single line, schedules and quantities. <strong>Network / plant</strong> is substations and industrial networks: single line and interlocking.',
      shot: { file: 'project-types-1.png', alt: 'The New project dialog with three type cards',
        setup: 'type-new', clip: 'viewport',
        callouts: [
          { sel: '.ws-type-card', label: 'Each card shows its workspaces, in workflow order' },
        ] } },
    { title: 'Change it later',
      html: 'Open <strong>Project ▸ Project Type &amp; Workspaces…</strong>. A project opened without a type shows the one its content implies. Tick any other workspace to add it to the tab strip; the ones in the type’s core set are fixed.',
      shot: { file: 'project-types-2.png', alt: 'The Project type and workspaces dialog',
        setup: 'type-dialog', clip: 'viewport',
        callouts: [
          { sel: '.ws-type-cards', label: 'Project type' },
          { sel: '.ws-rows', label: 'Workspaces — tick to add' },
        ] } },
    { title: 'Workspaces that hold data stay',
      html: 'A workspace with data in it is never hidden, so a Network project that later gets a plan keeps its Plan tab. Hiding one only removes its tab; the data stays in the project.' },
  ],
  tips: ['Quantities is optional for a Network project, and appears by itself once the rate library has data.', 'The tab order follows the work: plan, demand, street lighting, single line, quantities.'],
  related: [{ help: 'design-types', label: 'Project types & workspaces (reference)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'tcc-read', group: 'protection', title: 'Read the time-current chart (TCC)',
  where: 'Analyse ▸ Protection & safety ▸ Time-Current Curves (TCC)', time: '8 min', phone: 'Use a wider screen',
  intro: 'The TCC plots how long each protective device takes to operate at each current, so you can see whether the device nearest a fault clears it first. This guide covers finding your way around the chart; the next two cover changing settings and checking coordination.',
  steps: [
    { title: 'Open the chart',
      html: 'Run a short-circuit study first so the chart can mark fault levels, then open <strong>Analyse ▸ Protection &amp; safety ▸ Time-Current Curves (TCC)</strong>. The tabs across the top show every device, or one voltage level at a time. <strong>Protection path</strong> on the left is the chain of devices from the source to the load. The chart is time against current on log scales, and the list on the right has one row per device.',
      shot: { file: 'tcc-read-1.png', alt: 'The TCC with voltage tabs, protection path, chart and device list',
        setup: 'tcc-open', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '.tcc-tab-bar', label: 'Voltage tabs — all devices, or one level' },
          { sel: '.tcc-mini-sld', label: 'Protection path from the source to the load' },
          { sel: '.tcc-canvas-wrap', label: 'The chart: time against current' },
          { sel: '.tcc-side-panel', label: 'Devices — show, hide or solo each curve' },
        ] } },
    { title: 'Move around the chart',
      html: 'Scroll to zoom. <kbd>Shift</kbd>+scroll zooms current only and <kbd>Alt</kbd>+scroll zooms time only. Drag to pan. <strong>Fit</strong>, or a double-click on the chart, frames the visible curves and fault levels. <strong>Ref. Voltage</strong> at the top right scales every device’s current to one voltage so devices either side of a transformer can be compared on the same axis.',
      shot: { file: 'tcc-read-2.png', alt: 'The chart toolbar and the reference voltage',
        setup: 'tcc-open', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '.tcc-chart-toolbar', label: 'Zoom, fit, fault levels, cursor, compare' },
          { sel: '.tcc-voltage-ref', label: 'Reference voltage for scaling' },
        ] } },
    { title: 'Choose which fault levels show',
      html: '<strong>Faults</strong> shows or hides the fault levels, drawn as dashed vertical lines with a strip along the top. The arrow beside it chooses what is shown: three-phase, single line to ground and peak, for the devices on the path, at this voltage, or everywhere, plus the minimum and maximum range and the maximum and minimum labels.',
      shot: { file: 'tcc-read-3.png', alt: 'The fault display options menu',
        setup: 'tcc-faults', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '#btn-tcc-faults, #btn-tcc-fault-markers', label: 'Show or hide fault levels' },
          { sel: '.tcc-fault-menu', label: 'Which levels, and for which devices' },
        ] } },
    { title: 'Read every device at one current',
      html: 'Press <strong>Cursor</strong> and click a current on the plot. A panel lists each device’s trip time at that current, so you can read the grading at a fault without following curves by eye. Click elsewhere on the plot to move it, or pick a fault level to snap to.',
      shot: { file: 'tcc-read-4.png', alt: 'The cursor placed on the chart with each device’s trip time listed',
        setup: 'tcc-cursor', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '.tcc-cursor-panel', label: 'Trip time of every device at the cursor current' },
        ] } },
    { title: 'Compare two arrangements',
      html: '<strong>Compare</strong> puts two tabs side by side, for example the 11 kV and 0.4 kV views, or a before and after. The <em>View</em> bar above the chart keeps saved arrangements: which devices are shown, the zoom and the fault display.',
      shot: { file: 'tcc-read-5.png', alt: 'Two tabs shown side by side',
        setup: 'tcc-compare', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '#btn-tcc-compare', label: 'Compare' },
          { sel: '.tcc-view-bar', label: 'Saved views' },
        ] } },
    { title: 'Export',
      html: '<strong>Export</strong> writes the chart as a PNG or PDF, or the curve data as a CSV, for a report or a spreadsheet.' },
  ],
  tips: ['The chart evaluates each curve at the current the device carries, including current transformer saturation for relays.'],
  related: [{ help: 'prot-tcc', label: 'Time-current curves & relay settings (the maths)' }, { help: 'prot-ct-pt', label: 'CT saturation & PT adequacy' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'tcc-settings', group: 'protection', title: 'Change a device’s settings on the TCC',
  where: 'TCC ▸ Devices ▸ Selected device', time: '5 min', phone: 'Use a wider screen',
  intro: 'You can adjust a breaker, fuse or relay while watching its curve move against its neighbours, and add a device that is not yet on the diagram to try it out.',
  steps: [
    { title: 'Select a device',
      html: 'Click a device’s row in the list, or its curve on the chart. The <strong>Selected device</strong> panel shows its settings, and its curve is highlighted. The row’s buttons centre the chart on it, show only that one (solo), or hide it.',
      shot: { file: 'tcc-settings-1.png', alt: 'A breaker selected with its settings in the Selected device panel',
        setup: 'tcc-select', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '.tcc-device-item', text: 'CB-M1', label: 'The selected device' },
          { sel: '.tcc-inspector', label: 'Its settings — change a value and the curve moves' },
        ] } },
    { title: 'Change a setting',
      html: 'Edit a value in the panel and the curve follows at once. You can also drag a handle on the curve itself (pickup, delay, instantaneous), or with a curve selected, press the arrow keys to move the handle one step. A breaker with a trip unit moves to the next real dial position, not an arbitrary number.' },
    { title: 'Try a device that is not on the diagram',
      html: '<strong>+ Add device</strong> opens a small form to add a breaker, fuse or relay curve to the chart from the libraries, or from your own data. It is a way to test grading before you commit a device to the single line.',
      shot: { file: 'tcc-settings-2.png', alt: 'The Add device form',
        setup: 'tcc-add', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '.tcc-add-popover', label: 'Choose the device and its settings' },
        ] } },
    { title: 'Save the arrangement as a view',
      html: 'When the chart shows what you want, <strong>Save as…</strong> stores it as a named view. You choose what it remembers: the path and grading point, which curves are shown, the zoom, colours and label positions, the fault display, the cursor and reference voltage, and the grading margin. Device settings are not part of a view; they stay on the diagram, so a view always shows the current ones. Pick a view from the list to return to it.',
      shot: { file: 'tcc-settings-3.png', alt: 'The Save this arrangement as a view dialog',
        setup: 'tcc-saveas', clip: '#tcc-modal',
        callouts: [
          { sel: '.tcc-save-card, .tcc-sv-include', label: 'What the view remembers' },
        ] } },
  ],
  tips: ['Settings changed here belong to the device itself, so the diagram, arc flash and the other studies use them.', 'Use <em>Reset</em> on a dial to go back to the library default.'],
  related: [{ help: 'trip-unit', label: 'Set up a breaker’s trip unit' }, { help: 'prot-tcc', label: 'Time-current curves & relay settings' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'tcc-coordination', group: 'protection', title: 'Check coordination and the trip sequence',
  where: 'TCC ▸ the checks panel at the bottom', time: '8 min', phone: 'Use a wider screen',
  intro: 'Coordination means the device nearest a fault clears it and the ones behind it stay in. The checks panel tests every upstream and downstream pair for you, proposes fixes, and verifies the order devices operate in for a fault at a chosen bus.',
  steps: [
    { title: 'Set the grading margin',
      html: 'In the <strong>Coordination</strong> tab of the checks panel, <strong>Grading margin</strong> is the minimum time an upstream device must be slower than the one below it. The default is 0.3 s; use what your design basis requires.' },
    { title: 'Detect miscoordination',
      html: 'Press <strong>Detect miscoordination</strong>. Each problem is listed with a severity, what is wrong (for example <em>trips at the same time as \u2014 race condition</em>), the current it was found at, and the trip times of both devices. Below it, the pair table lists every upstream and downstream pair with its status (Pass, Note or Fail), the margin you have and the margin required. Click a row to show that pair on the chart; <strong>Fails only</strong> hides the rest.',
      shot: { file: 'tcc-coordination-1.png', alt: 'A miscoordination reported between two breakers',
        setup: 'tcc-coord', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '#btn-tcc-detect-miscord', label: 'Detect miscoordination' },
          { sel: '.tcc-coord-table', label: 'The issue: which devices, at what current, and their trip times' },
        ] } },
    { title: 'Let it propose a fix',
      html: '<strong>Auto-coordinate\u2026</strong> works out setting changes that give the grading margin and previews them on the chart before you keep them; nothing changes on the diagram until you accept. When no setting can do it, it says so and names the pair. Here no long-time delay class gives enough margin, so the answer is a different device or rating.',
      shot: { file: 'tcc-coordination-2.png', alt: 'Auto-coordinate reporting a pair it could not coordinate',
        setup: 'tcc-autocoord', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '#btn-tcc-auto-coord', label: 'Auto-coordinate' },
          { sel: '.tcc-coord-info', label: 'What it changed, and what it could not coordinate' },
        ] } },
    { title: 'Verify the order of operation',
      html: 'On the <strong>Sequence</strong> tab, <strong>Verify sequence</strong> walks each faulted bus and lists the order devices operate in: primary, then backup, then final, with each trip time and the margin to the next. A device that sees the fault but has no trip path is flagged. Run it for the minimum fault too, since a backup that grades well at maximum fault can be very slow at the end of a long feeder.',
      shot: { file: 'tcc-coordination-3.png', alt: 'The Sequence tab with the verified trip order for each bus',
        setup: 'tcc-sequence', clip: '#tcc-modal .modal-content',
        callouts: [
          { sel: '#btn-tcc-verify-seq', label: 'Verify sequence' },
        ] } },
    { title: 'Distance relays and fault levels',
      html: 'The <strong>Distance</strong> tab computes the zone reaches (Z1, Z2, Z3) from the line and transformer impedances and the infeed, and checks every distance relay’s settings against them. <strong>Fault levels</strong> lists the fault current at each bus used by these checks.' },
  ],
  tips: ['Fix a Fail by moving the upstream device’s delay or pickup, then press Detect again; the table refreshes.', 'The Sequence of Operation study in the Analyse menu runs the same check as a report.'],
  related: [{ help: 'prot-sequence', label: 'Sequence of operation (the method)' }, { help: 'prot-tcc', label: 'Time-current curves & relay settings' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-fault', group: 'analyses', title: 'Run a short-circuit study',
  where: 'Analyse ▸ Short circuit ▸ Short Circuit (IEC 60909)', time: '5 min', phone: 'Results are readable on a phone',
  intro: 'The short-circuit study finds the fault current at every bus: three-phase, single line to ground, line to line and double line to ground, with the contribution from motors. Equipment is then checked against it.',
  steps: [
    { title: 'Have what the study needs',
      html: 'The network has to be connected to a source with its fault level (the utility’s short-circuit MVA or a generator), transformers with their impedance, and cables with their length. Run <strong>Analyse ▸ Short circuit ▸ Short Circuit (IEC 60909)</strong>, or the <strong>Fault Analysis</strong> button on the toolbar.',
      shot: { file: 'study-fault-1.png', alt: 'The Analyse menu with the Short circuit group',
        setup: 'menu-analyse', clip: 'viewport',
        callouts: [
          { sel: '#btn-run-fault', label: 'Short Circuit (IEC 60909)' },
        ] } },
    { title: 'Read the result boxes',
      html: 'Every bus gets a box: the three-phase current, the peak current (ip), single line to ground, line to line, double line to ground, and the contribution from motors. A message in the status bar confirms the study ran on all buses.',
      shot: { file: 'study-fault-2.png', alt: 'Fault result boxes at the buses of a small plant',
        setup: 'study-fault', clip: '#sld-canvas',
        callouts: [
          { sel: '.annotation-badge', label: 'Fault currents at a bus', all: false },
        ] } },
    { title: 'See where equipment is exceeded',
      html: 'A breaker whose rating is lower than the fault current at its bus is marked with a warning symbol. The <strong>Duty Check</strong> study lists them with the numbers; the next guides cover it.' },
    { title: 'Choose what is shown',
      html: 'In <strong>Project details ▸ Result boxes &amp; values</strong> (the right-hand panel with nothing selected), tick which fault quantities appear. <strong>Results ▸ Fault Results</strong> shows or hides the boxes for the whole study.' },
  ],
  tips: ['The study uses a maximum case with the voltage factor c max and a minimum case with c min and motors left out; protection settings use the minimum.', 'Change a source’s fault level and run again; the boxes are replaced.'],
  related: [{ help: 'fault-iec60909', label: 'Short circuit (IEC 60909)' }, { help: 'fault-zero-seq', label: 'Zero-sequence & earthing' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-loadflow', group: 'analyses', title: 'Run a load flow study',
  where: 'Analyse ▸ Power flow ▸ Load Flow', time: '5 min', phone: 'Results are readable on a phone',
  intro: 'Load flow solves the voltage at every bus and the power in every branch for the loads and generation as drawn. It shows where voltage is out of range and which cables or transformers are overloaded.',
  steps: [
    { title: 'Run it',
      html: 'Open <strong>Analyse ▸ Power flow ▸ Load Flow</strong> or the <strong>Load Flow</strong> toolbar button. The same group has the unbalanced load flow, a 24 hour or yearly time-series, the Load Flow Study Manager for comparing named cases, optimal power flow and a DC load flow.',
      shot: { file: 'study-loadflow-1.png', alt: 'The Analyse menu with the Power flow group',
        setup: 'menu-analyse', clip: 'viewport',
        callouts: [
          { sel: '#btn-run-loadflow', label: 'Load Flow' },
          { sel: '#btn-lf-study', label: 'Compare named cases' },
        ] } },
    { title: 'Read the boxes',
      html: 'Each bus shows its voltage (in kV and per unit), angle, real and reactive power, apparent power and current. Branches show the power through them and their loading. A branch over its rating is flagged in red with its loading as a percentage, and a bus outside the voltage band is highlighted.',
      shot: { file: 'study-loadflow-2.png', alt: 'Load flow boxes with an overloaded cable marked',
        setup: 'study-loadflow', clip: '#sld-canvas',
        callouts: [
          { sel: '.annotation-badge', label: 'Voltage, power and current at a bus' },
        ] } },
    { title: 'Check the messages',
      html: 'The status bar says whether the solver converged and in how many iterations. If it did not, the cause is usually a source with no path to a load, a bus with the wrong voltage, or a load far larger than the supply. The dispatch summary lists what each source and battery delivered.' },
    { title: 'Try a change',
      html: 'Open or close a breaker, change a tap or add a capacitor bank and run again to see the effect. <strong>Scenarios</strong> keeps named switching states so you can return to one.' },
  ],
  tips: ['Time-series and the study manager reuse this same solver, so a flat profile reproduces this result exactly.'],
  related: [{ help: 'flow-loadflow', label: 'Load flow (the method)' }, { help: 'wf-studies', label: 'Run All Studies, scenarios & load-flow cases' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-arcflash', group: 'analyses', title: 'Run an arc flash study and print labels',
  where: 'Analyse ▸ Protection & safety ▸ Arc Flash', time: '5 min', phone: 'Results are readable on a phone',
  intro: 'The arc flash study gives the incident energy and arc flash boundary at each bus, from the arcing current and the time the upstream protection takes to clear it, and the PPE category that goes with it.',
  steps: [
    { title: 'Check the inputs',
      html: 'Each bus has its own equipment type, electrode configuration, gap, working distance and enclosure size in its properties, and a method (<em>IEEE 1584-2018</em> for new buses, <em>2002</em> for projects saved before it). Protection settings on the breakers and relays upstream set the clearing time, so give them realistic trip settings first.' },
    { title: 'Run the study',
      html: 'Open <strong>Analyse ▸ Protection &amp; safety ▸ Arc Flash</strong> or the <strong>Arc Flash</strong> toolbar button. A table lists each bus with its voltage, bolted fault current, arcing current, incident energy, boundary, clearing time and PPE category.',
      shot: { file: 'study-arcflash-1.png', alt: 'The arc flash results table',
        setup: 'study-arcflash', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Incident energy, boundary, clearing time and PPE for each bus' },
        ] } },
    { title: 'Read the result',
      html: 'A bus that shows <strong>DANGER</strong> has an incident energy above 40 cal/cm², which no PPE category covers: the answer is a faster clearing time (a lower instantaneous setting, an arc-flash maintenance mode, a current limiting device), not heavier PPE. The result boxes on the diagram carry the same numbers for each bus.' },
    { title: 'Print the labels',
      html: 'After the study, <strong>Output ▸ Reports ▸ Arc Flash Labels (PDF)</strong> makes warning labels with the incident energy at the working distance, the minimum arc rating and the boundary for every bus.',
      shot: { file: 'study-arcflash-2.png', alt: 'The Output menu with Arc Flash Labels',
        setup: 'menu-output', clip: 'viewport',
        callouts: [
          { sel: '#btn-export-aflabels', label: 'Arc Flash Labels (PDF)' },
        ] } },
  ],
  tips: ['Run it for the minimum fault too: a lower arcing current can be cleared more slowly and give a higher energy.', 'Use the TCC to see why a bus has a long clearing time.'],
  related: [{ help: 'prot-arcflash-2018', label: 'Arc flash (IEEE 1584-2018)' }, { help: 'tcc-coordination', label: 'Check coordination and the trip sequence' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-cable', group: 'analyses', title: 'Size and check cables',
  where: 'Analyse ▸ Sizing & installation ▸ Cable Sizing', time: '5 min', phone: 'Results are readable on a phone',
  intro: 'Cable sizing checks every cable on the diagram for current rating, voltage drop, protection and fault withstand, and recommends the smallest standard size that passes everything.',
  steps: [
    { title: 'Run it',
      html: 'Open <strong>Analyse ▸ Sizing &amp; installation ▸ Cable Sizing</strong>. The load each cable carries is taken from what it feeds, so wire the cable between its source and its load. Its installation method, ambient temperature and grouping are set in its properties.' },
    { title: 'Read the table',
      html: 'Each cable has its load current, thermal loading as a percentage of its derated capacity, volt drop, protection check and fault withstand, a status, and a recommended size when it fails. The messages under a failing row say which check and by how much.',
      shot: { file: 'study-cable-1.png', alt: 'The cable sizing results with a failing cable and its recommendation',
        setup: 'study-cable', clip: '#cable-sizing-modal .modal-content',
        callouts: [
          { sel: '#cable-sizing-modal table', label: 'Load, thermal, volt drop, protection, withstand and the recommendation' },
          { sel: '#cable-sizing-modal .cs-filter, #cable-sizing-modal [class*="filter"]', label: 'Show all cables, or only those at one bus' },
        ] } },
    { title: 'See it on the diagram',
      html: 'Every cable also carries a small result box with its size, loading and volt drop, green when it passes and red when it fails. With a large diagram, <strong>Results ▸ Cables at Selected Bus</strong> keeps only those at one bus; see the cable focus guide.',
      shot: { file: 'study-cable-2.png', alt: 'A cable result box in red on the diagram',
        setup: 'study-cable-canvas', clip: '#sld-canvas',
        callouts: [
          { sel: '.annotation-badge', label: 'A cable’s result box', all: false },
        ] } },
  ],
  tips: ['Where nothing standard passes, the recommendation suggests parallel cables, a shorter route, a higher voltage or faster fault clearing.', 'Cable sizes come from the one cable library, so your company’s library entries are what it recommends from.'],
  related: [{ help: 'cable-sizing', label: 'Cable sizing (thermal, voltage drop, fault)' }, { help: 'cable-focus', label: 'Show only the cables at one bus' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-motor', group: 'analyses', title: 'Check motor starting',
  where: 'Analyse ▸ Stability & dynamics ▸ Motor Starting', time: '5 min', phone: 'Results are readable on a phone',
  intro: 'Motor starting finds the voltage dip when each motor starts across the line or by its starter, and whether the motor will accelerate and the rest of the network stay within limits.',
  steps: [
    { title: 'Set the motor and its starter',
      html: 'Each motor has its rating, locked-rotor current and torque, and starter (direct on line, star-delta, autotransformer, soft starter) in its properties. The bus and supply behind it give the system strength the dip depends on.' },
    { title: 'Run it',
      html: 'Open <strong>Analyse ▸ Stability &amp; dynamics ▸ Motor Starting</strong>. Every motor on the diagram is checked.',
      shot: { file: 'study-motor-1.png', alt: 'Motor starting results for two motors with the dip at each bus',
        setup: 'study-motor', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] .modal-content > * > div', label: 'One card per motor: start current, terminal voltage and the dip at each bus', all: false },
        ] } },
    { title: 'Read the dip',
      html: 'Each motor card gives the start current, the voltage at its terminals in per unit, whether it will start, and the dip at each bus on the way back to the source. Dips are coloured by how much of the limit they use. A motor that will not start has too little terminal voltage for its starting torque.',
      shot: { file: 'study-motor-2.png', alt: 'Motor starting boxes on the diagram',
        setup: 'study-motor-canvas', clip: '#sld-canvas',
        callouts: [
          { sel: '.annotation-badge', label: 'Voltage at the motor while starting', all: false },
        ] } },
    { title: 'Go further',
      html: 'For the speed and current against time, and the thermal use of the rotor, use <strong>Dynamic Motor Starting</strong> in the same menu.' },
  ],
  tips: ['A soft starter or star-delta starter is the usual fix for a dip that is too deep; run again to see it.'],
  related: [{ help: 'dyn-motor-static', label: 'Motor starting (voltage dip)' }, { help: 'dyn-motor-dynamic', label: 'Dynamic motor starting' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-duty', group: 'analyses', title: 'Check equipment duty',
  where: 'Analyse ▸ Protection & safety ▸ Duty Check', time: '4 min', phone: 'Results are readable on a phone',
  intro: 'The duty check compares each breaker, fuse and transformer with the fault and load it sees: breaking and making capacity, short-time withstand and voltage rating. It tells you which equipment is under-rated.',
  steps: [
    { title: 'Run it',
      html: 'Open <strong>Analyse \u25B8 Protection &amp; safety \u25B8 Duty Check</strong>. It works out the fault current at each bus itself, so no other study has to be run first. Each device needs its rated breaking capacity and voltage in its properties.' },
    { title: 'Read the table',
      html: 'Transformer loading is listed first, then each protective device with the fault at its bus, its rating, the utilisation as a percentage, and a status. A failing device gets one line for each check it fails: the largest prospective fault against its breaking capacity, the peak against its making capacity, and so on. A warning is something to confirm, such as a rated voltage below the highest voltage of the system.',
      shot: { file: 'study-duty-1.png', alt: 'The duty check with four failing breakers and the reason for each',
        setup: 'study-duty', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Transformers, then each device with its fault, rating and utilisation' },
        ] } },
    { title: 'Fix what fails',
      html: 'A device that fails needs a higher rating, a current-limiting upstream device, or a lower fault level (a transformer with higher impedance, for example). Change it and run both studies again.' },
  ],
  tips: ['Fuses and LV breakers are judged on the largest prospective fault; medium-voltage breakers on breaking, making and asymmetry.'],
  related: [{ help: 'prot-duty', label: 'Equipment duty check' }, { help: 'study-fault', label: 'Run a short-circuit study' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-grounding', group: 'analyses', title: 'Check a substation grounding grid',
  where: 'Analyse ▸ Earthing & lightning ▸ Grounding (IEEE 80)', time: '6 min', phone: 'Results are readable on a phone',
  intro: 'The grounding study checks the touch and step voltages of an earth grid against the safe limits, for the fault current that flows into it, and sizes the grid conductor.',
  steps: [
    { title: 'Describe the grid on the bus',
      html: 'In the properties of the bus, open its grounding section: soil resistivity, grid size and mesh, conductor and burial depth, number and length of rods, the surface layer, and the fault clearing time. For a grid of any shape, use the earth grid designer and pick it on the bus (see that guide).' },
    { title: 'Run it',
      html: 'Open <strong>Analyse ▸ Earthing &amp; lightning ▸ Grounding (IEEE 80)</strong>. Every bus with a grid is checked, or only the ones you select.' },
    { title: 'Read the result',
      html: 'Each bus shows the grid resistance, the ground potential rise, the mesh (touch) and step voltages against their limits, the conductor size against the minimum for the fault, and a plan of the grid. A touch or step voltage over its limit is a failure. A ground potential rise over the touch limit with a safe mesh voltage is a warning to check transferred potentials.',
      shot: { file: 'study-grounding-1.png', alt: 'The grounding results with touch and step voltage against their limits',
        setup: 'study-grounding', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] .modal-content', label: 'Touch and step voltage against the limits, conductor size and the grid plan', all: false },
        ] } },
    { title: 'Improve the design',
      html: 'To bring a voltage down add rods or conductors, reduce the mesh spacing or add a surface layer, then run it again. Use the <strong>Wenner Test Interpreter</strong> in the same menu to turn field soil measurements into a resistivity.' },
  ],
  tips: ['Where the earth-fault current at the bus is not known, the three-phase current is used instead, which overstates it; enter the design earth-fault current.'],
  related: [{ help: 'prot-grounding', label: 'Substation grounding (IEEE 80)' }, { help: 'earth-grid', label: 'Design an earth grid' }] },

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
  HelpGuideLinks.init();
});

// Open Help on a guide (from any module: HelpGuides.openGuide('db-ga')).
HelpGuides.openGuide = function (id) {
  const modal = document.getElementById('help-modal');
  if (!modal) return;
  // Full-screen managers and the command search sit above ordinary modals.
  // Close the command search the way Esc does, so its key handler is released too.
  if (document.getElementById('cmd-search')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  modal.style.zIndex = '4000';
  modal.style.display = '';
  document.querySelector('.help-tab[data-tab="guides"]')?.click();
  this.open(id);
};

// ─────────────────────────────────────────────────────────────────────────────
// "? Guide" links on each feature's own screen. Screens are built (and rebuilt)
// by their modules, so a small observer keeps one link in each host rather than
// every module having to remember to draw it.
//
//   host   CSS selector of the element to put the link in (appended), or
//   after / before   CSS selector of an element the link is placed beside
//   guide  a guide id, or () => id when it depends on the screen's state
//   when   optional () => boolean; the link exists only while it is true
// ─────────────────────────────────────────────────────────────────────────────
const HELP_GUIDE_LINKS = [
  { host: '#sch-grid-head', guide: () => {
      const tab = typeof Schedules !== 'undefined' ? Schedules._tab : 'grid';
      if (tab === 'grid' && typeof SchMobile !== 'undefined' && SchMobile.isPhone()) return 'db-phone';
      return { grid: 'db-schedule', drawing: 'db-single-line', ga: 'db-ga' }[tab] || 'db-schedule';
    } },
  { host: '#plan-toolbar', guide: 'plan-select' },
  { after: 'button[data-action="diagram"]', guide: 'demand-plan' },
  { host: '.sl-toolbar', guide: 'street-light' },
  { host: '.tu-head', guide: 'trip-unit' },
  { after: '#lr-tag-scope', guide: 'lightning' },
  { after: '#btn-eg-save', guide: 'earth-grid' },
  { before: '#lib-sub', guide: 'libraries' },
  { host: '#cable-focus-bar', guide: 'cable-focus' },
  { host: '.cmd-search-input-row', guide: 'find-anything' },
  { after: '.ws-dialog-note', guide: 'project-types' },
  { after: '#project-quoted-chip', guide: 'quoted', when: () => typeof Quote !== 'undefined' && Quote.isQuoted() },
  { before: '#tcc-modal .tcc-header-actions', guide: 'tcc-read' },
  { before: '#arcflash-modal .modal-close', guide: 'study-arcflash' },
  { before: '#cable-sizing-modal .modal-close', guide: 'study-cable' },
  { before: '#motor-starting-modal .modal-close', guide: 'study-motor' },
  { before: '#duty-check-modal .modal-close', guide: 'study-duty' },
  { before: '#grounding-modal .modal-close', guide: 'study-grounding' },
];

const HelpGuideLinks = {
  _t: null,

  init() {
    document.addEventListener('click', (e) => {
      const b = e.target.closest('.hg-link');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const id = b.dataset.hgGuide;
      if (id) HelpGuides.openGuide(id);
    }, true);
    const run = () => { this._t = null; this.sync(); };
    const obs = new MutationObserver(() => { if (!this._t) this._t = requestAnimationFrame(run); });
    obs.observe(document.body, { childList: true, subtree: true });
    this.sync();
  },

  _guideId(def) {
    try { return typeof def.guide === 'function' ? def.guide() : def.guide; } catch (_) { return null; }
  },

  sync() {
    HELP_GUIDE_LINKS.forEach((def, i) => {
      const slot = String(i);
      const want = (!def.when || def.when()) ? this._guideId(def) : null;
      const anchors = def.host ? [...document.querySelectorAll(def.host)] : [...document.querySelectorAll(def.after || def.before)];
      anchors.forEach(a => {
        const has = def.host
          ? a.querySelector(`:scope > .hg-link[data-hg-slot="${slot}"]`)
          : (def.after ? a.nextElementSibling : a.previousElementSibling);
        const existing = has && has.classList && has.classList.contains('hg-link') && has.dataset.hgSlot === slot ? has : null;
        if (!want) { if (existing) existing.remove(); return; }
        if (existing) { existing.dataset.hgGuide = want; return; }
        const g = HELP_GUIDES.find(x => x.id === want);
        if (!g) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hg-link';
        b.dataset.hgSlot = slot;
        b.dataset.hgGuide = want;
        b.title = `Open the guide: ${g.title}`;
        b.textContent = '? Guide';
        if (def.host) a.appendChild(b);
        else if (def.after) a.insertAdjacentElement('afterend', b);
        else a.insertAdjacentElement('beforebegin', b);
      });
    });
  },
};
