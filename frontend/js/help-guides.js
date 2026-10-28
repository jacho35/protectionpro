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
  { id: 'sld', title: 'Single-line diagram basics' },
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
{ id: 'sld-draw', group: 'sld', title: 'Draw a single-line diagram',
  where: 'Single-line ▸ Components palette', time: '15 min', phone: 'Use a wider screen to draw; the diagram can be read on a phone',
  intro: 'Every study in the app runs on the single-line diagram: sources, transformers, buses, protection and loads, joined by wires. Place the components, wire them, give each its ratings, and the diagram is ready to analyse.',
  steps: [
    { title: 'Find a component and place it',
      html: 'Open the <strong>Single-line</strong> workspace. The <strong>Components</strong> palette on the left lists everything by category: sources, distribution, protection, instruments, loads and more. Type in <strong>Search components</strong> to filter it, then <strong>drag</strong> a symbol onto the canvas. It snaps to the grid. Place the first components in the order power flows, from the source down to the loads.',
      shot: { file: 'sld-draw-1.png', alt: 'The Components palette filtered by the word trans',
        setup: 'sld-palette', clip: '#sidebar',
        callouts: [
          { sel: '#component-search', label: 'Type part of a name to filter the palette' },
          { sel: '.palette-item', label: 'Drag a symbol onto the canvas' },
        ] } },
    { title: 'Wire the components together',
      html: 'Press <strong>Wire</strong> (or <kbd>W</kbd>). Press on a component’s <strong>port</strong>, drag to the port of the next one and let go; the wire routes itself at right angles. A <strong>bus</strong> has no fixed ports: drop the wire anywhere along its bar. Press <kbd>V</kbd> or <kbd>Esc</kbd> to go back to selecting. <strong>Double-click</strong> a wire to add a bend you can drag, and double-click the bend to remove it. To make a bus longer, select it and drag its end handles.',
      shot: { file: 'sld-draw-2.png', alt: 'Wire mode with a wire being dragged from a transformer to a bus bar',
        setup: 'sld-wire', clip: 'viewport',
        callouts: [
          { sel: '#btn-wire', label: 'Wire mode — W' },
          { sel: '#canvas-mode-indicator', label: 'The mode you are in; click it to switch' },
          { sel: '.sld-component[data-id^="bus"]', label: 'A bus takes a wire anywhere along its bar' },
        ] } },
    { title: 'Give each component its ratings',
      html: 'Switch back to <strong>Select</strong> and click a component. Its <strong>properties panel</strong> opens on the right, grouped by what the value is for: general, fault analysis, load flow, grounding, and so on. A <strong>default</strong> tag marks a typical value the app has filled in; type your own figure to replace it. The <em>i</em> beside a field says what it means. Where a library exists (transformers, cables, breakers, fuses) pick a <strong>Standard type</strong> and the ratings are filled in for you. <strong>View Calculations</strong> shows how the component’s values are used.',
      shot: { file: 'sld-draw-3.png', alt: 'The properties panel of a transformer with ratings and default tags',
        setup: 'sld-props', clip: '#properties-panel',
        callouts: [
          { sel: '[data-field="name"]', label: 'Name — appears on the diagram and in every result' },
          { sel: '[data-field="standard_type"] + .ss', label: 'Pick a standard type to fill the ratings' },
          { sel: '.prop-default-flag', label: 'A typical default — replace it with your own value' },
          { sel: '#btn-show-calc', label: 'How the values are used' },
        ] } },
    { title: 'Check the drawing',
      html: 'The diagram shows each component’s name and key ratings beside it. <strong>View</strong> turns cable labels, device labels and the component ribbon on or off. <strong>Connection Warnings</strong> marks any port that is still open, so a missing wire shows before you run a study. The <strong>minimap</strong> at the bottom right shows where you are on a large diagram, and <strong>Fit</strong> in the toolbar brings the whole diagram into view.',
      shot: { file: 'sld-draw-4.png', alt: 'A finished single-line diagram of a source, transformer, bus and motor',
        setup: 'sld-drawn', clip: '#canvas-container',
        callouts: [
          { sel: '#minimap', label: 'Minimap of the whole diagram' },
          { sel: '#page-tab-bar', label: 'Sheets — add one for a big diagram' },
        ] } },
    { title: 'Save, then analyse',
      html: 'Press <strong>Save</strong> (<kbd>Ctrl</kbd>+<kbd>S</kbd>) to keep the project in your account; <strong>Auto Save</strong> in the header also keeps it up to date. To start from a worked example instead of a blank page, use <strong>Project ▸ Templates</strong>. Then run a study from the <strong>Analyse</strong> menu, or press <strong>Run All Studies</strong>; the results appear as boxes you can drag on the diagram.' },
  ],
  tips: ['Components snap to a 20-unit grid. Arrow keys nudge a selection by one grid step, and <kbd>Shift</kbd>+arrow by five.', 'Rename components early: the names appear in the TCC, the result tables and the reports.'],
  related: [{ help: 'wf-studies', label: 'Run All Studies, scenarios & load-flow cases' }, { help: 'wf-files', label: 'Saving, revisions & sharing' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'sld-edit', group: 'sld', title: 'Select, tidy and undo on the single line',
  where: 'Single-line ▸ Edit menu', time: '8 min', phone: 'Multi-select toggle instead of Shift',
  intro: 'A diagram rarely comes out right the first time. These are the tools for moving things about, copying a section, lining it up and taking a step back.',
  steps: [
    { title: 'Select what you want to change',
      html: 'Click a component or wire to select it. <kbd>Shift</kbd>+click adds to the selection, and dragging a box on empty canvas selects everything inside it. <kbd>Ctrl</kbd>+<kbd>A</kbd> selects all. A selected component shows a blue outline, and its properties open on the right.' },
    { title: 'Move, copy and delete',
      html: 'Drag to move; wires follow. <kbd>Ctrl</kbd>+<kbd>C</kbd> and <kbd>Ctrl</kbd>+<kbd>V</kbd> copy and paste, <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates, <kbd>Ctrl</kbd>+<kbd>X</kbd> cuts, <kbd>R</kbd> rotates a quarter turn and <kbd>Delete</kbd> removes. Pasted wires between copied components come with them. <strong>Right-click</strong> a component, wire or empty space for the menu that fits it, such as opening or closing a breaker, or running a fault study at a bus.' },
    { title: 'Line things up',
      html: 'Select two or more components, open <strong>Edit</strong> and choose from <strong>Arrange selection</strong>: align left, centre or right, align top, middle or bottom, or distribute horizontally or vertically so the gaps are equal. <strong>Auto-arrange diagram</strong> lays the whole network out in layers with the sources on top and the loads below, and <strong>Auto-arrange from selection down</strong> tidies only what hangs below the selection. <strong>Pin / unpin selection</strong> locks components where they are so an auto-arrange leaves them alone.',
      shot: { file: 'sld-edit-1.png', alt: 'The Edit menu with three components selected and the Arrange selection items',
        setup: 'sld-multi', clip: 'viewport',
        callouts: [
          { sel: '#menu-edit .toolbar-menu-panel', label: 'Edit menu: copy, group and arrange the selection' },
        ] } },
    { title: 'Group related parts',
      html: 'Select a few components and press <kbd>Ctrl</kbd>+<kbd>G</kbd> to group them, for instance a motor and its starter. A group moves, copies and selects as one. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> ungroups.' },
    { title: 'Undo and redo',
      html: 'Press <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> (or <kbd>Ctrl</kbd>+<kbd>Y</kbd>) to redo; the toolbar has the same two buttons. The last 50 states are kept, and the status bar says how far back you can go.',
      shot: { file: 'sld-edit-2.png', alt: 'The toolbar with the undo and redo buttons and the status bar undo counter',
        setup: 'sld-drawn', clip: 'viewport',
        callouts: [
          { sel: '#btn-undo', label: 'Undo — Ctrl+Z' },
          { sel: '#btn-redo', label: 'Redo — Ctrl+Shift+Z' },
          { sel: '#status-bar', label: 'Mode, cursor position and undo depth' },
        ] } },
    { title: 'Spread a big diagram over sheets',
      html: 'Press <strong>+</strong> beside the <strong>Sheet</strong> tabs to add a sheet. Each sheet is a page of the same network, so a feeder drawn on sheet 2 is still part of the one study. Join sheets with a pair of <strong>Off-page connectors</strong> linked to each other.' },
  ],
  tips: ['<kbd>Esc</kbd> cancels a wire or a drag in progress, and clears the selection.', 'The mouse wheel zooms and dragging with the middle button pans; <strong>Fit</strong> shows the whole diagram and <strong>1:1</strong> returns to full size.', 'Each align, distribute and auto-arrange is a single undo step.'],
  related: [{ help: 'wf-files', label: 'Saving, revisions & sharing' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'db-schedule', group: 'boards', title: 'Build a board’s circuit schedule',
  where: 'Schedules ▸ board ▸ Schedule', time: '10 min', phone: 'Card list with an edit sheet (see the phone guide)',
  intro: 'The schedule is one row per way: breaker, cable, load and phase. Everything else on the board (single line, front view, bill of quantities, circuit check) is drawn from it.',
  steps: [
    { title: 'Open the board',
      html: 'Open the <strong>Schedules</strong> workspace and pick the board in the rail on the left (the button beside <strong>← Single line</strong> hides the rail). The grid fills the window; the board’s own settings — incoming protection, sections, earth leakage, accessories — are in the side panel on the right, and the installation conditions open from the chip in the header. Boards come from <em>Distribution Board</em> symbols on the single-line diagram. Double-clicking a board on the diagram opens its schedule here, and <strong>← Single line</strong> takes you back.',
      shot: { file: 'db-schedule-1.png', alt: 'The Schedules workspace with a board selected and its circuit schedule',
        setup: 'schedule-grid', clip: '#schedules-workspace',
        callouts: [
          { sel: '#sch-board-list', label: 'Board rail — every distribution board in the project' },
          { sel: '.sch-grid-head .sch-tabs', label: 'Schedule, Single Line and Layout (GA) views of the same board' },
          { sel: '.db-phase-bars', label: 'Load on each phase — R / W / B' },
          { sel: '#db-side', label: 'Side panel — board settings, or bulk edit while ways are ticked' },
          { sel: '.db-schedule-grid thead th.db-grp-h', label: 'Column groups — click a group heading to fold it' },
        ] } },
    { title: 'Add the loads',
      html: 'In the side panel, open <strong>Add common circuits</strong>, choose a load type, set how many, and press <strong>+ Add circuit</strong>. The quick buttons add a batch (10 lights, 5 sockets). <strong>+ Add way</strong> above the grid adds an empty way. Each new way takes the next way number and the next phase, so the board stays balanced as you add.',
      shot: { file: 'db-schedule-2.png', alt: 'The add-load presets and quick buttons in the side panel',
        setup: 'schedule-grid', clip: '#schedules-workspace',
        callouts: [
          { sel: '#db-load-type', label: 'Load type — sets a typical load, breaker and cable' },
          { sel: '#db-quick-lights', label: 'Quick batches' },
        ] } },
    { title: 'Edit like a spreadsheet',
      html: 'Click a cell and type. Arrow keys move, <kbd>Enter</kbd> goes down, <kbd>Tab</kbd> goes right, <kbd>F2</kbd> edits inside a cell. Select a block with <kbd>Shift</kbd>+arrows or by dragging, then <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> to copy to and from Excel, and <kbd>Ctrl</kbd>+<kbd>D</kbd> to fill down. Text pasted into a number cell is refused and marked, never turned into zero.' },
    { title: 'Change many ways at once',
      html: 'Tick the boxes at the left of several ways. The side panel turns into <strong>Bulk edit</strong> with the fields you can set for all of them — leave a field blank to keep each way’s own value — then press <strong>Apply</strong>. The <strong>Device</strong> list shows only library breakers at the Breaker (A) and Curve entered (or the ones the ticked ways share); narrow it further by manufacturer and by MCB / MCCB / ACB.',
      shot: { file: 'db-schedule-3.png', alt: 'Two ways ticked and the bulk edit panel showing',
        setup: 'schedule-bulk', clip: '#schedules-workspace',
        callouts: [
          { sel: '.db-schedule-grid tbody tr:nth-child(3) .db-sel-cell input', label: 'Tick the ways to change' },
          { sel: '#db-bulk-bar', label: 'Bulk edit — blank means leave unchanged' },
        ] } },
    { title: 'Check the circuits',
      html: 'Press <strong>Check circuits</strong>. Each way is checked for breaker against load and cable, volt drop from the origin, earth conductor and earth-fault loop, and the result columns fill in with a pass, warning or fail mark. A change after the check marks the results stale; press the button again.',
      shot: { file: 'db-schedule-4.png', alt: 'The schedule after Check circuits, with the result columns filled in',
        setup: 'schedule-checked', clip: '#schedules-workspace',
        callouts: [
          { sel: '#sch-run-check', label: 'Check circuits' },
          { sel: '.db-schedule-grid thead th[data-label="FLA (A)"], .db-schedule-grid thead th:nth-last-child(5)', label: 'Results — current, rating, volt drop, earth conductor' },
        ] } },
    { title: 'Pick library breakers and read the mini TCC',
      html: 'In the <strong>Device</strong> column pick a breaker from the library: its rating and curve are written to the way. Set the board’s <strong>incoming device</strong> and its maximum fault level under the grid. After <strong>Check circuits</strong>, click a <strong>Coord</strong> cell to open the mini TCC: the way’s breaker, the incomer and any breaker above it on their published bands, with checks for discrimination, the cable’s I²t withstand and breaking capacity (cascading counts where allowed).',
      shot: { file: 'db-schedule-5.png', alt: 'The mini TCC of a way: its breaker and the incomer on their curves with the discrimination, cable and breaking-capacity verdicts',
        setup: 'db-coord', clip: 'viewport',
        callouts: [
          { sel: '.rtcc-plotwrap', label: 'Way, incomer and cable on one chart, against the fault levels' },
          { sel: '.rtcc-side', label: 'Verdicts: breaking capacity, discrimination, cable protection' },
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
      html: 'The <strong>Symbols ×</strong> chip under the canvas scales every symbol on the plan (0.25 to 5). A selected item also has its own <strong>Symbol scale ×</strong>, which multiplies with the plan-wide value. Drawing exports keep the standard size.',
      shot: { file: 'plan-select-4.png', alt: 'The Symbols chip under the canvas and a symbol scale on a selected item',
        setup: 'plan-scale', clip: '#plan-workspace',
        callouts: [
          { sel: '#plan-sym-chip', label: 'Plan-wide symbol size' },
          { sel: '#plan-props', label: 'Symbol scale for the selected item' },
        ] } },
  ],
  tips: ['Duplicate makes untagged copies of elements that are not linked to Demand.', 'Delete works on the whole selection.'],
  related: [{ help: 'design-plan', label: 'Plan markup (site & floor plans)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'plan-dxf', group: 'retic', title: 'Bring in a DXF at the right scale',
  where: 'Plan ▸ Underlays', time: '5 min', phone: 'Works on a phone; the dialog stacks',
  intro: 'A DXF that lands at the wrong size makes every length, area and cable run wrong. Before it lands you confirm its units and drawing scale, and you can check it against a length you know.',
  steps: [
    { title: 'Import it',
      html: 'Switch the bar to <strong>Underlays</strong> and press <strong>Import plan or DXF…</strong>. Pick the <code>.dxf</code>. PDFs and images import the same way and are calibrated from two points.' },
    { title: 'Confirm the units and the drawing scale',
      html: '<strong>One drawing unit is</strong> starts on the units the file states (marked <em>from file</em>), or a guess from its size when it states none. <strong>Drawing scale</strong> is 1 : 1 for a normal CAD model; pick 1 : 50, 1 : 100… (or type your own) when the drawing was drawn at paper size. The size it will land at updates as you choose, and turns orange when it is implausible for a floor or site plan.',
      shot: { file: 'plan-dxf-1.png', alt: 'The DXF import dialog with millimetres from the file, 1 : 1, and the size it lands at',
        setup: 'plan-dxf-dialog', clip: '.dxfi-content',
        callouts: [
          { sel: '.dxfi-units', label: 'One drawing unit — the file’s own is marked' },
          { sel: '.dxfi-form fieldset:nth-of-type(2) .dxfi-chips', label: 'Drawing scale, or your own 1 : N' },
          { sel: '.dxfi-size', label: 'The size it will land at' },
          { sel: '.dxfi-checks', label: 'Check against a known length afterwards' },
        ] } },
    { title: 'Check it against a known length',
      html: 'With <strong>Check against a known length after import</strong> ticked, click the two ends of something you know (a grid line, a door, a wall) and type the real distance. The DXF is re-scaled to match; the floor scale of the other underlays is left alone.' },
    { title: 'Move, align or change it later',
      html: 'Each underlay has a card with show/hide and opacity. Pick its name and the properties panel offers <strong>Change units or scale…</strong> (the same dialog), <strong>Move</strong>, <strong>Align 2 points</strong>, <strong>Layers &amp; blocks</strong> and <strong>Remove from floor</strong>.',
      shot: { file: 'plan-dxf-2.png', alt: 'Underlays mode with a DXF card picked and its actions in the properties panel',
        setup: 'plan-underlays', clip: '#plan-workspace',
        callouts: [
          { sel: '.plan-mode-btn[data-mode="underlays"]', label: 'Underlays mode' },
          { sel: '.plan-ul-card', label: 'Show, opacity — pick the name' },
          { sel: '#plan-props', label: 'Units and scale, move, align, layers, remove' },
        ] } },
  ],
  tips: ['DXFs drawn on the same coordinate grid line up with each other automatically.', 'A DXF with units sets the floor scale when the floor has none.'],
  related: [{ help: 'design-plan', label: 'Plan markup (site & floor plans)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'plan-place', group: 'retic', title: 'Place many devices at once',
  where: 'Plan ▸ Draw', time: '3 min', phone: 'Tap a part, then use the bar over the plan',
  intro: 'Pick a device and a bar over the plan sets how it is placed. The choice and its settings are remembered for each device type, so downlights can always fill an area and sockets always go along a wall.',
  steps: [
    { title: 'Pick a device',
      html: 'In <strong>Draw</strong> mode, click a part in the panel on the left (type in <strong>Find a part</strong> to narrow the list). The placing bar appears over the plan.' },
    { title: 'Choose how it is placed',
      html: '<strong>One at a time</strong>: click for each one. <strong>Fill an area</strong>: drag a box from corner to corner and the columns × rows you set are spread across it. <strong>Along a line</strong>: click the points of a line, press <kbd>Enter</kbd>, and devices are placed every so many metres (or a set number of them), joined by a circuit route. The tool stays armed for the next one; <kbd>Esc</kbd> or <strong>Stop</strong> ends it.',
      shot: { file: 'plan-place-1.png', alt: 'The placing bar with Fill an area chosen and 4 columns by 3 rows',
        setup: 'plan-placebar', clip: '#plan-workspace',
        callouts: [
          { sel: '.plan-place-opt', label: 'How to place it', all: false },
          { sel: '.plan-place-set', label: 'Its settings, remembered for this device' },
        ] } },
  ],
  tips: ['On a building plan, a batch is tagged to the nearest board’s next free circuit.'],
  related: [{ help: 'design-plan', label: 'Plan markup (site & floor plans)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'demand-plan', group: 'retic', title: 'Keep Demand and the site plan in step',
  where: 'Reticulation ▸ Demand and Plan', time: '10 min', phone: 'Demand: card layout; Plan: view and select',
  intro: 'Demand holds the electrical numbers (kiosks, erven, cables, volt drop) and the plan holds the geometry (where they are and how long the routes are). The two stay linked, so a cable changed on one changes on the other.',
  steps: [
    { title: 'Rough out the network in Demand',
      html: 'In <strong>Demand</strong>, <strong>Quick Build</strong> adds a number of kiosks with erven in one go, using the service and feeder cables and lengths you set. <strong>Feed from</strong> chooses the minisub and <strong>Daisy-chain</strong> feeds each kiosk from the one before. You can also add kiosks and erven by hand.' },
    { title: 'Push the plan into Demand',
      html: 'Draw the network on the <strong>Plan</strong>, then switch the bar to <strong>Output</strong> and press <strong>Push to Demand schedules</strong>. Minisubs, kiosks, erven, route lengths and cables become Demand rows. Push again at any time: it updates rows rather than adding duplicates.' },
    { title: 'See and change the link',
      html: 'Select a kiosk, erf or minisub on the plan. <strong>From Demand</strong> shows what Demand says about it (load, cable, volt drop). <strong>Linked Demand item</strong> lists the unlinked rows of its kind, so an item drawn after the row existed can be attached, or detached. Once linked, editing a name or erf number in Demand updates the label on the plan.',
      shot: { file: 'demand-plan-1.png', alt: 'A kiosk selected on the plan with the From Demand panel and the link picker',
        setup: 'demand-linked', clip: '#plan-workspace',
        callouts: [
          { sel: '.plan-demand', label: 'What Demand says about this item' },
          { sel: '#plan-props select', label: 'Link or unlink a Demand row' },
          { sel: '.plan-mode-btn[data-mode="output"]', label: 'Output › Push to Demand schedules' },
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
{ id: 'road-lighting', group: 'retic', title: 'Check a road’s lighting (lux and luminance)',
  where: 'Street lighting ▸ Lighting design', time: '15 min', phone: 'Use a wider screen',
  intro: 'Describe the road as a cross-section, choose a luminaire and a spacing, and the design is checked against its lighting category: average and minimum lux or luminance, uniformity and glare. When it passes, send the spacing to a street-lighting circuit for its volt-drop and earth-loop check.',
  steps: [
    { title: 'Start a design and pick a luminaire',
      html: 'Open <strong>Street lighting ▸ Lighting design</strong> and press <strong>+ New design</strong>. It starts as a two-lane road with a footpath each side and one row of luminaires on the left verge. For a real check, press <strong>Import IES / LDT</strong> and add the manufacturer’s photometry file. <strong>+ Generic</strong> adds a representative optic (narrow, medium or wide) for early feasibility; it is not a real product.',
      shot: { file: 'road-lighting-1.png', alt: 'A new lighting design with its cross-section, luminaire library and verdict',
        setup: 'road-design', clip: '#streetlight-workspace',
        callouts: [
          { sel: '#rl-rail-list .sl-rail-item', label: 'Your designs — each shows pass or fail' },
          { sel: '.rl-lib-actions', label: 'Import the manufacturer’s IES / LDT file, or add a generic optic' },
          { sel: '#rl-xs', label: 'The road drawn as you describe it, with the mounting height' },
          { sel: '.rl-verdict', label: 'Verdict against every class' },
        ] } },
    { title: 'Describe the road',
      html: 'Pick the <strong>Standard</strong> (SANS 10098 or EN 13201), then a <strong>Template</strong> to start from, or add strips one by one: carriageways, footpaths, cycle tracks, verges and medians. Give each strip its width, and for a carriageway its lanes, <strong>road surface</strong> and direction of travel. Each strip’s <strong>Class</strong> is the lighting category it must meet. <strong>Suggest</strong> proposes one from the road’s function and speed.',
      shot: { file: 'road-lighting-2.png', alt: 'The cross-section table with a category for the carriageway',
        setup: 'road-design', clip: '#rl-main .rl-card:has(#rl-sec-body)',
        callouts: [
          { sel: '[data-dz="standard"]', label: 'Standard — SANS 10098 or EN 13201' },
          { sel: '[data-dz="template"]', label: 'Start from a template' },
          { sel: '#rl-sec-body tr:nth-child(2) .rl-cls-cell', label: 'The category the carriageway must meet' },
          { sel: '#rl-sec-body tr:nth-child(2) [data-sec="surface"]', label: 'Road surface — reflection of the asphalt' },
        ] } },
    { title: 'Let the app suggest a category',
      html: 'Press <strong>Suggest</strong> beside a strip. For a road, give the functional road class, speed limit and night-time traffic; for a junction or a cycle or pedestrian way the questions change. It names the category and the reason. <strong>Use this category</strong> writes it into the strip. It is a starting point: the road authority’s classification governs.',
      shot: { file: 'road-lighting-3.png', alt: 'The Suggest a category dialog',
        setup: 'road-suggest', clip: 'viewport',
        callouts: [
          { sel: '#rl-suggest-modal .modal-content', label: 'Road class, speed and traffic give the category' },
        ] } },
    { title: 'Place the luminaires',
      html: 'Choose an <strong>Arrangement</strong> (single-sided, staggered, opposite, twin central) and the <strong>Spacing</strong> between poles in a row. <strong>MF</strong> is the maintenance factor and <strong>Hours/yr</strong> the burning hours for the energy figure. In the row table set the luminaire, setback from the kerb, mounting height, overhang, tilt and flux percentage. Choose <em>Custom rows</em> to set each row on its own.',
      shot: { file: 'road-lighting-4.png', alt: 'The Luminaires card with arrangement, spacing and the luminaire row',
        setup: 'road-design', clip: '#rl-main .rl-card:has(#rl-row-body)',
        callouts: [
          { sel: '[data-dz="arrangement"]', label: 'Arrangement' },
          { sel: '[data-dz="spacing"]', label: 'Spacing between poles' },
          { sel: '#rl-row-body tr', label: 'Luminaire, setback, height, overhang, tilt and flux' },
        ] } },
    { title: 'Read the results',
      html: 'The right-hand column updates as you type. The top box says whether every class is met. Each strip then shows what it requires against what the design delivers (average luminance or lux, uniformity, glare), with a tick or cross, and a note on how the observer and points were taken. <strong>Energy &amp; quantities</strong> gives watts and poles per kilometre and the EN 13201-5 indicators, and the <strong>plan view</strong> shows the lux over one field between two poles. <em>Grid values</em> lists every calculation point.',
      shot: { file: 'road-lighting-5.png', alt: 'A failing design: the verdict, the carriageway check with a failed uniformity, and the energy figures',
        setup: 'road-fail', clip: '#rl-results',
        callouts: [
          { sel: '.rl-verdict', label: 'Does it meet every class?' },
          { sel: '.rl-chk', label: 'Required against calculated, with the failing line marked', },
          { sel: '.rl-isolux', label: 'Lux over one field between two poles' },
        ] } },
    { title: 'Find the spacing that works',
      html: 'If the design fails, press <strong>Find max spacing</strong>. It tries every spacing from <em>From</em> to <em>to</em> and reports the largest that passes every class, with the power and poles per kilometre it gives. The strip shows which spacings pass and which fail. <strong>Use</strong> puts that spacing in the design.',
      shot: { file: 'road-lighting-6.png', alt: 'The Max spacing result with the pass and fail strip',
        setup: 'road-sweep', clip: '#rl-results',
        callouts: [
          { sel: '.rl-best', label: 'The largest spacing that passes, and what it costs in W/km' },
          { sel: '.rl-sw-strip', label: 'Pass or fail at each spacing tried' },
        ] } },
    { title: 'Let it optimise the layout',
      html: '<strong>Optimise…</strong> tries every combination of mounting height, tilt, overhang, luminaire and dimming level, each at its largest passing spacing, and ranks the passing options by W/km, poles per kilometre, PDI or spacing. Press <strong>Run</strong>, then <strong>Use</strong> on the option you want; it is written into every row.',
      shot: { file: 'road-lighting-7.png', alt: 'The Optimise dialog with ranked options',
        setup: 'road-opt', clip: 'viewport',
        callouts: [
          { sel: '#rl-opt-modal .rl-form', label: 'The heights, tilts, overhangs and flux levels to try' },
          { sel: '#rl-opt-modal .rl-grid-scroll', label: 'Passing options, best first — Use applies one' },
        ] } },
    { title: 'Use the result',
      html: '<strong>Apply spacing to circuit…</strong> (shown when the project has street-lighting circuits) writes the pole spacing, and the luminaire’s wattage if it has one, into the circuit you pick, so its volt drop and earth-loop check use the same layout. <strong>PDF report</strong> prints the design, the checks and the isolux plot.' },
  ],
  tips: ['<strong>Classes &amp; surfaces</strong> lists every category with its limits and the road-surface tables.', 'Changing a row’s height, tilt or luminaire in a preset arrangement applies it to every row; choose <em>Custom rows</em> to set rows apart.', 'A generic optic is for feasibility only. Import the product’s IES or LDT file before relying on a pass.', 'If the file’s C90 plane does not face the street, set the luminaire’s <em>Rotate C-planes</em> in the rail.'],
  related: [{ help: 'design-roadlight', label: 'Road lighting design' }, { help: 'design-roomlight', label: 'Room, outdoor & emergency lighting' }] },

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
      html: 'Each dial offers its real positions, with the tripping amps beside it. A dial changed from the library default is marked, and the <strong>reset</strong> button puts one (or all of them) back. The footer says how many dials are changed. Fixed settings are shown as <em>(fixed)</em>. The unit beside a dial says what it is a multiple of: <em>× Ir</em>, or <em>× In</em> where the manufacturer fixes the setting against the trip rating (the instantaneous Ii of Schneider’s and ABB’s trip units) — that one stays at the same amps when you change Ir.',
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
  tips: ['Choose <em>None — free settings</em> to type any number. Breakers saved before trip units existed keep their settings until you choose one.', 'The library’s own values are the defaults, so a company or team library edit changes them.', 'A manufacturer’s breaker lists its own trip units (thermal-magnetic, electronic): pick one in <em>Trip unit</em>. The manufacturer filter above <em>Standard CB</em> narrows the list to one library. Manufacturer libraries include Schneider, ABB and CBI (QF miniature breakers, thermal-magnetic and electronic MCCBs, J- and L-frame): an adjustable dial that the manufacturer fixes against the trip rating (such as the F65DV’s instantaneous trip) does not move when you change Ir.'],
  related: [{ help: 'prot-tcc', label: 'Time-current curves & relay settings' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'retic-earth-fault', group: 'retic', title: 'Check earth-fault protection on a reticulation',
  where: 'Reticulation ▸ Demand ▸ Earth-fault check, and Diagram ▸ Show: Fault current', time: '10 min', phone: 'Plot with the table stacked under it; Diagram opens as cards',
  intro: 'After Demand has calculated, the earth-fault check plots each string’s breaker curve against the earth-fault current at every kiosk and erf and grades whether it clears in time. The topology diagram shows the same figures on the network itself.',
  steps: [
    { title: 'Give every string a breaker, then calculate',
      html: 'Pick a <strong>String breaker</strong> for each minisub string and run the Demand calculation. A string without a breaker shows <em>to complete</em> and is not graded. Open <strong>Earth-fault check</strong> to see the curves against the fault current.' },
    { title: 'Filter and read the plot',
      html: 'The <strong>Show</strong> filter limits the plot and the table to <em>All</em>, <em>Kiosks</em> or <em>Erven</em>. Hover (or tap and drag sideways on a touch screen) to read every curve at that current; click or press <strong>Pin</strong> to hold the cursor, and use the slider to move it. The nearest point and its table row are highlighted. The <strong>Min</strong> and <strong>Max</strong> arrows mark the lowest and highest fault current shown.',
      shot: { file: 'retic-earth-fault-1.png', alt: 'The earth-fault check: breaker curve against the fault current at every erf, with the Show filter, Min and Max arrows, cable I²t line and the table',
        setup: 'retic-ef', clip: '#retic-tcc-modal .modal-content',
        callouts: [
          { sel: '#retic-tcc-modal .rtcc-seg', label: 'Show: all, kiosks or erven' },
          { sel: '#retic-tcc-modal .rtcc-mms', label: 'Min and Max fault current shown' },
          { sel: '#retic-tcc-modal .rtcc-switch', label: 'Cable I²t: each cable’s withstand time' },
          { sel: '#retic-tcc-modal .rtcc-curbar', label: 'Cursor: slider and Pin' },
          { sel: '#retic-tcc-modal .rtcc-tablewrap', label: 'Fault current, clearing time and result per erf' },
        ] } },
    { title: 'Min / max band of a manufacturer breaker',
      html: 'A manufacturer’s breaker is drawn as its published band: shaded from the fastest to the slowest trip time, the fastest edge dashed. The solid line is the slowest edge, which is the clearing time each erf is graded on. Generic breakers and fuses stay a single line.' },
    { title: 'Check the cable withstand',
      html: 'Switch on <strong>Cable I²t</strong> to draw each cable’s adiabatic withstand time (the weakest of its phase, earth and PEN conductor). A ring marks a cable that is cleared after its own withstand time, and the <em>Cable I²t</em> column names it.' },
    { title: 'Print it',
      html: '<strong>Export PDF</strong> prints the plot as displayed (A4 landscape), with the view stated and the table.' },
    { title: 'See the same figures on the network',
      html: 'Open <strong>Diagram</strong> and switch <strong>Show</strong> from <em>Volt drop</em> to <em>Fault current</em>. Every minisub and kiosk box shows its earthing system, the maximum three-phase current and the minimum earth-fault current (L–PE on TN-S, L–PEN on TN-C / TN-C-S) with its clearing time. A kiosk also shows its lowest erf current. A red stripe means the kiosk or one of its erven does not clear in time. The toggles show three-phase, earth fault or both; PNG, SVG and DXF export the view you are looking at.',
      shot: { file: 'retic-earth-fault-2.png', alt: 'The topology diagram in its Fault current view, each box showing three-phase and earth-fault current',
        setup: 'retic-fault-diagram', clip: '#retic-diagram-modal .modal-content',
        callouts: [
          { sel: '#retic-diagram-modal .rdg-seg', label: 'Show: Volt drop or Fault current' },
          { sel: '#retic-diagram-modal .rdg-kinds', label: 'Which fault currents to show' },
          { sel: '#retic-diagram-canvas', label: 'Each minisub and kiosk: Ik3 max, earth-fault min and clearing time' },
        ] } },
  ],
  tips: ['The figures come from the last Demand calculation: run it again after changing a cable, transformer or breaker.', 'On a phone the diagram opens as a list of cards in network order, with a switch back to the diagram.'],
  related: [{ help: 'design-retic-vd', label: 'Reticulation volt drop & feeder legs' }, { help: 'design-admd', label: 'Reticulation demand (ADMD)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'cascading', group: 'protection', title: 'Use cascading (back-up protection)',
  where: 'Settings ▸ System Base ▸ Allow cascading, then Duty check', time: '5 min', phone: 'Same dialogs',
  intro: 'A low-voltage breaker whose own breaking capacity is below the fault level can still be acceptable when a tested breaker above it backs it up. The manufacturer’s tables give the reinforced breaking capacity of the pair, and the duty and compliance checks use it.',
  steps: [
    { title: 'Leave cascading on (or turn it off)',
      html: 'In <strong>Settings ▸ System Base</strong>, <strong>Allow cascading (back-up protection)</strong> is on by default and is saved with the project. Turn it off when a specification requires every breaker to be rated for its own fault level.',
      shot: { file: 'cascading-1.png', alt: 'Settings, System Base tab, with Allow cascading ticked',
        setup: 'settings-cascading', clip: 'viewport',
        callouts: [
          { sel: '#allow-cascading', label: 'Allow cascading (back-up protection)' },
        ] } },
    { title: 'Pick library breakers',
      html: 'Cascading is looked up from the manufacturer’s tables, so the downstream and upstream breakers must be library breakers of the same manufacturer and type as the tested pair. Pick them in <strong>Standard CB</strong>.' },
    { title: 'Run the duty check',
      html: 'In <strong>Duty check</strong> a breaker that fails on its own capacity is re-checked against the reinforced capacity of the pair above it. A passing result is marked <em>(cascaded)</em> on the device row, in the table and in the PDF. The upstream breaker must itself be adequate, either on its own capacity or cascaded in turn.' },
    { title: 'See it on the board schedule',
      html: 'The <strong>Coord</strong> column of a board’s schedule uses the same rule for the breaking-capacity part of its check.' },
  ],
  tips: ['The walk up the diagram stops at a transformer, and gives no credit when the board has a second infeed.', 'Cascaded breakers are not selective at those fault currents: a fault on one circuit can trip the incomer.'],
  related: [{ help: 'prot-cascading', label: 'Cascading (back-up protection)' }] },

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
    { title: 'Import entries from a file',
      html: 'Under <strong>Import / export</strong>, <strong>Import JSON…</strong> reads a file of entries (a manufacturer breaker library, or a company library export) and asks where to put them: <em>My library</em>, or a shared library you can edit. Entries whose id already exists are skipped; tick <strong>Replace entries that already exist</strong> to overwrite them instead. A shared library entry that someone changed meanwhile is reported, not overwritten.',
      shot: { file: 'libraries-5.png', alt: 'The import dialog: where to add the entries and the Replace option',
        setup: 'lib-import', clip: 'viewport',
        callouts: [
          { sel: '[data-f="dest"]', label: 'Where the entries go' },
          { sel: '[data-f="replace"]', label: 'Replace entries that already exist' },
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

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-powerflow', group: 'analyses', title: 'Power flow studies: choosing and reading them',
  where: 'Analyse ▸ Power flow', time: '10 min', phone: 'Results are readable on a phone',
  intro: 'Load flow has several variants for different questions. All of them solve the same network model, so the same inputs serve each; what changes is what is varied and what is reported.',
  steps: [
    { title: 'Unbalanced load flow: when the phases are not equal',
      html: 'Use <strong>Unbalanced Load Flow</strong> when single-phase loads or a phase split make the phases differ. Each bus box shows the three phase voltages with their angles, the positive, negative and zero-sequence voltages, and the voltage unbalance factor (VUF) to compare with your limit.',
      shot: { file: 'study-powerflow-1.png', alt: 'Unbalanced load flow boxes with phase voltages and VUF',
        setup: 'x-unbal', clip: '#sld-canvas',
        callouts: [
          { sel: '.annotation-badge', label: 'Phase voltages, sequence voltages and VUF at a bus', all: false },
        ] } },
    { title: 'Time-series: what happens over a day',
      html: '<strong>Time-Series Load Flow</strong> re-solves the network at each step of a day or a year. Choose the horizon and step, the default profile and the voltage and loading limits, and assign a profile to a load or source in the table (otherwise a typical shape for its type is used). A battery’s state of charge and a transformer’s tap carry on from step to step.',
      shot: { file: 'study-powerflow-2.png', alt: 'The time-series setup with horizon, step, limits and profile assignment',
        setup: 'x-ts-config', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] select', label: 'Horizon and step size', all: false },
          { sel: '[data-hg-cap] table', label: 'Profile for each load and source' },
        ] } },
    { title: 'Read the time-series result',
      html: 'The summary says how many steps broke a limit, the total losses over the horizon, the voltage range and the peak branch loading and where. Charts show the voltage envelope and the peak loading against their limits for every step, and batteries get a state-of-charge trace.',
      shot: { file: 'study-powerflow-3.png', alt: 'Time-series results with the voltage envelope and branch loading charts',
        setup: 'x-ts-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] .modal-content > div > div:first-child, [data-hg-cap] .modal-body > div:first-child', label: 'Steps in violation, losses, voltage range and peak loading' },
        ] } },
    { title: 'Compare named cases',
      html: 'The <strong>Load Flow Study Manager</strong> keeps full snapshots of the network as named cases. <strong>+ New from current</strong> copies the live network into a case you can edit in the tables (loads, sources, taps, impedances), and <strong>Run all cases</strong> solves them together so you can compare voltages, losses and overloads side by side.',
      shot: { file: 'study-powerflow-4.png', alt: 'The Load Flow Study Manager with the current network and the editable tables',
        setup: 'x-lfs-config', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] button', text: 'New from current', label: 'Make a case from the live network' },
          { sel: '[data-hg-cap] button', text: 'Run all cases', label: 'Solve every case' },
        ] } },
    { title: 'Optimal power flow: suggested control moves',
      html: '<strong>Optimal Power Flow</strong> looks for cheaper dispatch and better voltages. It reports the saving, the change in losses and violations, a list of recommended moves (a tap change, a source setpoint) and the optimised dispatch of each source. The moves are advice: adopt the ones you want on the diagram.',
      shot: { file: 'study-powerflow-5.png', alt: 'Optimal power flow with savings, recommended moves and dispatch',
        setup: 'x-opf-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', text: 'Tap (%)', label: 'Recommended control moves', all: false },
        ] } },
    { title: 'DC load flow',
      html: '<strong>DC Load Flow</strong> solves DC buses fed from a rectifier or battery: the voltage at each bus against nominal, the source loading and the current, volt drop and loss in each cable. A bus more than a few percent below nominal is flagged.',
      shot: { file: 'study-powerflow-6.png', alt: 'DC load flow bus voltages, sources and cable flows',
        setup: 'x-dclf-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Bus voltage against nominal, sources and cables', all: false },
        ] } },
  ],
  tips: ['Run the plain Load Flow first. If it will not converge, the other variants will not either.', 'A flat profile in the time-series reproduces the plain load flow at every step.'],
  related: [{ help: 'study-loadflow', label: 'Run a load flow study' }, { help: 'flow-unbalanced', label: 'Unbalanced load flow (the method)' }, { help: 'flow-timeseries', label: 'Time-series load flow (the method)' }, { help: 'flow-opf', label: 'Optimal power flow (the method)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-shortcircuit-variants', group: 'analyses', title: 'Short-circuit variants: ANSI duty, open conductor, simultaneous and DC',
  where: 'Analyse ▸ Short circuit', time: '10 min', phone: 'Results are readable on a phone',
  intro: 'Besides the standard three-phase and unsymmetrical faults, the Short circuit group covers breaker duty to the ANSI method, series faults (a conductor that opens), a series and a shunt fault together, and DC networks.',
  steps: [
    { title: 'Breaker duty to ANSI C37.010',
      html: '<strong>Fault Duty (ANSI C37.010)</strong> works out the momentary, interrupting and closing-and-latching duty at each bus, and compares each breaker’s rating with it. Each breaker shows its interrupting duty against its capacity, the multiplying factor, and a Pass or Fail, for the closing and latching duty as well. Low-voltage breakers use the first-cycle duty.',
      shot: { file: 'study-shortcircuit-variants-1.png', alt: 'ANSI breaker duty with passing and failing breakers',
        setup: 'x-ansi-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', text: 'Closing', label: 'Each breaker: duty against capacity, with Pass or Fail', all: false },
        ] } },
    { title: 'A conductor that opens',
      html: 'Select one cable (both its ends on a bus) and run <strong>Open Conductor (Single-Phasing)</strong>. The result gives the sequence currents at the break, the current in the healthy phases and the voltage on the load side. The negative-sequence current as a percentage of positive is what overheats a motor on single-phasing, so it is highlighted. <strong>Two Conductor Open</strong> does the same with two conductors open.',
      shot: { file: 'study-shortcircuit-variants-2.png', alt: 'Open conductor analysis with sequence currents and downstream voltages',
        setup: 'x-openc-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] tr', text: 'Negative-sequence', label: 'Negative-sequence current, as a percentage of positive' },
        ] } },
    { title: 'A series and a shunt fault together',
      html: 'Select one cable and one bus, then run <strong>Simultaneous Series + Shunt Fault</strong>, with the series type (the open conductors) and shunt type (the fault) chosen in the menu. The result lists the currents at the break and at the fault, and the coupling impedances between them. Use it for a broken conductor that also touches earth.',
      shot: { file: 'study-shortcircuit-variants-3.png', alt: 'Simultaneous series and shunt fault results',
        setup: 'x-simul-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] h4, [data-hg-cap] strong', text: 'Shunt Fault', label: 'Currents at the fault', all: false },
        ] } },
    { title: 'DC short circuit',
      html: '<strong>DC Short Circuit (IEC 61660)</strong> works on the DC buses fed by batteries, rectifiers and chargers. It gives the short-circuit current, the peak, and the time to peak at each bus, and each source’s contribution with its branch resistance.',
      shot: { file: 'study-shortcircuit-variants-4.png', alt: 'DC short circuit currents by bus and source',
        setup: 'x-dcsc-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Ik, ip and time to peak at each DC bus', all: false },
        ] } },
  ],
  tips: ['Series-fault studies need a cable with a bus directly at each end; if a breaker sits between, the study says so.', 'The AC three-phase study is the starting point for all of these.'],
  related: [{ help: 'study-fault', label: 'Run a short-circuit study' }, { help: 'fault-series', label: 'Open-conductor & simultaneous faults' }, { help: 'fault-ansi', label: 'ANSI/IEEE breaker duty' }, { help: 'fault-dc', label: 'DC short circuit & DC load flow' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-stability', group: 'analyses', title: 'Stability and dynamics studies',
  where: 'Analyse ▸ Stability & dynamics', time: '10 min', phone: 'Use a wider screen for the charts',
  intro: 'These studies follow the network through time or through a loading sweep, and answer whether it will hold: will the motors start, will the generators stay in step after a fault, how far can the load grow.',
  steps: [
    { title: 'Dynamic motor starting',
      html: '<strong>Dynamic Motor Starting</strong> simulates every motor accelerating on one shared timeline, so each start sags the voltage the others see. Choose the order and times of the starts in the setup. The result gives, for each motor, the time to full speed, the final speed, the peak current, the lowest bus voltage and the rotor’s thermal use, with the bus voltage and speed against time.',
      shot: { file: 'study-stability-1.png', alt: 'Dynamic motor starting with the shared timeline and per-motor results',
        setup: 'x-dynmot-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] svg', label: 'Bus voltage on the shared start sequence', all: false },
        ] } },
    { title: 'Transient stability',
      html: '<strong>Transient Stability</strong> applies a fault, clears it after a time you choose, and follows the rotor angles and frequencies of every generator. Choose the fault bus and type, the clearing time and the simulation length. A verdict at the top says STABLE or the machines that lose synchronism, and the charts show rotor angle and frequency deviation against time.',
      shot: { file: 'study-stability-2.png', alt: 'Transient stability verdict with rotor angle and frequency charts',
        setup: 'x-trans-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] div', text: 'STABLE', label: 'Verdict for the fault and clearing time', all: false },
        ] } },
    { title: 'Voltage stability',
      html: '<strong>Voltage Stability (P-V / Q-V)</strong> scales all the load up until the network collapses. It reports the loadability margin (how much more load the network can take), the critical bus and its voltage, the P-V curve of every bus against total demand, and the reactive margin at the weakest bus from the Q-V curve.',
      shot: { file: 'study-stability-3.png', alt: 'P-V nose curves and the loadability margin',
        setup: 'x-vstab-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] svg', label: 'P-V curve of each bus; the red line is the collapse point', all: false },
        ] } },
    { title: 'Control circuit simulation',
      html: 'Place a <strong>Control Supply</strong>, breakers, pushbuttons, contacts, coils and lamps from the Control group and wire them. A contact follows the coil that has the same tag. <strong>Control Simulation</strong> then lets you operate it: hold a pushbutton or click a switch and the energised path lights up, so you can prove a start-stop or seal-in circuit before it is built. <kbd>Esc</kbd> leaves the simulation.',
      shot: { file: 'study-stability-4.png', alt: 'A control circuit being simulated with the energised path highlighted',
        setup: 'x-control', clip: '#sld-canvas',
        callouts: [
          { sel: '.sld-component[data-id^="ctl_"]', label: 'The control circuit; the energised path is highlighted as you operate it', all: true },
        ] } },
  ],
  tips: ['A motor with a deep dip that does not accelerate shows as stalled; try a softer starter and run it again.', 'For a single motor and the dip on the network only, use Motor Starting.'],
  related: [{ help: 'dyn-motor-dynamic', label: 'Dynamic motor starting' }, { help: 'dyn-transient', label: 'Transient stability' }, { help: 'flow-vstab', label: 'Voltage stability (P-V & Q-V)' }, { help: 'wf-control', label: 'Control-circuit simulation' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-powerquality', group: 'analyses', title: 'Power quality: harmonics, resonance, filters and flicker',
  where: 'Analyse ▸ Power quality', time: '10 min', phone: 'Results are readable on a phone',
  intro: 'These four studies belong together: find the harmonic distortion, find where the network resonates, size a filter to fix it, and check that repeated motor starts do not make the lights flicker.',
  steps: [
    { title: 'Harmonics: is distortion within limits',
      html: 'Give each nonlinear load (a variable-speed drive, rectifier or similar) its harmonic spectrum, then run <strong>Harmonics</strong>. Choose the limit basis: IEEE 519 (voltage at each bus and current at the point of common coupling) or IEC 61000. The result gives the worst bus THD, the current distortion at the PCC against its limit, the voltage distortion at each bus, and the harmonic sources used.',
      shot: { file: 'study-powerquality-1.png', alt: 'Harmonic analysis with PCC current distortion and bus voltage distortion',
        setup: 'x-harm-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'THDv and individual limits at each bus', all: false },
        ] } },
    { title: 'Frequency scan: where does it resonate',
      html: '<strong>Frequency Scan</strong> sweeps the impedance seen at each bus against frequency. A peak is a parallel resonance, which amplifies harmonics near that frequency; a dip is a series resonance, which sinks them. The table lists each resonance with its order, frequency, impedance and prominence, and a warning says when impedance is still rising at the highest order scanned.',
      shot: { file: 'study-powerquality-2.png', alt: 'Impedance against frequency with a parallel resonance marked',
        setup: 'x-fscan-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] svg', label: 'Driving-point impedance against frequency', all: false },
          { sel: '[data-hg-cap] table', label: 'Each resonance: order, frequency, impedance', all: false },
        ] } },
    { title: 'Filter sizing',
      html: '<strong>Filter Sizing</strong> designs a single-tuned passive filter for the harmonics that need removing. It gives the size in kvar, the order it is tuned to, and the capacitor, reactor and resistor values, checks the capacitor duty against its limits, and shows the voltage THD before and after at each bus. The filter is advice: add it to the diagram as a capacitor bank with the listed kvar.',
      shot: { file: 'study-powerquality-3.png', alt: 'A designed filter with capacitor duty and before and after THD',
        setup: 'x-filt-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'The filter branch and its component values', all: false },
        ] } },
    { title: 'Flicker from repeated starts',
      html: 'Flicker needs to know how often a motor starts. Enter <strong>Starts per hour</strong> on each motor that starts repeatedly (a compressor or a pump); a motor that starts once and runs is left out. <strong>Voltage Flicker</strong> then estimates the voltage change and the short-term and long-term severity (Pst and Plt) from each start, against the limits, and says Pass or Fail for each motor. It is a planning estimate, not a flickermeter reading.',
      shot: { file: 'study-powerquality-4.png', alt: 'Flicker severity for a compressor with its limits',
        setup: 'x-flk-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Voltage change, Pst and Plt against their limits', all: false },
        ] } },
  ],
  tips: ['Run the frequency scan before sizing a filter: tuning a filter close to a parallel resonance makes things worse.', 'A study that cannot run explains what is missing, for example no harmonic sources or no motor with a start rate.'],
  related: [{ help: 'dyn-harmonics', label: 'Harmonic analysis' }, { help: 'dyn-freqscan', label: 'Frequency scan (resonance)' }, { help: 'dyn-filter', label: 'Passive filter sizing' }, { help: 'dyn-flicker', label: 'Voltage flicker (Pst / Plt)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-planning', group: 'analyses', title: 'Planning and reliability studies',
  where: 'Analyse ▸ Planning & reliability', time: '10 min', phone: 'Results are readable on a phone',
  intro: 'These studies ask forward-looking questions: what if an element fails, how much generation can a bus host, where should capacitors go, and how reliable is supply to each customer.',
  steps: [
    { title: 'Contingency: what if one element fails',
      html: '<strong>Contingency (N-1 / N-2)</strong> removes each branch or source in turn (and, if you choose, each pair), re-solves the load flow and flags overloads, voltage excursions and loss of supply. In the setup choose the depth and the voltage and loading limits. The result ranks the worst first: a loss of supply, then violations, then secure outages. Click a row to see the detail.',
      shot: { file: 'study-planning-1.png', alt: 'N-1 contingency results ranked by severity',
        setup: 'x-cont-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Each outage with its status, loading and lost load', all: false },
        ] } },
    { title: 'Hosting capacity: how much generation fits',
      html: '<strong>Hosting Capacity (DER)</strong> adds generation at each bus in turn until a limit is reached. For each bus it gives the capacity in MW, what limited it (voltage rise or a thermal overload) and where, whether the fault level stays within equipment ratings, and the generation’s share of the fault current. A value marked with a plus sign reached the search limit without a violation, so it is a lower bound.',
      shot: { file: 'study-planning-2.png', alt: 'Hosting capacity at each bus with the limiting factor',
        setup: 'x-hc-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Hosting capacity, limit and fault screen for each bus', all: false },
        ] } },
    { title: 'Capacitor placement',
      html: '<strong>Capacitor Placement</strong> chooses where to add capacitor banks to cut losses and fix voltage within a budget you set. The result gives the total kvar recommended, the loss and violation change, the yearly energy saved and its value, and a list of placements with the voltage at each bus before and after. Add each as a capacitor bank on the diagram.',
      shot: { file: 'study-planning-3.png', alt: 'Recommended capacitor placements with before and after voltages',
        setup: 'x-cpl-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Where to place how many kvar', all: false },
        ] } },
    { title: 'Reliability: SAIFI, SAIDI and friends',
      html: '<strong>Reliability (SAIDI/SAIFI)</strong> works out the interruption indices from failure rates and repair times of each element, over the paths that supply each load. The tiles give SAIFI, SAIDI, CAIDI, availability, MAIFI and the energy not supplied. Below them the load points show how often and for how long each is interrupted, and the failure modes are ranked by their contribution. Set the failure rate and repair time on an element to override the defaults.',
      shot: { file: 'study-planning-4.png', alt: 'Reliability indices, load points and failure modes',
        setup: 'x-rel-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] .modal-content > div > div:first-child', label: 'SAIFI, SAIDI, CAIDI, availability and energy not supplied', all: false },
        ] } },
  ],
  tips: ['A radial network always loses supply when its only source fails; the contingency study flags that correctly, and it tells you what to look at in the reliability study.'],
  related: [{ help: 'flow-contingency', label: 'Contingency analysis (N-1 / N-2)' }, { help: 'flow-hosting', label: 'Hosting capacity (DER)' }, { help: 'flow-capplace', label: 'Optimal capacitor placement' }, { help: 'flow-reliability', label: 'Reliability (SAIDI / SAIFI)' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-sizing', group: 'analyses', title: 'Sizing and installation studies',
  where: 'Analyse ▸ Sizing & installation', time: '10 min', phone: 'Results are readable on a phone',
  intro: 'Four studies that size or check what you install: a battery for its duty, how long the backup lasts, the diversity of the load, and cables grouped in conduit.',
  steps: [
    { title: 'Battery sizing',
      html: 'Pick the battery and describe the duty cycle as steps of power against time in the setup. <strong>Battery Sizing &amp; Discharge</strong> then gives the energy and amp-hours the duty needs after the efficiency, depth of discharge, ageing and design margin factors, compares it with what is installed, and simulates the discharge with the state of charge and terminal voltage against time.',
      shot: { file: 'study-sizing-1.png', alt: 'Battery sizing verdict with the state of charge over the duty cycle',
        setup: 'x-bsz-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] svg', label: 'State of charge over the duty cycle', all: false },
        ] } },
    { title: 'Backup autonomy',
      html: '<strong>Backup Autonomy</strong> finds the islands that remain if the utility is lost, the essential load on each, and how long the battery (or hybrid PV) can carry it, by night and with PV. It flags an inverter too small for the load and a discharge limit below the demand, with the numbers.',
      shot: { file: 'study-sizing-2.png', alt: 'Backup autonomy for an island with a battery too small for the load',
        setup: 'x-backup-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Load, inverter and discharge limits, and the autonomy', all: false },
        ] } },
    { title: 'Load diversity',
      html: '<strong>Load Diversity</strong> rolls demand up from the loads to each board, applying each load’s demand factor and the rated diversity factor Ks to a low-voltage board, so the maximum demand is not just the sum of the installed loads. The result gives the overall demand factor, the installed and maximum demand, and the effective factor for each board.',
      shot: { file: 'study-sizing-3.png', alt: 'Load diversity with demand factor and coincidence factors',
        setup: 'x-div-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Installed, diversified and maximum demand by board', all: false },
        ] } },
    { title: 'Raceway and conduit fill',
      html: '<strong>Raceway / Conduit Fill</strong> groups the project’s cables into conduits. <strong>+ Add Raceway</strong> makes one, you assign cables to it, and <strong>Analyse</strong> checks the fill against the limit for the number of cables and the ampacity derating for grouping.',
      shot: { file: 'study-sizing-4.png', alt: 'The raceway window ready to add a conduit',
        setup: 'x-race-config', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '#btn-add-raceway', label: 'Add a conduit or tray' },
          { sel: '#btn-run-raceway', label: 'Check fill and derating' },
        ] } },
  ],
  tips: ['Battery sizing needs a BESS or hybrid-PV component on the diagram; the study says so when there is none.'],
  related: [{ help: 'dyn-battery', label: 'Battery sizing & discharge' }, { help: 'dyn-backup', label: 'Backup adequacy & autonomy' }, { help: 'cable-diversity', label: 'Load diversity & demand factors' }, { help: 'cable-raceway', label: 'Conduit fill & grouping derating' }] },

// ───────────────────────────────────────────────────────────────────────────
{ id: 'study-reports', group: 'analyses', title: 'Sequence of operation, compliance and soil resistivity',
  where: 'Analyse ▸ Protection & safety, Earthing & lightning', time: '8 min', phone: 'Results are readable on a phone',
  intro: 'Three tools that finish a design: prove the protection clears each fault in order, check the network against the standard, and turn field soil readings into a resistivity for the grid.',
  steps: [
    { title: 'Sequence of operation',
      html: 'Run a short-circuit study first. <strong>Sequence of Operation</strong> then asks for the fault type and breaker clearing time, and for each bus shows which device clears the fault and how long it takes, in order from the primary to the backup, with each trip time and what happens to the others. A green verdict means every fault is cleared selectively by the device closest to it.',
      shot: { file: 'study-reports-1.png', alt: 'Sequence of operation for a fault at the MCC with the clearing device and backup',
        setup: 'x-seq-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] table', label: 'Primary, then backup: trip time, clearing time and status', all: false },
        ] } },
    { title: 'Compliance report',
      html: '<strong>Compliance Report</strong> checks the network against the standards in groups: network validity, fault duty, voltage, thermal loading, cable short-circuit withstand and protection device ratings. Run the fault and load flow studies first, or the groups that need them say so. Each line is a pass, warning or fail with the component and the reason, and <strong>Download PDF</strong> makes it into a document.',
      shot: { file: 'study-reports-2.png', alt: 'The compliance report with groups of checks',
        setup: 'x-compl-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '[data-hg-cap] button', text: 'Download PDF', label: 'Export the report as a PDF' },
        ] } },
    { title: 'Soil resistivity from a Wenner test',
      html: 'Enter the probe spacings and the apparent resistivity you measured in the field (at least three, typically doubling spacing), then <strong>Interpret</strong>. It fits a two-layer soil model and gives the upper and lower layer resistivities and the upper layer’s thickness, with how well the model fits each reading. Select a bus first and <strong>Apply to Selected Bus</strong> writes the soil values into its grounding fields.',
      shot: { file: 'study-reports-3.png', alt: 'Wenner four-pin test readings and the interpretation',
        setup: 'x-wenner-results', clip: '[data-hg-cap] .modal-content',
        callouts: [
          { sel: '#btn-wenner-run', label: 'Fit the two-layer soil model' },
        ] } },
  ],
  tips: ['The compliance report is a screening: it points to what to look at, not a certificate.'],
  related: [{ help: 'prot-sequence', label: 'Sequence of operation' }, { help: 'prot-compliance', label: 'Compliance report' }, { help: 'prot-grounding', label: 'Substation grounding (IEEE 80)' }] },

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

// A guide as the plain-text shape the article search scores (title, keywords,
// standard line, headings, body), so one scorer ranks articles and guides alike.
HelpGuides.docs = function () {
  if (this._docs) return this._docs;
  const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  this._docs = HELP_GUIDES.map(g => {
    const grp = (HELP_GUIDE_GROUPS.find(x => x.id === g.group) || {}).title || '';
    const rel = (g.related || []).map(r => r.label).join(' ');
    return {
      id: 'guide:' + g.id, guideId: g.id, title: g.title, group: 'guides',
      kw: `guide how to steps ${grp} ${rel}`,
      std: g.where,
      html: `<p>${g.intro}</p>` + g.steps.map(s => `<h4>${s.title}</h4><p>${s.html}</p>`).join('')
        + (g.tips || []).map(t => `<p>${t}</p>`).join(''),
      _plain: strip(g.title + ' ' + g.where + ' ' + g.intro + ' ' + g.steps.map(s => s.title).join(' ')),
      _where: grp,
    };
  });
  return this._docs;
};

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
  { host: '#plan-toolbar', guide: () => (typeof PlanMarkup === 'undefined' ? 'plan-select' : PlanMarkup.mode === 'underlays' ? 'plan-dxf' : (typeof PlanTools !== 'undefined' && PlanTools.active && /^(place|array|devpath)$/.test(PlanTools.active.id)) ? 'plan-place' : 'plan-select') },
  { after: 'button[data-action="diagram"]', guide: 'demand-plan' },
  { host: '.sl-toolbar', guide: () => (typeof StreetLight !== 'undefined' && StreetLight._view === 'design' ? 'road-lighting' : 'street-light') },
  { host: '.tu-head', guide: 'trip-unit' },
  { after: '#lr-tag-scope', guide: 'lightning' },
  { after: '#btn-eg-save', guide: 'earth-grid' },
  { before: '#lib-sub', guide: 'libraries' },
  { host: '#cable-focus-bar', guide: 'cable-focus' },
  { host: '.cmd-search-input-row', guide: 'find-anything' },
  { after: '.ws-dialog-note', guide: 'project-types' },
  { after: '#project-quoted-chip', guide: 'quoted', when: () => typeof Quote !== 'undefined' && Quote.isQuoted() },
  { before: '#tcc-modal .tcc-header-actions', guide: 'tcc-read' },
  { before: '#retic-tcc-modal .modal-close', guide: 'retic-earth-fault' },
  { before: '#retic-diagram-modal .modal-close', guide: 'retic-earth-fault', when: () => typeof ReticDiagram !== 'undefined' },
  { before: '#arcflash-modal .modal-close', guide: 'study-arcflash' },
  { before: '#cable-sizing-modal .modal-close', guide: 'study-cable' },
  { before: '#motor-starting-modal .modal-close', guide: 'study-motor' },
  { before: '#duty-check-modal .modal-close', guide: 'study-duty' },
  { before: '#grounding-modal .modal-close', guide: 'study-grounding' },
  { before: '#tsl-config-modal .modal-close', guide: 'study-powerflow' },
  { before: '#lf-study-modal .modal-close', guide: 'study-powerflow' },
  { before: '#opf-config-modal .modal-close', guide: 'study-powerflow' },
  { before: '#dc-loadflow-modal .modal-close', guide: 'study-powerflow' },
  { before: '#fault-ansi-modal .modal-close', guide: 'study-shortcircuit-variants' },
  { before: '#dc-shortcircuit-modal .modal-close', guide: 'study-shortcircuit-variants' },
  { before: '#dynamic-motor-config-modal .modal-close', guide: 'study-stability' },
  { before: '#stability-config-modal .modal-close', guide: 'study-stability' },
  { before: '#vstab-config-modal .modal-close', guide: 'study-stability' },
  { before: '#harmonics-modal .modal-close', guide: 'study-powerquality' },
  { before: '#fscan-config-modal .modal-close', guide: 'study-powerquality' },
  { before: '#flt-config-modal .modal-close', guide: 'study-powerquality' },
  { before: '#flk-config-modal .modal-close', guide: 'study-powerquality' },
  { before: '#contingency-config-modal .modal-close', guide: 'study-planning' },
  { before: '#hc-config-modal .modal-close', guide: 'study-planning' },
  { before: '#cpl-config-modal .modal-close', guide: 'study-planning' },
  { before: '#rel-modal .modal-close', guide: 'study-planning' },
  { before: '#bsz-config-modal .modal-close', guide: 'study-sizing' },
  { before: '#load-diversity-modal .modal-close', guide: 'study-sizing' },
  { before: '#raceway-modal .modal-close', guide: 'study-sizing' },
  { before: '#sequence-config-modal .modal-close', guide: 'study-reports' },
  { before: '#compliance-modal .modal-close', guide: 'study-reports' },
  { before: '#wenner-modal .modal-close', guide: 'study-reports' },
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
