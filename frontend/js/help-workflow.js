/* Help articles — studies, scenarios & logic. Rendered by help.js; TeX between $…$ / $$…$$. */
HELP_ARTICLES.push(

{ id: 'wf-studies', group: 'workflow', title: 'Run All Studies, scenarios & load-flow cases',
  std: 'Analyse ▸ Run All Studies · Scenarios · Load Flow Study Manager',
  kw: 'study manager batch scenario compare case snapshot lf study attribute grid what if',
  html: String.raw`
<h4>Run All Studies</h4>
<p>Batch-runs the enabled analyses (fault, load flow, arc flash, cable sizing, motor starting, duty check) in one call and returns a consolidated report with per-study results, timing and a summary — useful as a full design check after a change. Results appear as annotation badges on the diagram; the <em>Results</em> menu lists only studies that have results.</p>
<h4>Scenarios</h4>
<p>A scenario is a named snapshot of the network configuration (which breakers are open, which sources are in service, load levels). <em>Scenarios ▸ Manage</em> saves and restores them; <em>Compare Scenarios</em> produces a side-by-side report so normal, emergency, summer/winter and future-expansion cases can be judged together.</p>
<h4>Load Flow Study Manager</h4>
<p>Where a scenario is a switching state, a <em>case</em> is a full self-contained network snapshot. The manager lets you:</p>
<ol>
<li>define several named cases and edit, in a grid, the attributes that drive load flow (loads, generation, taps, set-points) in each;</li>
<li>run the load flow for every case at once (the live network is an implicit "Current network" case);</li>
<li>compare bus voltages, losses and overloads side by side, and apply a chosen case back onto the live diagram.</li>
</ol>
<p>The comparison metrics are those of <a href="#" data-help="flow-loadflow">Load flow</a>: bus voltage $|V|$, total loss $\sum P_{loss}$, and loading. Cases are saved with the project; results are transient. The Load Flow Study Manager is distinct from Run All Studies.</p>
<h4>Python client</h4>
<p>For batch and parametric work, <code>clients/python</code> wraps the same API (<code>protectionpro_client.py</code>) so a script can vary a parameter and collect any study's results.</p>` },

{ id: 'wf-changeover', group: 'workflow', title: 'Changeover switches & voltage zones',
  std: 'Distribution ▸ Changeover · automatic voltage propagation',
  kw: 'changeover ats transfer switch in_1 in_2 off co_type interlocked breaker pair voltage zone propagation transformer',
  html: String.raw`
<h4>Changeover switch</h4>
<p>A three-port device (<code>in_1</code>, <code>in_2</code>, <code>out</code>) whose <em>state</em> is <code>in_1</code>, <code>off</code> or <code>in_2</code>, and whose type is manual I–0–II, manual I–II, ATS, or an interlocked breaker pair. No analysis engine knows a three-port switch. Before any study runs, the changeover is <em>rewritten</em> into things the engines already understand:</p>
$$\text{changeover}\ \longrightarrow\ \text{2-terminal switch (a CB for a breaker pair) from the selected input to }out\ +\ \text{an open stub on the other input}$$
<p>so load flow, fault, arc flash, reliability and every other study see a normal switching device and a normal open branch. The diagram's own walkers use the same semantics: the wire on the unselected input is ignored, and the device is treated as open when off.</p>
<h4>Voltage zones</h4>
<p>A <em>voltage zone</em> is the set of components at one voltage, bounded by transformers. When components are wired together or a bus voltage changes, the nominal voltage is propagated through the zone (each component type has the property that carries it), and a transformer sets the voltage on its two sides from its HV/LV ratings. The engines take each cable's per-unit base from its zone's bus voltage, so a stale default on a cable cannot mis-scale its impedance.</p>
<h4>Off-page connectors and pages</h4>
<p>Connectors with the same label on different diagram pages are electrically joined; the network the engines see is the union of every page.</p>` },

{ id: 'wf-interlock', group: 'workflow', title: 'Interlocking logic',
  std: 'Interlock workspace',
  kw: 'interlock interlocking boolean gate and or not nand nor xor breaker key permissive conflict check truth table',
  html: String.raw`
<p>A workspace for expressing breaker interlocking rules as a boolean-gate diagram and proving them.</p>
<h4>Elements</h4>
<ul>
<li><strong>Inputs</strong> — a real circuit breaker's live position ($\text{closed}=\text{TRUE}$), or a manually defined signal (key switch, maintenance, SCADA).</li>
<li><strong>Gates</strong> — AND, OR, NOT, NAND, NOR, XOR.</li>
<li><strong>Outputs</strong> — block/allow-close permissive, trip command, alarm/indication, or an <em>interlock-violation</em> flag (a state that must never occur).</li>
</ul>
<p>The diagram is a directed acyclic graph, evaluated by a memoised depth-first walk with cycle detection.</p>
<h4>Three ways to simulate</h4>
<ol>
<li><strong>Interactive</strong> — toggle inputs and watch gates, wires and outputs update.</li>
<li><strong>Conflict check</strong> — sweeps every one of the $2^{n}$ input combinations and reports any that raises a violation flag. For $n$ inputs that is exhaustive, so a clean result <em>proves</em> the rule (for example, that two sources can never be paralleled).</li>
<li><strong>From live SLD</strong> — reads the breakers' present positions and evaluates the logic against the current network configuration.</li>
</ol>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>Two incomers $Q_1,Q_2$ and a bus-tie $Q_3$ must never all be closed at once. The violation flag is $Q_1\wedge Q_2\wedge Q_3$. The conflict check runs all $2^3=8$ combinations and reports exactly one — $(1,1,1)$ — confirming the rule flags only the forbidden state and no other.</p></div>
<p>Nothing here changes the single-line diagram; "From live SLD" only reads breaker states. The logic diagram is saved with the project.</p>` },

{ id: 'wf-control', group: 'workflow', title: 'Control-circuit simulation',
  std: 'IEC 60617 control schematic · Analyse ▸ Stability & dynamics ▸ control simulation',
  kw: 'control circuit schematic pushbutton coil contact relay timer seal-in lamp simulate ladder',
  html: String.raw`
<p>Operates a control schematic live: click pushbuttons and selector switches and watch coils, contacts and lamps respond. Esc exits.</p>
<h4>Model</h4>
<p>Every control device is a two-terminal series element. A load (coil, lamp) is <strong>energised iff its two terminals reach the L and N terminals of the same control supply</strong> through wires and <em>closed</em> contacts:</p>
$$\text{energised}(x)\iff \exists\ \text{path}\ L\rightsquigarrow x\rightsquigarrow N\ \text{through closed contacts}$$
<p>Contacts bind to coils by tag: a normally-open contact tagged <code>K1</code> closes while coil <code>K1</code> is energised (a normally-closed contact opens). The circuit is then re-evaluated <strong>to a fixed point</strong>, which is what resolves seal-in circuits: the start button energises K1, K1's contact closes across the button, and the state persists after the button is released.</p>
<p>A circuit that never settles — a relay wired through its own normally-closed contact — is flagged as oscillating and frozen at its last state. Timer coils (on-delay, off-delay) advance on a 200 ms tick. Momentary pushbuttons stay pressed only while held.</p>
<p>The simulation is fully transient: maintained-switch positions are restored when it stops and nothing is written to the project.</p>` },

{ id: 'wf-files', group: 'workflow', title: 'Saving, revisions & sharing',
  std: 'Project menu · Revision timeline · Share',
  kw: 'save autosave revision timeline snapshot undo redo share collaborate export json project file',
  html: String.raw`
<ul>
<li><strong>Save and auto-save</strong> — <kbd>Ctrl+S</kbd> saves to the server; Auto Save writes every 2 minutes.</li>
<li><strong>Undo / redo</strong> — snapshot based (not diffs), up to 50 states.</li>
<li><strong>Revision timeline</strong> — keeps up to 20 project snapshots in a strip above the status bar. Saved projects store revisions on the server; unsaved projects keep them in the browser, namespaced per project so one project's revisions can never appear in another's. Select a revision to preview it.</li>
<li><strong>Sharing</strong> — the owner grants view or edit access to another user by email.</li>
<li><strong>Export</strong> — project JSON (re-importable), diagram as SVG / PNG / PDF, results CSV, settings schedule CSV, analysis report PDF, detailed-calculations PDF (step-by-step formulas with intermediate values), arc-flash labels PDF, plus BOQ, cable schedules and rates.</li>
</ul>
<div class="hc-note"><span class="hc-label">Stale results</span>Study results saved in a project are restored on load and are <em>not</em> recomputed. If a verdict looks out of date after an edit, re-run the study.</div>` }

);
