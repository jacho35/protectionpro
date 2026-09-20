/* Help articles — cables & circuits. Rendered by help.js; TeX between $…$ / $$…$$. */
HELP_ARTICLES.push(

{ id: 'cable-sizing', group: 'cables', title: 'Cable sizing (thermal, voltage drop, fault)',
  std: 'IEC 60364-5-52 · IEC 60364-4-43 · IEC 60949 · NEC 310.16 · Analyse ▸ Sizing & installation',
  kw: 'cable sizing ampacity derating voltage drop adiabatic fault withstand k factor i2t thermal equivalent recommended size nec',
  html: String.raw`
<p>Every cable on the single-line diagram is checked against three independent criteria, and the smallest standard size that passes all three is recommended. It reads the branch current and power factor from the load flow and the fault current from the fault study, unless you enter design values directly on the cable (<em>standalone override</em>).</p>

<h4>1 · Thermal rating</h4>
<p>The design current per cable (divided across parallel runs) must not exceed the derated ampacity:</p>
$$\frac{I_b}{n_{par}}\le I_z=I_{tab}\cdot k_{inst}\cdot k_{amb}\ \ (\cdot\,k_{grp})$$
<p>Three routes, in order of preference:</p>
<ol>
<li><strong>An applied installed-ampacity calculation</strong> on the cable (set in the properties panel, see <a href="#" data-help="cable-ampacity">Installed ampacity</a>) — its derated current is used directly and never derated again.</li>
<li><strong>NEC:</strong> $I_z=I_{310.16}\cdot k_{temp}\cdot k_{count}$ with the ambient correction (310.15(B)(1)) and the current-carrying-conductor adjustment (310.15(C)(1)) for $3n_{par}$ conductors.</li>
<li><strong>IEC (library value):</strong> $k_{inst}$ = 1.0 trefoil, 0.95 flat, 0.85 buried, and the ambient correction
$$k_{amb}=\sqrt{\frac{\theta_{max}-\theta_{amb}}{\theta_{max}-30}}$$
with $\theta_{max}=90$ °C (XLPE) or 70 °C (PVC). If the ambient is at or above $\theta_{max}$ the cable has no usable ampacity and fails.</li>
</ol>
<p>Overhead conductors use the same square-root law referenced to the library's own 40 °C ambient / 75 °C conductor pair; the installation-method table does not apply to bare conductors.</p>

<h4>2 · Voltage drop</h4>
<p>All flows are treated as lagging ($\sin\varphi\ge0$), the conservative direction:</p>
$$\Delta V_{ph}=I\,\ell\,(r\cos\varphi+x\sin\varphi),\qquad \Delta V\,[\%]=\frac{\Delta V_{ph}}{U_n/\sqrt3}\times100$$
<p>$\ell$ in km, $r,x$ in Ω/km. The power factor is the branch's own from the load flow (default 0.85). Limit default 5 %; a warning is raised between 3 % and the limit.</p>

<h4>3 · Fault withstand — the adiabatic equation</h4>
<p>During the fault the conductor heats with no time to lose heat, so the minimum cross-section is</p>
$$S\ \ge\ \frac{I_{th}\sqrt{t}}{k},\qquad I_{th}=I''_k\sqrt{m+n}$$
<p>$t$ is the clearing time of the upstream device, taken at the fault current actually flowing: for a fuse, $1.2\times$ its pre-arcing time on the gG curve (capped at 5 s, the adiabatic validity limit); for a breaker, 50 ms (MCB/MCCB) or 80 ms (ACB) in the instantaneous region, else 100 ms. $m$ is the DC heat factor from the governing bus's $\kappa$ (see <a href="#" data-help="fault-iec60909">Short circuit</a>; default $\kappa=1.8$ when none is available), and $n=1$. Using $I_{th}$ rather than the bare $I''_k$ matters: at fuse and MCCB clearing times the DC component adds 20–45 % heat, so $I''_k$ alone under-sizes the cable by 18–29 %. A per-cable option (<code>bare_isc</code>) uses $I''_k$ directly for the simpler hand-calculation basis.</p>
<table class="help-ref-table"><thead><tr><th>$k$ (A·√s/mm²)</th><th>XLPE (90 °C)</th><th>PVC (70 °C)</th><th>Bare (200 °C)</th></tr></thead><tbody>
<tr><td>Copper</td><td>143</td><td>115</td><td>129</td></tr>
<tr><td>Aluminium</td><td>94</td><td>76</td><td>84</td></tr></tbody></table>

<div class="hc-example"><span class="hc-label">Worked example</span>
<p>20 kA fault, XLPE copper, cleared in 0.5 s at $\kappa=1.8$, 50 Hz.</p>
$$\ln(\kappa-1)=-0.2231,\quad m=\frac{e^{4(50)(0.5)(-0.2231)}-1}{2(50)(0.5)(-0.2231)}=0.0896,\quad I_{th}=20\sqrt{1.0896}=20.9\ \text{kA}$$
$$S_{min}=\frac{20\,877\times\sqrt{0.5}}{143}=\mathbf{103\ mm^2}\ \Rightarrow\ \text{use 120 mm}^2$$</div>

<h4>Verdict</h4>
<ul>
<li><strong>Fail</strong> — any criterion breached. The recommendation is the smallest library size (same conductor and insulation) satisfying thermal, voltage drop and withstand.</li>
<li><strong>Warning</strong> — thermal loading above 80 %, or voltage drop within 3 % of the limit.</li>
<li><strong>Unknown</strong> — ampacity unset or load flow not run; never a silent pass.</li>
</ul>
<p>Cable resistance in the library is hot (90 °C XLPE, 70 °C PVC): $R_{op}=R_{20}[1+\alpha(\theta-20)]$ with $\alpha_{Cu}=0.00393$, $\alpha_{Al}=0.00403$ per K, i.e. ×1.275 (Cu) / ×1.282 (Al) at 90 °C and ×1.20 at 70 °C.</p>` },

{ id: 'cable-ampacity', group: 'cables', title: 'Installed ampacity (IEC 60364-5-52)',
  std: 'IEC 60364-5-52 Tables B.52.2–B.52.5, B.52.14, B.52.15, B.52.17 · Cable properties ▸ Ampacity',
  kw: 'installed current carrying capacity derating installation method a1 b1 c d1 d2 e f g ambient grouping soil resistivity depth',
  html: String.raw`
<p>A cable's tabulated current-carrying capacity assumes reference conditions. The installed ampacity corrects it for the real ones by multiplying <em>independent</em> factors:</p>
$$I_z=I_{tab}(S,\ \text{method},\ \text{conductor},\ \text{insulation})\cdot k_{temp}\cdot k_{grp}\cdot k_{soil}\cdot k_{depth}$$
<p>Reference conditions: 30 °C ambient air, 20 °C ground, soil thermal resistivity 2.5 K·m/W, burial depth 0.7 m.</p>
<h4>Installation methods (Table B.52.1)</h4>
<table class="help-ref-table"><thead><tr><th>Method</th><th>Description</th><th>Environment</th></tr></thead><tbody>
<tr><td>A1 / A2</td><td>Conductors / multicore cable in conduit in a thermally insulating wall</td><td>air</td></tr>
<tr><td>B1 / B2</td><td>Conductors / multicore cable in conduit on a wall or in trunking</td><td>air</td></tr>
<tr><td>C</td><td>Cable clipped direct to a wall</td><td>air</td></tr>
<tr><td>D1 / D2</td><td>Multicore cable in underground duct / direct buried</td><td>ground</td></tr>
<tr><td>E / F / G</td><td>Single-core cables on perforated tray touching / spaced / spaced from wall</td><td>air</td></tr></tbody></table>
<h4>The correction factors</h4>
<ul>
<li>$k_{temp}$ — ambient air temperature (or ground temperature for D1/D2), per insulation: PVC 1.22 at 10 °C, 1.00 at 30 °C, 0.87 at 40 °C, 0.71 at 50 °C, 0.50 at 60 °C; XLPE is flatter. Linearly interpolated between table points.</li>
<li>$k_{grp}$ — grouping. Per arrangement (bunched, single layer on wall / floor / tray touching / tray spaced, trefoil): for bunched, 1 circuit 1.00, 2 → 0.80, 3 → 0.70, 4 → 0.65, 5 → 0.60, 6 → 0.57, 9 → 0.50, 12 → 0.45, 20 → 0.38.</li>
<li>$k_{soil}$ — soil thermal resistivity (buried only), relative to 2.5 K·m/W.</li>
<li>$k_{depth}$ — burial depth (buried only), relative to 0.7 m.</li>
</ul>
<p>The result panel prints where the number came from, for example <code>B1 · PVC · 40 °C air ×0.87 · 3 circuit(s) bunched ×0.70 · combined ×0.609</code>, so a derated ampacity is never a bare number.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>16 mm² PVC copper, method B1 (base 76 A), 40 °C ambient, three circuits bunched together:</p>
$$I_z=76\times0.87\times0.70=76\times0.609=\mathbf{46.3\ A}$$
<p>A 50 A breaker would violate $I_n\le I_z$; a 40 A breaker is the largest standard rating that complies.</p></div>
<p>This table family is installed <em>current capacity</em>. It is different from the conductor R/X library used for volt drop and fault current, and values must never be copied between them.</p>` },

{ id: 'cable-dbcheck', group: 'cables', title: 'Distribution-board circuit check',
  std: 'IEC 60364-5-52 · 4-43 §433.1 · 4-41 · 5-54 Table 54.7 · SANS 10142-1 Cl. 5.5.2, 5.5.6, 6.6 · Schedules ▸ Check circuits',
  kw: 'db board way circuit schedule ib in iz ecc zs earth loop rcd magnetic trip breaker curve b c d voltage drop',
  html: String.raw`
<p>Checks every way of every board in the Schedules workspace. The SLD cable sizing only looks at cables on the diagram; this closes the gap for the tens of ways behind each board. Four verdicts per way — <em>ampacity &amp; coordination</em>, <em>voltage drop</em>, <em>earth conductor</em> and <em>earth-fault loop</em> — combine to the worst.</p>

<h4>1 · Ampacity and coordination</h4>
<p>$I_z$ is the derated installed ampacity of the way's cable (see <a href="#" data-help="cable-ampacity">Installed ampacity</a>). The design chain of IEC 60364-4-43 §433.1 is</p>
$$I_b\ \le\ I_n\ \le\ I_z$$
<p>Fail if $I_b>I_n$ or $I_n>I_z$; warning if $I_n>0.9I_z$ (little margin for future derating). $I_b$ is the way's design current from its load: $\dfrac{S}{\sqrt3\,U_{LL}}$ three-phase or $\dfrac{S}{U_{ph}}$ single-phase.</p>

<h4>2 · Voltage drop</h4>
<p>A single-phase way is a two-conductor loop, so it doubles; a three-phase way uses the $\sqrt3$ line-to-line form. With $z_{eff}=r\cos\varphi+x\sin\varphi$ (lagging, default $\cos\varphi=0.9$):</p>
$$\Delta V_{3\phi}=\sqrt3\,I_b\,\ell\,z_{eff},\ \ \%=\frac{\Delta V}{U_{LL}}\times100;\qquad
\Delta V_{1\phi}=2\,I_b\,\ell\,z_{eff},\ \ \%=\frac{\Delta V}{U_{ph}}\times100$$
<p>The gate is the <em>total</em> from the point of supply — this way plus the upstream drop from the load flow when it has been run — against 3 % (lighting) or 5 % (general); otherwise the way alone is shown, with a note to run load flow for the cumulative figure. Warning within 10 % of the limit.</p>

<h4>3 · Earth continuity conductor (Table 54.7)</h4>
$$S_{ECC}\ge\begin{cases}S & S\le16\ \text{mm}^2\\ 16 & 16<S\le35\\ S/2\ (\text{rounded up to a preferred size}) & S>35\end{cases}$$
<p>This is the <em>selection</em> rule. The adiabatic alternative (§543.1.1) is not yet evaluated.</p>

<h4>4 · Earth-fault loop and disconnection</h4>
<p>For a TN single-line-to-ground fault, $I_{k1}=\sqrt3\,c\,U_n/|Z_1+Z_2+Z_0|$ and the loop impedance the standard means is $Z_s=U_0/I_{k1}$; with $U_0=U_n/\sqrt3$ that is exactly</p>
$$Z_s=\frac{|Z_1+Z_2+Z_0|}{3}$$
<p>The engine takes the supply impedance at the board (from the network's sequence impedances, or a measured $Z_e$ you enter) and adds the way's own phase and ECC conductor resistance:</p>
$$Z_s=Z_{supply}+r_{ph}\,\ell+r_{ECC}\,\ell,\qquad I_{ef}=\frac{c_{min}\,U_0}{Z_s},\quad c_{min}=0.95$$
<p>Disconnection within the IEC 60364-4-41 time (0.4 s final circuits ≤ 32 A; 5 s distribution circuits) is guaranteed when the breaker's <em>instantaneous</em> trip current is reached. The upper limit of each IEC 60898-1 magnetic band is used — the current at which operation is <em>guaranteed</em>, not merely possible:</p>
$$I_a=k_{mag}\,I_n,\quad k_{mag}=5\ (\text{B}),\ 10\ (\text{C}),\ 20\ (\text{D});\qquad \text{pass if }I_{ef}\ge I_a\iff Z_s\le Z_{s,max}=\frac{c_{min}U_0}{I_a}$$
<p>If the magnetic trip is not reached, an <strong>RCD</strong> on the way is the alternative route: it complies when $Z_s\le50\,\text{V}/I_{\Delta n}$. The report states which route passed. When no ECC is declared the required minimum is assumed — the highest-resistance compliant conductor, so a pass on the assumption holds for whatever is installed.</p>
<p>Conductor resistance is the hot value (operating temperature), and fault current uses the <em>minimum</em> basis (IEC 60909-0 §5.3.1) — a maximum-current basis overstates $I_{ef}$ and passes circuits the standard fails.</p>

<div class="hc-example"><span class="hc-label">Worked example</span>
<p>A 230 V single-phase way: 16 mm² PVC copper, 45 m, 40 A type-C breaker, $I_b=32$ A, $\cos\varphi=0.9$, $Z_e=0.30\ \Omega$, ECC 16 mm².</p>
$$z_{eff}=1.38(0.9)+0.079(0.436)=1.276\ \Omega/\text{km},\quad \Delta V=2(32)(0.045)(1.276)=3.68\ \text{V}=\mathbf{1.60\%}$$
$$Z_s=0.30+2(1.38)(0.045)=0.424\ \Omega,\quad I_{ef}=\frac{0.95\times230}{0.424}=515\ \text{A}\ \ge\ I_a=10\times40=400\ \text{A}\ \Rightarrow\ \textbf{pass}$$
<p>$Z_{s,max}=0.95\times230/400=0.546\ \Omega$.</p></div>
<p>Missing inputs give an <em>info</em> verdict with a note on how to supply them — never a silent pass.</p>` },

{ id: 'cable-raceway', group: 'cables', title: 'Conduit fill & grouping derating',
  std: 'NEC Chapter 9 Table 1 · IEC 60364-5-52 Table B.52.17 · Analyse ▸ Sizing & installation',
  kw: 'conduit fill jam ratio raceway grouping derating cable outside diameter',
  html: String.raw`
<p>Checks each underground raceway (conduit with assigned cables) three ways.</p>
<h4>1 · Conduit fill</h4>
$$\text{fill}=\frac{\sum_i\pi\,OD_i^{2}/4}{\pi\,ID^{2}/4}\times100\%\ \le\ \begin{cases}53\% & 1\ \text{cable}\\31\% & 2\ \text{cables}\\40\% & 3\ \text{or more}\end{cases}$$
<p>Cable outside diameter is the explicit <code>od_mm</code> if given, else a typical 3/4-core Cu XLPE SWA OD estimated from the conductor size — the result flags when the estimate was used, since manufacturer data governs.</p>
<h4>2 · Jam ratio</h4>
<p>For exactly three cables of similar diameter pulled together, they can wedge across the conduit at a bend:</p>
$$JR=1.05\,\frac{ID}{OD_{avg}}$$
<p>(the 1.05 allows for conduit ovality). A ratio between <strong>2.8 and 3.2</strong> risks jamming.</p>
<h4>3 · Grouping derating</h4>
<p>IEC 60364-5-52 Table B.52.17, reference method (bunched in conduit, item 1): each multicore cable counts as one circuit, and the factor applies to every cable's ampacity in the group:</p>
$$I_z'=I_z\cdot k_{grp}(n),\qquad k_{grp}=1.00,\ 0.80,\ 0.70,\ 0.65,\ 0.60,\ 0.57\ \ (n=1\ldots6)$$
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>Three cables of 32 mm OD in a 100 mm conduit (ID 100 mm): fill $=3\times32^2/100^2=30.7\%\le40\%$ ✓. Jam ratio $=1.05\times100/32=3.28$, just above the 3.2 upper bound ✓. Grouping: $k_{grp}(3)=0.70$.</p></div>` },

{ id: 'cable-diversity', group: 'cables', title: 'Load diversity & demand factors',
  std: 'IEC 61439 · IEC 60364 · Analyse ▸ Sizing & installation',
  kw: 'demand factor maximum demand coincidence diversity installed load transformer utilisation',
  html: String.raw`
<p>Not every installed load runs at once. This study converts installed load into the <em>maximum demand</em> the supply must actually carry, per load, per bus and per transformer.</p>
<h4>Per load</h4>
$$S_{demand}=S_{installed}\times DF,\qquad S_{installed}=\frac{P_r}{\eta\cos\varphi}\ (\text{motors, input power})$$
<p>$DF$ is the load's <code>demand_factor</code>. Recommended values by category (IEC 61439 / 60364):</p>
<table class="help-ref-table"><thead><tr><th>Category</th><th>$DF$</th><th>Category</th><th>$DF$</th></tr></thead><tbody>
<tr><td>Lighting</td><td>1.0</td><td>Motor group 5–10</td><td>0.6</td></tr>
<tr><td>Heating / air-conditioning</td><td>1.0</td><td>Motor group &gt;10</td><td>0.5</td></tr>
<tr><td>Socket outlets</td><td>0.4</td><td>Welding</td><td>0.3</td></tr>
<tr><td>Single motor (largest)</td><td>1.0</td><td>Lifts and cranes</td><td>0.5</td></tr>
<tr><td>Motor group 2–4</td><td>0.8</td><td>Cooking</td><td>0.8</td></tr>
<tr><td>Mixed commercial</td><td>0.7</td><td>Mixed industrial</td><td>0.6</td></tr></tbody></table>
<h4>Per bus — coincidence</h4>
<p>On top of the per-load factors, a group coincidence factor $K_s\le1$ reflects that many loads seldom peak together. It depends on the number of loads $N$ on the bus, linearly interpolated from</p>
<table class="help-ref-table"><thead><tr><th>$N$</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>8</th><th>10</th><th>15</th><th>20</th><th>30</th><th>50</th></tr></thead><tbody>
<tr><td>$K_s$</td><td>1.00</td><td>0.90</td><td>0.85</td><td>0.80</td><td>0.78</td><td>0.75</td><td>0.72</td><td>0.70</td><td>0.65</td><td>0.60</td><td>0.57</td><td>0.52</td></tr></tbody></table>
$$S_{max}=K_s\sum S_{demand},\qquad I_{max}=\frac{S_{max}}{\sqrt3\,U},\qquad DF_{eff}=\frac{S_{max}}{\sum S_{installed}}$$
<p>(The result key is called <em>diversity factor</em> for API compatibility, but it is the coincidence factor $K_s$; the classical diversity factor is its reciprocal, $\ge1$.)</p>
<h4>Per transformer</h4>
<p>Only the LV-side (load-side) buses are counted, to avoid double-counting through the HV winding. Utilisation is the diversified demand divided by the nameplate, and compared with the installed-load utilisation so the margin the diversity buys is visible.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>10 loads of 50 kVA installed on one bus, each with $DF=0.8$: $\sum S_{demand}=10\times40=400$ kVA; $K_s(10)=0.70$ so $S_{max}=\mathbf{280\ kVA}$ against 500 kVA installed ($DF_{eff}=0.56$). On a 400 V bus, $I_{max}=280/(\sqrt3\times0.4)=404$ A.</p></div>` }

);
