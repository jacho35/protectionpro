/* Help articles — reticulation, building & plans. Rendered by help.js; TeX between $…$ / $$…$$. */
HELP_ARTICLES.push(

{ id: 'design-types', group: 'design', title: 'Project types & workspaces',
  std: 'Project ▸ Project type & workspaces',
  kw: 'reticulation building network plant workspace tab site plan demand single line schedules interlocking new project',
  html: String.raw`
<p>A project is a <strong>Reticulation</strong>, a <strong>Building</strong> or a <strong>Network / plant</strong> project. The type decides which workspace tabs appear, in workflow order:</p>
<table class="help-ref-table"><thead><tr><th>Type</th><th>Workspaces, in order</th><th>For</th></tr></thead><tbody>
<tr><td>Reticulation</td><td>1 Site plan → 2 Demand → 3 Single-line</td><td>A township or site LV network: minisubs, kiosks and erven sized by ADMD (NRS 034-1)</td></tr>
<tr><td>Building</td><td>1 Floor plans → 2 Single-line → 3 Schedules</td><td>Floors, distribution boards and final circuits down to each way</td></tr>
<tr><td>Network / plant</td><td>Single-line · Interlocking</td><td>Substations, industrial and utility networks: the studies and breaker interlocking</td></tr></tbody></table>
<p>Extra workspaces can be switched on per project, and <em>a workspace that holds data is never hidden</em>, so a project can never lose sight of its own content. A legacy project with no stored type has its type inferred from its content, so opening an old file changes nothing in it.</p>
<h4>How the workspaces feed each other</h4>
<ul>
<li><strong>Plan → Demand</strong>: <em>Push to Schedules</em> populates minisubs, kiosks, erven, feeder lengths and street-light kVA from the drawing. It is one-way and idempotent — matching is by id, then name, then append, so renaming and re-pushing never duplicates or overwrites entered load data.</li>
<li><strong>Plan → Single-line</strong>: a route can be made into an SLD cable, keeping the link.</li>
<li><strong>Plan → Schedules</strong>: devices tagged to a board way write the way's load and quantity, and routed lengths become the way's cable length.</li>
<li><strong>Everything → Bill of quantities</strong>: see <a href="#" data-help="design-boq">Bill of quantities</a>.</li>
</ul>` },

{ id: 'design-admd', group: 'design', title: 'Reticulation demand (ADMD)',
  std: 'NRS 034-1 · Demand workspace',
  kw: 'admd after diversity maximum demand herman beta empirical dcf ucf kiosk minisub erf erven load class risk cornish fisher',
  html: String.raw`
<p>Sizes a residential reticulation from the number and class of connections, using one of the two NRS 034-1 estimation methods (chosen in the Demand settings bar). Conventions: single-phase 230 V, three-phase line 400 V, risk factor $z=1.28$, default ADMD 4.04 kVA.</p>

<h4>Empirical method</h4>
<p>For $N$ consumers on one phase with per-consumer ADMD:</p>
$$I_{ADMD}=\frac{ADMD\cdot1000}{230},\qquad I_{total}=N\,I_{ADMD}\,DCF(N),\qquad S=\frac{230\,I_{total}}{1000}$$
<table class="help-ref-table"><thead><tr><th>Correction set</th><th>Diversity correction $DCF(N)$</th><th>Unbalance correction $UCF(N)$</th></tr></thead><tbody>
<tr><td>AMEU</td><td>$1+\dfrac2N$</td><td>$1+\dfrac{2.8}{\sqrt N}$</td></tr>
<tr><td>British</td><td>$1+\dfrac{8\ \text{or}\ 12}{ADMD\cdot N}$ (8 if ADMD ≤ 5 kVA, else 12)</td><td>$1+\dfrac{4.14}{\sqrt N}$</td></tr>
<tr><td>None</td><td>1</td><td>1</td></tr></tbody></table>
<p>$UCF$ is returned as the <em>feeder current</em> ($I_{total}\cdot UCF$) for volt-drop on the distributor, but is <strong>not</strong> included in the kVA total.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>50 consumers on a phase, ADMD 4.04 kVA, AMEU: $I_{ADMD}=17.57$ A, $DCF=1+2/50=1.04$, $I_{total}=50\times17.57\times1.04=913$ A, $S=\mathbf{210\ kVA}$ on that phase; feeder current with $UCF=1.40$ is 1275 A.</p></div>

<h4>Herman-Beta method</h4>
<p>Each consumer's maximum-demand current is modelled as $c\cdot\text{Beta}(a,b)$, whose mean $\mu$, spread $\sigma$ and skewness $\gamma$ are</p>
$$\mu=\frac{a}{a+b}\,c,\qquad \sigma=c\sqrt{\frac{ab}{(a+b)^{2}(a+b+1)}},\qquad \gamma=\frac{2(b-a)\sqrt{a+b+1}}{(a+b+2)\sqrt{ab}}$$
<p>For $N$ consumers the sum is approximately Normal; a Cornish-Fisher correction adds the skew (reduced by $\sqrt N$), and the design current exceeds the mean by the risk factor $z$:</p>
$$\gamma_1=\frac{\gamma}{\sqrt N},\qquad z_{cf}=z+\frac{z^{2}-1}{6}\gamma_1,\qquad I_{design}=N\mu+z_{cf}\sqrt N\,\sigma$$
<p>Diversity and unbalance are inherent, so no $DCF$ or $UCF$ is applied. The risk factor is the standard-normal deviate: $z=1.28$ means a 10 % chance the true maximum demand exceeds the design value, 1.64 → 5 %, 2.33 → 1 %.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>A class with $a=2,\ b=3,\ c=60$ A: $\mu=24$ A, $\sigma=12$ A, $\gamma=0.286$. For $N=50$: $\gamma_1=0.0404$, $z_{cf}=1.2843$,</p>
$$I_{design}=50(24)+1.2843\sqrt{50}(12)=1200+109=1309\ \text{A}\ \Rightarrow\ S=\frac{230\times1309}{1000}=\mathbf{301\ kVA}$$</div>

<h4>Three-phase classes and aggregation</h4>
<p>A three-phase class tabulates its parameters <em>per phase</em>, so each such erf counts as one connection in <em>each</em> of the R/W/B buckets; the per-phase formulae are never multiplied by 3 again. Aggregation up the network is per-phase superposition: erven are bucketed into Red / White / Blue (a 3-phase erf counts three times; an erf with no phase is spread over all three), demand is computed per bucket, and the bucket kVAs are summed. Erven with an amps override are fixed, undiversified loads added on top.</p>
<p>Each figure in the Demand workspace has a ▾ caret that expands the working — the engine's own $N$, $\mu$, $\sigma$, $z_{cf}$ — rather than a re-derivation.</p>` },

{ id: 'design-retic-vd', group: 'design', title: 'Reticulation volt drop & feeder legs',
  std: 'Demand workspace · SANS 10142 / NRS 034 limits',
  kw: 'volt drop feeder service cumulative leg kiosk minisub max run vd cable r x pf 0.95',
  html: String.raw`
<p>Every feeder leg and erf service shows a voltage drop, and the feeder shows the cumulative drop from the minisub.</p>
<h4>Per run</h4>
<p>Using the full $R\cos\varphi+X\sin\varphi$ impedance drop at $\cos\varphi=0.95$ (not resistance alone), on the run's actual cable from the single cable library:</p>
$$z_{eff}=r\cos\varphi+x\sin\varphi,\qquad \Delta V=k_f\,I\,\ell\,z_{eff},\qquad k_f=\begin{cases}\sqrt3 & \text{three-phase, }400\text{ V}\\2 & \text{single-phase, out and return, }230\text{ V}\end{cases}$$
$$\text{VD}\,[\%]=\frac{\Delta V}{U}\times100$$
<p>$\ell$ in km. No snaking or additional-length allowance is added: enter the total run length.</p>
<h4>Cumulative</h4>
<p>The current on each leg is the diversified subtree current (a feeder) or the erf's own design current (a service). Legs from the minisub add:</p>
$$\text{VD}_{cum}=\sum_{legs}\text{VD}_{leg}\ \le\ \text{Max Feeder VD}$$
<p>Each service is checked against <em>Max Service VD</em> and each run against <em>Max Run VD</em> — the limits are set in the Demand settings bar and turn the badge green or red. The Cable Schedules view reads these same functions, so its numbers match the badges exactly.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>Three-phase leg, 95 mm² Al at 0.32 Ω/km, 0.075 Ω/km reactance, 180 A, 220 m: $z_{eff}=0.32(0.95)+0.075(0.312)=0.3274$, $\Delta V=1.732\times180\times0.22\times0.3274=22.5$ V, VD $=22.5/400=\mathbf{5.6\%}$.</p></div>` },

{ id: 'design-plan', group: 'design', title: 'Plan markup (site & floor plans)',
  std: 'Plan workspace',
  kw: 'plan calibrate scale route trench crossing device dxf import export ies auto circuit tag board way length sync background pdf',
  html: String.raw`
<p>The Plan workspace is a drawing surface for a site (reticulation) or a floor (building): place devices, draw routes and trenches, and let the geometry feed the rest of the project.</p>
<h4>Calibration and lengths</h4>
<p>Drawn geometry lives in world pixels. Calibrating a known distance sets the scale factor:</p>
$$f=\frac{d_{known}\ [\text{m}]}{d_{px}},\qquad \ell_{route}=f\sum_{k}\left|\mathbf{p}_{k+1}-\mathbf{p}_k\right|$$
<p>Route length is the polyline length times $f$; nothing that needs real distances (lengths, lux, grid) works until the plan is calibrated. A DXF that carries units lands at true scale and sets the scale on an uncalibrated floor.</p>
<h4>Elements</h4>
<ul>
<li><strong>Devices</strong> by domain: utility, transformer, generator, board, riser, junction box, lights, sockets, switches…</li>
<li><strong>Routes</strong> by type (LV feeder, service, MV, conduit, cable tray, final circuit…), each with a cable type and end points.</li>
<li><strong>Trenches, crossings, rooms/areas, measurements</strong>. Tools: <kbd>V</kbd> select, <kbd>G</kbd> snap to grid, <kbd>R</kbd> rotate, <kbd>Enter</kbd> finish a route.</li>
</ul>
<h4>DXF drawings</h4>
<p>Import a <code>.dxf</code> as a background (layers, blocks with attributes and all curve types are read). Map a CAD layer to a route type, trench, rooms or erf boundaries, and <em>Convert</em> mapped blocks to editable devices at their positions and rotations (one undo step; the mapping is remembered for the next issue). A DXF exported from ProtectionPro re-imports as editable devices, routes, trenches, crossings and rooms.</p>
<h4>Auto-circuiting (Building)</h4>
<p>Devices tagged to a board way ($\texttt{circuitDbId}$, $\texttt{circuitNo}$) let the plan write the way's load and quantity into the linked board schedule. Untagged devices can inherit a tag through connected final-circuit routes, or be distributed across ways with per-type caps. Routed length flows to the way's cable length, unless the way has been pinned manually.</p>
<h4>Lighting</h4>
<p>A calibrated plan can show a lux heatmap — see <a href="#" data-help="design-lux">Lighting (lux) heatmap</a>.</p>` },

{ id: 'design-lux', group: 'design', title: 'Lighting (lux) heatmap',
  std: 'Plan ▸ Lux · IES photometry',
  kw: 'lux illuminance lighting photometric ies candela cosine inverse square beam cone luminaire',
  html: String.raw`
<p>Point-by-point horizontal illuminance over the calibrated plan, summed over every fitting and drawn as a translucent heatmap. It is a <em>direct-illuminance</em> model: no interreflection and no obstruction, so it is design guidance, not a substitute for a photometric tool.</p>
<h4>The law</h4>
<p>At a point on the working plane, a fitting of intensity $I(\theta,\varphi)$ mounted at height $h$ over horizontal distance $r$ gives</p>
$$E=\sum_{i}\frac{I_i(\theta_i,\varphi_i)\,\cos\theta_i}{d_i^{2}},\qquad d=\sqrt{r^{2}+h^{2}},\quad \cos\theta=\frac{h}{d}$$
<p>so illuminance falls with the inverse square of distance and with the cosine of the incidence angle.</p>
<h4>Where the intensity comes from</h4>
<ul>
<li><strong>Measured</strong> — the fitting references an imported IES photometric file, so $I$ is read from the manufacturer's candela web at the true vertical and azimuth angle, rotated into the fitting's own frame. The accurate path. When a fitting's rated output differs from the tested luminaire's, the file's web is scaled by the lumen ratio.</li>
<li><strong>Cone</strong> — with no IES file, the fitting is a point source radiating uniformly inside a beam cone $\beta$:
$$I_0=\frac{\Phi}{2\pi\left(1-\cos\frac{\beta}{2}\right)}$$
with $\Phi$ from watts × efficacy (default 100 lm/W, beam 120°). Fine for a first pass but it ignores the optic entirely — a narrow optic can differ several-fold.</li>
</ul>
<p>Grid resolution (default 0.5 m) and mounting height (default 2.5 m) are settings. The toast on enabling states which model was used.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>A 3000 lm downlight, 120° cone, directly below (θ = 0), mounted 2.5 m above the working plane: $I_0=3000/(2\pi(1-\cos60^\circ))=3000/3.1416=955$ cd, so $E=955/2.5^2=\mathbf{153\ lx}$ under it.</p></div>` },

{ id: 'design-boq', group: 'design', title: 'Bill of quantities, rates & cable schedules',
  std: 'Reports ▸ Bill of Quantities · Rate Library · Cable Schedules',
  kw: 'boq bill of quantities rates rate library material labour allowance termination take-off cable schedule price cost',
  html: String.raw`
<h4>Take-off</h4>
<p>The BOQ counts what the project contains, from four sources, and prices it from the rate library:</p>
<table class="help-ref-table"><thead><tr><th>Source</th><th>What is counted</th></tr></thead><tbody>
<tr><td>Demand (reticulation)</td><td>kiosk feeders and erf services by cable type × length, minisubs, kiosks</td></tr>
<tr><td>Plans (site / floor)</td><td>routes by cable type, trenches, crossings, poles, devices, riser runs, junction-box joints</td></tr>
<tr><td>Single-line</td><td>cables, transformers, switchgear, CT/VT, relays, capacitor banks, surge arresters</td></tr>
<tr><td>DB schedules</td><td>board enclosures, final-circuit cable per way, breakers by poles / rating / curve, earth-leakage units, accessories</td></tr></tbody></table>
<p><strong>One cable is counted once.</strong> When two sources describe the same run the schedule wins over the drawing: Demand feeders and services over plan LV feeder / service routes; SLD cables made from the plan over those routes; DB way lengths over final-circuit routes tagged to that way. A feeder-to-sub-board way contributes its breaker only — its cable is the sub-main on the SLD.</p>
<h4>Pricing</h4>
$$\text{Line}=Q\times\left(r_{material}+r_{labour}\right),\qquad \text{Total}=\sum\text{Lines}+\sum_{k}p_k\cdot\text{Base}_k$$
<p>Percentage allowances (contingency, preliminaries, profit…) apply to a chosen base: total, one section, or just the material or labour part.</p>
<h4>Terminations</h4>
<p>Terminations are itemised <em>per cable size and type</em>, two ends per run. Final-circuit terminations are opt-in.</p>
<h4>Rate library and "Quantity from" rules</h4>
<p>Each item's quantity can be <em>measured</em> or derived by a rule from a count the app knows (erven, kiosks, LV cable metres, trench metres, boards, ways, light points…):</p>
<table class="help-ref-table"><thead><tr><th>Rule text</th><th>Means</th></tr></thead><tbody>
<tr><td><code>measured</code></td><td>the take-off quantity</td></tr>
<tr><td><code>1 x erven</code></td><td>$Q=1\times N_{erven}$</td></tr>
<tr><td><code>fixed 1</code></td><td>a lump-sum quantity</td></tr>
<tr><td><code>8% of total</code></td><td>an allowance on the whole priced BOQ ($p\times$ Base)</td></tr>
<tr><td><code>5% of material in cable</code></td><td>an allowance on the material part of one section</td></tr></tbody></table>
<p>Rates round-trip as CSV or XLSX with an import preview that shows what will change before it is applied.</p>
<h4>Cable schedules</h4>
<p>One row per cable, from results the project already has: <em>Reticulation</em> — feeders and services from Demand (design current, rating, loading, volt drop from the Demand functions); <em>Building</em> — sub-mains from the load flow (current, loading, volt drop) and final circuits from the <a href="#" data-help="cable-dbcheck">per-way circuit check</a>. Nothing is recomputed with different maths; a missing result shows as "—" with a way to run it.</p>` }

);
