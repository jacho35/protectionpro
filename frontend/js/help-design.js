/* Help articles — reticulation, building & plans. Rendered by help.js; TeX between $…$ / $$…$$. */
HELP_ARTICLES.push(

{ id: 'design-types', group: 'design', title: 'Project types & workspaces',
  std: 'Project ▸ Project type & workspaces',
  kw: 'reticulation building network plant lighting workspace tab site plan demand single line schedules interlocking new project overview rooms roads sports fields',
  html: String.raw`
<p>A project is a <strong>Reticulation</strong>, a <strong>Building</strong>, a <strong>Network / plant</strong> or a <strong>Lighting</strong> project. The type decides which workspace tabs appear, in workflow order:</p>
<table class="help-ref-table"><thead><tr><th>Type</th><th>Workspaces, in order</th><th>For</th></tr></thead><tbody>
<tr><td>Reticulation</td><td>1 Site plan → 2 Demand → 3 Single-line</td><td>A township or site LV network: minisubs, kiosks and erven sized by ADMD (NRS 034-1)</td></tr>
<tr><td>Building</td><td>1 Floor plans → 2 Single-line → 3 Schedules</td><td>Floors, distribution boards and final circuits down to each way</td></tr>
<tr><td>Network / plant</td><td>Single-line · Interlocking</td><td>Substations, industrial and utility networks: the studies and breaker interlocking</td></tr>
<tr><td>Lighting</td><td>1 Overview → 2 Plans → 3 Rooms → 4 Roads → 5 Sports fields (only the ones you pick)</td><td>Lighting design on its own: rooms and areas, roads, sports fields</td></tr></tbody></table>
<h4>Lighting projects</h4>
<p>When you pick <strong>Lighting</strong>, tick what you are lighting: <em>Rooms &amp; areas</em>, <em>Roads</em>, <em>Sports fields</em> (one or more). The dialog shows the tabs you will get.</p>
<ul>
<li><strong>Overview</strong>: one card per design with every item, its headline result and its verdict; obtrusive light, installed load and the luminaire library. <em>Calculate all</em> runs every room, area, field and obtrusive-light check on every floor and every road cross-section; <em>Lighting report (PDF)</em> covers the rooms, areas and fields (each road design has its own report on the Roads tab).</li>
<li><strong>Plans</strong>: the floor plans, their backgrounds and scale.</li>
<li><strong>Rooms</strong>: rooms, outdoor areas, fences, escape routes and obtrusive-light checks, on the plan, as a table or in 3D.</li>
<li><strong>Roads</strong>: lighting design on a cross-section and the Road plan. There is no Circuits view until you add street-light circuits.</li>
<li><strong>Sports fields</strong>: fields, masts and aimed floods, stands and TV cameras, on the plan, as a table or in 3D.</li>
</ul>
<p>The electrical side (street-light circuits, board schedules, the single line, quantities) is off until you add it: tick <em>Also design the electrical side</em> when creating the project, use the buttons at the foot of the Overview, or Project › Project type &amp; workspaces. A design that already holds items can't be switched off there.</p>
<p>Extra workspaces can be switched on per project, and <em>a workspace that holds data is never hidden</em>, so a project can never lose sight of its own content. A legacy project with no stored type has its type inferred from its content, so opening an old file changes nothing in it.</p>
<h4>How the workspaces feed each other</h4>
<ul>
<li><strong>Plan → Demand</strong>: <em>Output › Push to Demand schedules</em> populates minisubs, kiosks, erven, feeder lengths and street-light kVA from the drawing. It is one-way and idempotent — matching is by id, then name, then append, so renaming and re-pushing never duplicates or overwrites entered load data.</li>
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
<p>Rooms and outdoor areas are drawn and calculated on the Lighting tab's plan view and shown there in false colour — see <a href="#" data-help="design-roomlight">Room, outdoor &amp; emergency lighting</a>. Road lighting to EN 13201 is under Street lighting — see <a href="#" data-help="design-roadlight">Road lighting design</a>.</p>` },

{ id: 'design-roomlight', group: 'design', title: 'Room, outdoor & emergency lighting',
  std: 'Lighting ▸ Plan ▸ Detect room · Calculate all · EN 12464-1/-2 · EN 1838 · CIE 117 · CIE 112 · EN 15193-1',
  kw: 'room lighting lux illuminance polar curve light distribution isolux lines point values cone diagram beam angle field angle section cut uniformity ugr glare gr radiosity interreflection reflectance maintenance factor auto layout outdoor car park pole floodlight perimeter fence vertical emergency escape route anti-panic high risk leni energy w/m2 detect room boundary dxf',
  html: String.raw`
<p>Design the lighting of a room, a car park or yard, a fence line and the escape routes in the <strong>Lighting</strong> workspace: its <em>Plan</em> view is the floor plan with the lighting tools, its <em>Table</em> view lists every zone across all floors, and one PDF report covers them all. The floor plan itself (underlays, scale, devices) is drawn on the Plan tab; light fittings are the same items on both.</p>
<h4>The workflow</h4>
<ol>
<li><strong>Make the room.</strong> <em>Detect room</em> finds the boundary from a DXF underlay (its wall layers, closing door openings up to the gap you set) or from a plan image or PDF (dark pixels are walls). Drag the corners to correct it, drag a midpoint to add one, double-click to remove one. Or draw it by hand. With no plan at all, <em>Room from a shape</em> makes a rectangle, L, T or U room from its sizes in metres, or <em>Any shape</em>: a polygon drawn on a metre grid (drag corners, double-click a wall to add one) or typed corner by corner and wall by wall (a blank floor is scaled automatically), for a quick calculation.</li>
<li><strong>Ceiling section.</strong> A ceiling need not be flat: in the room's panel pick <em>Pitched</em>, <em>Mono-pitch</em> or <em>Barrel vault</em> and type the heights, or <em>Draw the section…</em> for any profile — a flat centre with sloping sides, a step up to a clerestory. The section is cut across the room and runs the length of it, the ridge along the wall you choose (or at an angle). The calculation meshes the sloping ceiling at its true area, cuts the walls to it (gable ends), and blocks light that a step or a valley in the ceiling would stop. Fittings on the ceiling tilt with it; a <em>pendant</em> hangs at the height you give; a fitting <em>on the wall</em> sits on the nearest wall at its height, aimed from straight down (0°) through across the room (90°) to straight up (180°).</li>
<li><strong>Set the task.</strong> The room's <em>Lighting</em> section takes a task from a table (targets Ē<sub>m</sub>, U<sub>0</sub>, UGR, walls, ceiling) and the ceiling height, work plane, wall zone, reflectances and maintenance factor. The <em>Standard</em> box picks where the targets come from: EN 12464-1:2021 or SANS 10114-1:2020 (SANS gives only E<sub>m</sub>, UGR and R<sub>a</sub>; U<sub>0</sub>, E<sub>z</sub> and the wall and ceiling targets then stay at the EN 12464-1 values). The choice is for the whole project and also sets the emergency limits. Every target is editable; an edited room keeps what you entered when you change standard.</li>
<li><strong>Choose luminaires.</strong> <em>Luminaire library…</em> opens the one library shared with road lighting: import the manufacturer's IES / LDT, or add a generic optic for feasibility. Pick an entry to see its polar curve (C0–C180 solid, C90–C270 dashed, in cd/klm, with the beam angle at 50 % and the field angle at 10 % of the peak), the isolux lines one fitting makes on the floor at a mounting height you type, a cone diagram (spot diameter and E<sub>max</sub> at 1–4 m) for a downlight that throws the same way in every plane, and its key figures.</li>
<li><strong>Place fittings.</strong> Place Light Fittings and pick the library luminaire, or let <em>Auto layout</em> propose rows × columns that meet the targets: it tests lattices cut to the room outline, re-checks the best on the full calculation, and shows a ghost of the one you pick before you place it.</li>
<li><strong>Report.</strong> <em>PDF report</em> asks which zones and which sections to include (summary, energy, a page per zone with its plot, results, luminaire schedule and assumptions, and the method page) before it makes the PDF.</li>
<li><strong>Calculate.</strong> <em>Calculate all</em> (or the room's Calculate) draws the work-plane illuminance in false colour with isolux lines at the target and at the minimum point value, and lists each check. The legend in the corner of the plan reads the selected zone: blue is 0 lx, red its maximum, with the target and the required minimum marked (each zone has its own scale). A result reads <em>Out of date</em> as soon as the room or its fittings change.</li>
<li><strong>Read the result.</strong> <em>Show</em> on the toolbar switches the plan between false colour, isolux lines (every 10–500 lx, or <em>Auto</em> for about eight lines, each labelled, the target drawn heavier in blue), isolux lines with the point values, and the point values alone (spaced so they stay readable at the zoom). <em>Light distribution</em> draws each fitting's light distribution seen from above — how far it throws light in every direction, all fittings to one scale, with an arrow along its C0 plane — so a turned batten or a wall washer aimed the wrong way shows at a glance. The room panel's <em>Section</em> cuts the room along or across its longest wall: walls, ceiling (its section too) and work plane, each fitting near the cut with its polar curve in the plane of the cut, all to one candela scale, and under it the work-plane illuminance along the cut against the target. The cut shows on the plan while the section is open.</li>
</ol>
<h4>Indoors</h4>
<p>Direct light from each luminaire's photometric web, plus light reflected between the floor, walls and ceiling by diffuse radiosity. For a point with normal $\mathbf n$:</p>
$$E=\sum_i\frac{I_i(C,\gamma)\cos\theta_i}{d_i^{2}}+\sum_j\frac{B_j\cos\theta_p\cos\theta_j A_j}{\pi d_j^{2}+A_j},\qquad B=\rho\,(E_{direct}+F\,B)$$
<p>The form factors are symmetric and balanced so the solution conserves flux (absorbed light equals emitted light). In a room that is not a rectangle, a luminaire or a surface hidden behind a corner contributes nothing. Reported: Ē<sub>m</sub>, E<sub>min</sub>, E<sub>max</sub> and U<sub>0</sub> = E<sub>min</sub>/Ē<sub>m</sub> on the work plane (wall zone left out; the grid follows the EN 12464-1 maximum for the room's size, at most 0.5 m, unless you enter a <em>Calculation grid</em> size for the room — the result says when that is coarser than the standard allows or had to be widened to stay under 9000 points), mean illuminance on walls, ceiling and floor, cylindrical illuminance at 1.2 m, and W/m². Illuminance is the maintained value (× maintenance factor).</p>
<h4>Glare</h4>
<p>UGR to CIE 117 at the middle of each wall, eye 1.2 m, looking along the room axes, with the luminaires' initial flux:</p>
$$UGR=8\log_{10}\!\left(\frac{0.25}{L_b}\sum\frac{L^{2}\omega}{p^{2}}\right),\qquad L_b=\frac{E_{ind}}{\pi}$$
<p>$p$ is the Guth position index. Outdoors the glare rating GR to CIE 112 is found at the worst of a grid of observers (eye 1.5 m, eight directions): $GR=27+24\log_{10}\!\left(L_{vl}/L_{ve}^{0.9}\right)$, with the veiling luminance $L_{vl}=10\sum E_{eye}/\theta^{2}$.</p>
<h4>Outdoors</h4>
<p><em>Outdoor area</em> (car park, yard, walkway): direct light on the ground from poles and floodlights anywhere on the sheet — each has a mounting height, a tilt towards its front and a heading. <em>Pole layout</em> tries pole lattices from the fewest upward. <em>Perimeter / fence</em>: the vertical illuminance at the fence height on the face you choose (ticks on the plan show which): E<sub>v,min</sub> and E<sub>v,min</sub>/E<sub>v,avg</sub> against your own security targets. Floodlit pitches and courts have their own zone type — see <a href="#" data-help="design-sportslight">Sports field lighting</a>; light leaving the site is checked with <a href="#" data-help="design-obtrusive">Obtrusive light</a>.</p>
<h4>Emergency lighting</h4>
<p>Floor illuminance from the fittings in emergency mode (kind <em>Emergency</em>, or an <em>Emergency output %</em>), direct light only, each at its emergency output; a wall stops the light. An <em>escape route</em> (a drawn line with a width) needs 1 lx on the centre line and E<sub>max</sub>/E<sub>min</sub> ≤ 40:1; EN 1838 adds 0.5 lx across the central band. An <em>open (anti-panic) area</em> needs 0.5 lx with a 0.5 m border left out (EN 1838) or 1 lx up to the perimeter (SANS 10114-2). A <em>high-risk task area</em> needs 10 % of the task illuminance and not less than 15 lx (EN 1838) or 20 lx (SANS 10114-2). The project's standard picks which set applies.</p>
<h4>Energy</h4>
<p>Installed W/m² and W/m² per 100 lx for every room, and LENI by the EN 15193-1 quick method:</p>
$$LENI=\frac{\sum P\,F_C\,\big(t_D F_O F_D+t_N F_O\big)}{1000\,A}\ \ [\text{kWh/m}^2\text{·yr}]$$
<p>Parasitic and emergency standby energy are not included. Enter the power-density limit from your regulation to have it checked.</p>
<h4>The Lighting workspace and the PDF</h4>
<p>One list of every room, area, fence and route on every floor with its results and verdict; filter by floor, site, escape routes or failing; <em>Locate</em> jumps to the item on its floor. <em>Calculate all</em> steps through the floors and returns to the one you were on. Results belong to the session: after opening a project, press Calculate all. <em>PDF report</em> gives the summary, the energy table and one section per item (plot, results, luminaire schedule, assumptions) and a page on method.</p>
<h4>3D view: objects, windows, doors and calculation surfaces</h4>
<p>The Lighting tab's <em>3D</em> view shows one room, rotatable (drag to orbit, right-drag to pan, scroll to zoom). Add desks, shelving, partitions, columns and boxes and drag them into place; an object that <em>blocks light</em> casts shadows in the direct light, hides surfaces from each other in the interreflection and is meshed into patches with its own reflectance. Work-plane points inside an object are left out of Ē, Emin and U₀. A window or door replaces its piece of wall in the interreflection with its own reflectance (a window at night reflects little and lets the rest out). A <em>calculation surface</em> — drawn, or on the top of an object — is gridded like the work plane and checked against its own target. <em>Show</em>: Model, False colour, or <em>Rendered light</em>: every surface patch of the calculation drawn as bright as it looks, its luminance $L=\rho E/\pi$ through an exposure curve. The Road plan has a 3D view too: trees (a crown that lets $1-\text{opacity}$ through), buildings, walls, bus shelters and sign gantries shade the road when <em>Shadows from objects</em> is on — the segment checks, junctions and heat map then include them, although EN 13201-3 assumes an unobstructed road — and facade checks give vertical illuminance on a building face.</p>
<h4>What it does not model</h4>
<p>Daylight, sloped ceilings and coloured surfaces. A wall stops light in the emergency calculation and in rooms that are not convex. Generic optics are representative, not products.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>Six 4000 lm panels in a 6 × 5 m room (room index 1.4, reflectances 0.7 / 0.5 / 0.2), maintenance factor 1. The whole-plane utilisation comes out at 0.82, so $\bar E_m\approx 6\times4000\times0.82/30=\mathbf{656\ lx}$ — the tabulated utilisation factor for a near-Lambertian luminaire at this room index is about 0.8. With no reflections at all the same room gives 0.67, about 535 lx.</p></div>` },

{ id: 'design-sportslight', group: 'design', title: 'Sports field lighting (floodlit pitches and courts)',
  std: 'Lighting ▸ Plan ▸ Sports field · EN 12193 classes (provisional) · CIE 112 · EN 12464-2 grid',
  kw: 'sports field pitch court stadium 3d three dimensional render stand spectator spill aerial ball flight football soccer rugby hockey tennis netball floodlight mast aiming aim point tilt heading class I II III en 12193 uniformity u1 u2 glare gr cie 112 vertical illuminance camera television tv players optimise aiming pattern near scattered scatter opposite cross banded band compare patterns dim dimming remove floods trim',
  html: String.raw`
<p>A <strong>sports field</strong> is a lighting zone on the Lighting tab's plan: the playing area as a rectangle, with its masts and floodlights. Masts and aim points are kept in the field's own metres (x along the length from the first corner, y across), so moving or turning the field takes them along.</p>
<h4>The workflow</h4>
<ol>
<li><strong>Place the field.</strong> <em>Sports field</em> in the Draw list, then click the centre spot. Pick the sport (its standard size fills in), the lighting class and the turn.</li>
<li><strong>Choose masts.</strong> 4 corner, 4, 6 or 8 side masts at a setback behind the lines. The suggested height sees the pitch at 25° or more from the centre line (side masts) or the centre spot (corner masts). The suggested flood count gives one flood per 150 m² and enough light for the target, assuming 75 % of it lands on the pitch. A <em>generic</em> sports floodlight (medium ≈ 30° or narrow ≈ 16° beam) is sized to that light; a library luminaire keeps its own lumens and sets the count.</li>
<li><strong>Aim.</strong> Pick an <em>aiming pattern</em> (below) when you create the masts; <em>Optimise aiming</em> then moves the aim points, inside the pattern, until the field's targets are met. <em>Compare patterns…</em> tries every pattern and lists the results side by side. <em>Aim…</em> on a mast opens its section and its floods: aim x / y, luminaire, output %, and the throw, tilt and direction that follow. <em>Mirror to opposite mast</em> copies the aiming across the centre line.</li>
<li><strong>Calculate</strong> and open <em>Results…</em>: the pitch in false colour with the value at every grid point, the checks, the glare observers and the vertical illuminance. The field is also in the Lighting table and the PDF report.</li>
</ol>
<h4>In 3D</h4>
<p><em>View in 3D</em> on the field (or the Lighting tab's <em>3D</em> view, picking the field) shows the pitch with its markings, the masts with their floods turned to their aim points, the stands raked from the front row to the back, and TV cameras. Drag to orbit; drag a mast or camera to move it (its floods stay aimed at the same points). Click a mast to change its height, its output or open <em>Aim floods…</em> — its floods' tilts are listed, any over the limit in red. Click a stand to change its size and rake. <em>Light cones</em> draws every flood's aim line. <em>False colour</em> paints the pitch and the seats on one scale, and with <em>Aerial layers</em> ticked the aerial zone at its heights; <em>Rendered light</em> shows the pitch and the seats at night as bright as they look (illuminance × reflectance), the floods glowing. The floods are drawn in rows on a headframe; the calculation puts them all at the mast top.</p>
<h4>What is calculated</h4>
<p>Direct light only. A flood at height $h$ aimed at a point a horizontal distance $d$ away is tilted $\tan^{-1}(d/h)$ from straight down towards it. Horizontal illuminance at the centres of an $n_x\times n_y$ grid over the playing area, maintained (× MF):</p>
$$E_h=MF\sum_i\frac{I_i(C,\gamma)\cos\theta_i}{d_i^{2}},\qquad U_1=\frac{E_{min}}{E_{max}},\qquad U_2=\frac{E_{min}}{\bar E_h}$$
<p>The automatic grid step is the EN 12464-2 formula $p=0.2\cdot5^{\log_{10}L}$ on the field length (5.2 m for a 105 m pitch: 21 × 14 points); EN 12193 sets a grid per sport — type its step in <em>Grid</em> to use it. Vertical illuminance is found on the same grid at 1.5 m on planes facing each camera (when the field is <em>Televised</em>) and facing each end and side (players). The glare rating GR follows CIE 112 at 15 observers — the two ends, the quarter lines and halfway, on both touchlines and the centre line — eye 1.5 m, every 45°: $GR=27+24\log_{10}\!\left(L_{vl}/L_{ve}^{0.9}\right)$ with $L_{ve}=0.035\,\rho\,\bar E_h/\pi$ from the ground reflectance. The steepest flood is checked against the tilt limit (70° keeps the beam below the horizontal).</p>
<p>Every floodlight in the project lights every field — a neighbouring pitch's masts and the plan's own floodlights included — and a field's floods count as outdoor luminaires for outdoor areas and fences. Power, flood count and the tilt check are the field's own.</p>
<h4>Stands</h4>
<p>Add a stand beside a side or an end: the gap to the line, its depth, the part of the side it covers (blank = all of it) and the height of the front and back rows (the rake). On a 2 m grid over the stand: illuminance on the seats (horizontal, on the rake), vertical illuminance on spectators' faces 1.2 m above the row turned to the pitch centre, and GR for spectators at six seats (front and back, ends and middle) looking down at the pitch centre and 30° either side, with the pitch as the background. Enter a seat illuminance or a GR limit to have them checked; otherwise they are reported only.</p>
<h4>Aerial zone</h4>
<p>For sports where the ball flies (football, rugby, tennis, cricket), tick <em>Aerial zone</em> and give the heights. The pitch grid is repeated at each height: the horizontal illuminance (plane facing up) and the mean of the vertical illuminance on four planes facing the ends and the sides — a ball seen from any side — with its minimum, U₂ and the weakest of the four planes. A height above the masts is flagged: a ball up there is lit from below. An optional Ē<sub>v</sub> target is checked at every height.</p>
<h4>Aiming patterns</h4>
<p>A pattern sets where each mast's floods point and the zone they keep to while the optimiser works:</p>
<ul>
<li><strong>Near</strong>: each mast lights the part of the pitch nearer to it than to any other mast. Short throws and steep beams: the least glare and spill.</li>
<li><strong>Scattered</strong>: every mast's floods spread over the whole pitch, interleaved with the other masts' floods, so each point is lit from many directions (fewer hard shadows).</li>
<li><strong>Opposite</strong>: each mast lights the half of the pitch beyond the centre: across from a side mast, the far end from an end mast, the far diagonal from a corner mast. Long throws put light on players' faces from several sides, but give more glare and spill. Any part of that half beyond the tilt limit is left out of the zone, and the mast is named in a note. On low side masts the far touchline can then go dark.</li>
<li><strong>Banded</strong>: masts at the same place along the length share a strip across the whole width, touchline to touchline; the strips split the length halfway between the mast positions. The usual layout for side masts.</li>
</ul>
<p>The floods are spread evenly over the zone, and where masts share a zone each mast takes points in turn so their floods interleave. A pattern can go on every mast, or on one mast in the <em>Aim…</em> dialog (only that mast's floods then move), so masts can be mixed. Typing an aim point makes that mast <em>custom</em>: the optimiser may then move its floods anywhere on the pitch.</p>
<h4>Optimise aiming</h4>
<p>First, every pass weights the grid by $w=(\bar E_h/E)^{2}$ and moves each aim point by the difference between its own footprint's weighted and plain centroids, so a flood drifts towards the dark side of its patch of light. Then each flood in turn tries eight moves of a step that halves when nothing improves, and keeps a move that lowers the cost. The cost is the shortfall against every target the field has: $\bar E_h$, U₂, U₁ (when set), GR, and $\bar E_v$ and U₂ towards each camera on a televised field. Further terms keep improving uniformity, keep light on the pitch and keep GR down once the targets are met. The darkest and brightest points are taken as power means, so every dark spot counts and not only the darkest. Aim points stay in their zone, on the pitch and at least 2° inside the tilt limit. Only the field's own floods are considered, on the calculation's own grid, glare observers and camera planes, so its figures match a calculation of the field on its own. A medium beam reaches U₂ about 0.85–0.9 on a six-mast football pitch with a near or banded pattern. A narrow beam on a short throw leaves a bright spot that no aiming removes: use narrow beams for long throws from tall masts.</p>
<p><strong>After aiming</strong> (on the field, in <em>Aim…</em> and in <em>Compare patterns…</em>):</p>
<ul>
<li><em>Dim to the target</em> sets every flood to the same output %: the lowest that still meets the Ēh and camera Ēv targets, with 2 % in hand, rounded up to a whole per cent. Uniformity does not change.</li>
<li><em>Remove spare floods, then dim</em> first drops floods one at a time while every target is still met at full output. It drops the flood whose loss costs least, never a mast's last flood, and re-aims briefly after each. It leaves fewer fittings, but uses about the same power as dimming.</li>
</ul>
<h4>Targets</h4>
<p>The class targets (Ē<sub>h</sub>, U₂, GR, R<sub>a</sub> for classes I, II and III per sport) are provisional — check them against EN 12193 before issue. Every number is editable; <em>Reset to class</em> puts them back. TV targets (Ē<sub>v</sub> towards a camera and its uniformity) come from the broadcaster or league and are entered per field. R<sub>a</sub> is not calculated: check the floodlight's data sheet.</p>
<h4>What it does not model</h4>
<p>Wet or snow-covered surfaces, and light reflected from the pitch onto the stands. Obtrusive light outside the site is a separate check — see <a href="#" data-help="design-obtrusive">Obtrusive light</a>. Generic floodlights are representative distributions for feasibility, not products — import the manufacturer's IES / LDT for a compliance design.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>A Class I football pitch (105 × 68 m, 500 lx) with six side masts 5 m behind the touchlines: the suggested height is $\lceil\tan25^\circ\times(5+34)\rceil=\mathbf{19\ m}$, the coverage rule gives $\lceil 7140/150/6\rceil=8$ floods a mast, and the light needed is $500\times7140/(0.75\times0.8)\approx5.95$ Mlm, so each of the 48 generic floods is sized to 125 000 lm. After optimising: Ē<sub>h</sub> ≈ 503 lx, U₂ ≈ 0.76, GR ≈ 44, steepest tilt 68°.</p></div>` },

{ id: 'design-obtrusive', group: 'design', title: 'Obtrusive light (EN 12464-2)',
  std: 'Lighting ▸ Plan ▸ Obtrusive light check · EN 12464-2:2024 Tables 4 and 5',
  kw: 'obtrusive light spill light trespass neighbours windows facade site boundary environmental zone e0 e1 e2 e3 e4 curfew upward light ratio rul ulr sky glow luminous intensity threshold increment ti road drivers glare',
  html: String.raw`
<p>Light that leaves the site — on neighbours' windows, glaring at drivers, or sent into the sky — is limited by the environmental zone of the surroundings. Draw an <strong>Obtrusive light check</strong> on the Lighting tab's plan as a line and pick what it is. Every outdoor luminaire on the floor counts: poles, floodlights and sports-field floods.</p>
<h4>Property — boundary, windows or facade</h4>
<p>Along the line, every <em>spacing</em> metres at each of the <em>heights</em> (the sill or middle of each floor's windows), the vertical illuminance on the face turned towards the lighting (ticks on the plan show which face; for a ring round the site, <em>facing in</em>):</p>
$$E_v=\sum_i\frac{I_i(C,\gamma)\cos\theta_i}{d_i^{2}}$$
<p>and the largest luminous intensity $I$ of any luminaire in front of the face towards any point — the light someone at the window looks into. With a facade reflectance $\rho$ the facade's average luminance is $L_b=\rho\,\bar E_v/\pi$ (a diffuse facade). Each property check also reports the installation's <strong>upward light ratio</strong>: the share of all the luminaires' flux sent above the horizontal in their installed tilt and heading, found by integrating each one's intensity over the sphere — a floodlight tilted up to throw further sends more light into the sky.</p>
<h4>Road — glare to drivers</h4>
<p>Drivers on the line, eye 1.5 m, look along it in both directions 1° down; luminaires more than 20° above the line of sight are hidden by the car roof. The threshold increment is that of road lighting, $TI=65\,L_v/L_a^{0.8}$ %, with the veiling luminance $L_v$ from each luminaire's light at the eye and the adaptation luminance $L_a$ from the road's lighting class: 0.1 cd/m² for an unlit road, 1 for M5, 2 for M4 / M3, 5 for M2 / M1. The limit is 15 %.</p>
<h4>Limits (EN 12464-2:2024 Table 4)</h4>
<table class="help-ref-table"><tr><th>Zone</th><th>E<sub>v</sub> pre / post (lx)</th><th>I pre / post (cd)</th><th>R<sub>UL</sub> (%)</th><th>L<sub>b</sub> (cd/m²)</th></tr>
<tr><td>E0 dark-sky parks, observatories</td><td>0 / 0</td><td>0 / 0</td><td>0</td><td>0.1</td></tr>
<tr><td>E1 national parks, protected sites</td><td>2 / 0</td><td>2 500 / 0</td><td>0</td><td>0.1</td></tr>
<tr><td>E2 rural</td><td>5 / 1</td><td>7 500 / 500</td><td>2.5</td><td>5</td></tr>
<tr><td>E3 suburbs</td><td>10 / 2</td><td>10 000 / 1 000</td><td>5</td><td>10</td></tr>
<tr><td>E4 town centres</td><td>25 / 5</td><td>25 000 / 2 500</td><td>15</td><td>25</td></tr></table>
<p>Post-curfew limits apply after the curfew time the local authority sets; with no curfew rule, the pre-curfew values must not be exceeded and the post-curfew ones are preferable. Assessing <em>post-curfew</em>, enter the output the lighting runs at then (0 % when the sports floods are switched off). An E1 post-curfew Ev of up to 1 lx is allowed for public road lighting. Everything is calculated on the initial flux (no maintenance factor): a new installation is the worst case.</p>
<h4>What it does not model</h4>
<p>Light reflected off the ground and buildings towards the property, sign luminance L<sub>s</sub>, and sky glow beyond the upward light ratio. Generic optics are representative, not products.</p>` },

{ id: 'design-roadlight', group: 'design', title: 'Road lighting design (EN 13201 / SANS 10098-1)',
  std: 'Street lighting ▸ Lighting design · SANS 10098-1/-2 · EN 13201-2/-3/-5 · CIE r-tables',
  kw: 'road lighting street lux luminance cd/m2 uniformity uo ul threshold increment ti rei edge ratio m class p class c class a1 a2 a3 a4 b1 b2 b3 sans 10098 road class category r3 r-table ies ldt eulumdat spacing optimise ulysse pdi aeci',
  html: String.raw`
<p>Street lighting ▸ <em>Lighting design</em> checks a straight road, drawn as a cross-section, against the lighting categories of the design's <em>Standard</em>: <b>SANS 10098-1</b> (the default for a new design) or <b>EN 13201-2</b>. The strips are carriageways with lanes, footpaths, cycle tracks, verges and medians. One or more rows of luminaires repeat at a common spacing $S$. The photometric calculation follows CIE 140 / EN 13201-3, which SANS 10098-1 adopts.</p>
<h4>SANS 10098-1 categories</h4>
<p>SANS 10098-1:2007 has its own categories; they are not the EN M/C/P classes.</p>
<ul>
<li><b>Group A</b> (A1 freeways and expressways over 90 km/h, A2 major roads, A3 important urban routes up to 60 km/h, A4 connecting and local distributor roads) is designed on luminance. Table 1 gives $\bar L$, $U_o$, $U_l$ and TI for the maximum traffic volume during darkness, per lane, and for a cross-section with or without a median. The design's median strip sets that column; each carriageway's <em>Night traffic</em> picks the volume. A volume between two columns takes the heavier one.</li>
<li>$\bar L$, $U_o$ and TI come from <b>one observer</b>, 60 m before the field, 1.5 m high, a quarter of the carriageway width from the left-hand side of the road. For a carriageway with traffic travelling towards you, that is the far edge. $U_l$ is taken along each lane's centre line with the observer in that lane (Appendix D).</li>
<li>The surround ratio ES is a design parameter with no tabulated limit, so it is reported but not checked.</li>
<li><b>Groups B</b> (residential streets B1–B3) and <b>C</b> (wholly pedestrian C1, C2) are designed on horizontal illuminance $\bar E$ and $E_{min}$ (Table 2). A B category on a carriageway covers the carriageway plus the footways up to 2 m from its edge. The semi-cylindrical $E_{sc,min}$ is a supplementary criterion for higher-security areas and is not calculated yet.</li>
<li>From <b>SANS 10098-2</b>: roadway complexes RC0–RC5 (Table 1, $\bar E$ and uniformity 0.4) and cycle / pedestrian ways CP1–CP6 (Table 3).</li>
</ul>
<p><em>Suggest…</em> beside each class proposes a category. For a road it uses the functional road class (1 trunk … 5 residential access), the speed limit, the night traffic and the median. For a junction it uses SANS 10098-2 Table 2, and for a cycle or pedestrian way its Table 4. It is a starting point; the road authority's classification governs.</p>
<h4>Grid</h4>
<p>The field runs between two consecutive luminaires of the first row. Along the road it has $N = 10$ points when $S \le 30$ m, otherwise the smallest $N$ that makes $D = S/N \le 3$ m. The first point is $D/2$ from the luminaire. For luminance there are 3 points per lane. For illuminance each strip gets $n \ge 3$ points across, spaced $d \le 1.5$ m.</p>
<h4>Illuminance and luminance</h4>
$$E=\text{MF}\sum_i \frac{I_i(C,\gamma)\cos^{3}\gamma_i}{H_i^{2}},\qquad L=\text{MF}\sum_i \frac{I_i(C,\gamma)\;r(\beta_i,\tan\gamma_i)}{H_i^{2}}$$
<p>$I$ is read from the luminaire's measured Type C web. C0 runs along the road and C90 points across it to the side the row faces. The row's tilt and rotation are applied first. $r$ is the reduced luminance coefficient from the road surface's CIE table (R1–R4, C1, C2), read by linear interpolation. $\beta$ is the angle between the observer's vertical plane and the light's vertical plane at the point: 0 when the luminaire stands beyond the point. Luminance counts luminaires from 5H towards the observer to 12H beyond the point, and ignores any with $\tan\gamma > 12$. Illuminance counts luminaires within 5H.</p>
<h4>Observer, uniformity and glare (EN 13201)</h4>
<p>Under EN 13201 the observer's eye is 1.5 m high, 60 m before the field, at the centre of each lane in turn. The reported values are the lowest $\bar L$ and $U_o = L_{min}/\bar L$ over those positions, and the lowest $U_l$, taken along the centre line of the observer's own lane.</p>
<p>The threshold increment uses initial values (no MF):</p>
$$f_{TI} = \frac{65\,L_v}{\bar L^{0.8}}\ \%,\qquad L_v = 9.86\left[1+\left(\tfrac{23}{66.4}\right)^{4}\right]\sum_k \frac{E_{eye,k}}{\theta_k^{2}}$$
<p>The line of sight is 1° below horizontal and $\theta$ is in degrees (1.5°–60°; the CIE 146 small-angle form is used below 1.5°). Luminaires above a 20° car-roof screen are hidden. The observer starts $2.75(H-1.5)$ before the field's first luminaire and moves across one field in steps of $D$. The reported $f_{TI}$ is the worst of those positions. REI is the ratio of $\bar E$ just outside each carriageway edge to $\bar E$ just inside it, on strips $\min(5\,\text{m}, W/2)$ wide.</p>
<h4>Energy</h4>
<p>From EN 13201-5: $D_P = P/\sum \bar E_i A_i$ in W/(lx·m²) and $D_E = P\,t/A$ in kWh/(m²·yr), with W/km and poles/km for the quantities.</p>
<h4>Solving</h4>
<p><em>Find max spacing</em> sweeps $S$ and returns the largest spacing that passes every class. <em>Optimise</em> tries every combination of mounting height, tilt, overhang, luminaire and dimming level on all rows, each at its largest passing spacing, and ranks the passing options by W/km, poles/km or PDI. <em>Apply spacing to circuit</em> writes the spacing into a street lighting circuit for its volt drop and earth loop check.</p>
<h4>Photometry</h4>
<p>Import the manufacturer's IES (LM-63) or EULUMDAT (.ldt) file. If the file's C90 plane does not point to the street side, correct it with the luminaire's <em>Rotate C-planes</em>. Changing the flux rescales the whole web: same optic, other lumen package. The generic optics are smooth representative distributions for feasibility work, not real products.</p>
<p>Not modelled yet: wet-road $U_{ow}$ and P-class $E_{v}$ / $E_{sc}$. Roads that are not straight, with junctions and the actual pole positions, are designed in <a href="#" data-help="design-roadplan">Road plan</a>.</p>` },

{ id: 'design-roadplan', group: 'design', title: 'Road plan — lighting on roads of any shape',
  std: 'Street lighting ▸ Road plan · EN 13201-3 / CIE 140 · SANS 10098-1/-2 · EN 13201-2 C classes',
  kw: 'road plan curved road bend junction intersection conflict area centreline alignment chainage kerb trace dxf poles layout heatmap isolux luminance plan view segment tangent arc fillet radius',
  html: String.raw`
<p>Street lighting ▸ <em>Road plan</em> runs the road lighting calculation on real road shapes. The road is drawn on a plan in metres, a Lighting design's cross-section is swept along it, and the luminaires stand where the poles actually are. Junctions are checked as conflict areas. The work goes in three steps.</p>
<h4>1 Road shape</h4>
<ul>
<li><b>Draw centreline</b>: click the intersection points. Each corner is rounded with a tangent arc at the <em>Bend radius</em> (one corner can take its own radius in the alignment table). If two arcs need more length than the leg between them, both tangents are shortened and the radii shrink.</li>
<li><b>Trace kerbs</b>: trace one kerb, then the other. The centreline runs midway between them, and the carriageway width follows the traced kerbs. Strips between the kerbs scale to that width; footpaths and verges outside keep their own.</li>
<li><b>From DXF</b>: load a site plan or survey as the background and click a line. Connected lines, arcs and polylines on the same layer (ends within 5 cm) are joined. Use it as the centreline, or as the first and then the second kerb.</li>
</ul>
<p>The cross-section reads left to right looking up the chainage (the arrow on the road). A road is cut into <b>segments</b>: straights, and bends tighter than R 500 m. Drawn arcs are used exactly; a DXF or traced road takes its bends from the curvature. A junction's area is taken out of the segments it crosses.</p>
<h4>Junctions</h4>
<p>A junction is found where a road's end lies on another road, or where two centrelines cross. Its <b>conflict area</b> is the carriageway of both roads, ±(the other road's half width + 6 m) around the crossing point. It is checked on horizontal illuminance, on a 1 m grid, against a C class (EN 13201-2) or an RC class (SANS 10098-2). The starting class is the one comparable to the main road's: M1→C0 … M6→C5, or A1→RC1 … A4→RC4. You can change it in the Junctions list.</p>
<h4>2 Poles</h4>
<p>Each luminaire row of the design is laid out along its own pole line (kerb ± setback). The spacing is measured along that line, so poles on the outside of a bend are no further apart than on the inside. On bends tighter than the set radius the spacing is multiplied by a factor; optionally only the row on the outside of the bend is kept. Poles stay out of junction mouths. Drag a pole along its kerb, or Alt-drag it off the pole line. A pole can take its own height, overhang, tilt, flux or luminaire; blank fields follow the row. <em>Send to a circuit</em> makes a street-lighting circuit from the poles in chainage order, with spans equal to the distances between consecutive poles.</p>
<h4>3 Light on the plan</h4>
<p>Every segment is cut into calculation fields of at most 40 m. In each field the EN 13201-3 grid is laid out across the road and mapped onto the plan. Along the road there are $N$ points at $D \le 3$ m (10 when the field is 30 m or shorter). Across, there are 3 points per lane for luminance, and $d \le 1.5$ m for illuminance. The same formulas as the Lighting design apply:</p>
$$E=\text{MF}\sum_i \frac{I_i(C,\gamma)\cos^{3}\gamma_i}{H_i^{2}},\qquad L=\text{MF}\sum_i \frac{I_i(C,\gamma)\;r(\beta_i,\tan\gamma_i)}{H_i^{2}}$$
<p>On a curve the geometry is what changes:</p>
<ul>
<li>A lane's observer stands 60 m before the field, measured along the road on that lane's centre line. The angle $\beta$ comes from the real plan directions.</li>
<li>Luminaires count within 5H (illuminance), or from 5H behind to 12H beyond the point (luminance), measured along the road's direction at the point.</li>
<li>The TI eye moves through the field looking along the local driving direction, 1° down.</li>
<li>Luminaires on every road light every road, so a side road's luminaires count at the junction.</li>
</ul>
<p>Each segment reports its worst field. On a straight road with evenly spaced poles the result is exactly the Lighting design's. On a bend the luminance criteria ($\bar L$, $U_o$, $U_l$, TI) are indicative, because EN 13201-3 / CIE 140 define them for a straight road. Tight bends are often designed to a C class on illuminance instead.</p>
<p>The plan shows the maintained illuminance, or the luminance, as a colour map with iso-lines. In the luminance map each point is seen from 60 m back in its own lane, in that lane's direction of travel. Hover to read a value.</p>` },

{ id: 'design-boq', group: 'design', title: 'Bill of quantities, rates & cable schedules',
  std: 'Quantities tab (last step) ▸ Bill of quantities · Cable schedules · Rate library',
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
