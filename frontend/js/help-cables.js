/* Help articles — cables & circuits. Rendered by help.js; TeX between $…$ / $$…$$. */
HELP_ARTICLES.push(

{ id: 'cable-sizing', group: 'cables', title: 'Cable sizing (thermal, voltage drop, fault)',
  std: 'IEC 60364-5-52 · IEC 60364-4-43 · IEC 60949 · NEC 310.16 · Analyse ▸ Sizing & installation',
  kw: 'cable sizing ampacity derating voltage drop adiabatic fault withstand k factor i2t thermal equivalent recommended size nec',
  html: String.raw`
<p>Every cable on the single-line diagram is checked against four criteria — thermal rating, overload protection, voltage drop and fault withstand — and the smallest standard size that passes them all is recommended. It reads the branch current and power factor from the load flow and the fault current from the fault study, unless you enter design values directly on the cable (<em>standalone override</em>).</p>

<h4>1 · Thermal rating</h4>
<p>The design current per cable (divided across parallel runs) must not exceed the derated ampacity:</p>
$$\frac{I_b}{n_{par}}\le I_z=I_{tab}\cdot k_{inst}\cdot k_{amb}\ \ (\cdot\,k_{grp})$$
<p>Three routes, in order of preference:</p>
<ol>
<li><strong>An applied installed-ampacity calculation</strong> on the cable (set in the properties panel, see <a href="#" data-help="cable-ampacity">Installed ampacity</a>) — the study recomputes it from the saved installation conditions with the IEC 60364-5-52 tables (so a rating saved before a table correction updates itself, with a note) and never derates it again.</li>
<li><strong>NEC:</strong> $I_z=I_{310.16}\cdot k_{temp}\cdot k_{count}$ with the ambient correction (310.15(B)(1)) and the current-carrying-conductor adjustment (310.15(C)(1)) for $3n_{par}$ conductors.</li>
<li><strong>IEC (library value):</strong> the library rating times the ambient correction $k_{amb}$ from IEC 60364-5-52 Table B.52.14 (air, 30 °C reference) — or B.52.15 (ground, 20 °C reference) for a buried run — interpolated. No installation-method or grouping factor is applied on this route, and the result says so: use the installed-ampacity calculator for those. If the ambient is at or above the insulation's maximum (90 °C XLPE, 70 °C PVC) the cable has no usable ampacity and fails.</li>
</ol>
<p>Overhead conductors scale the library's in-air rating with a square-root law referenced to its own 40 °C ambient / 75 °C conductor pair. IEC 60364 does not cover bare conductors; this approximates a heat-balance rating (IEEE 738) and is labelled as such in the result.</p>

<h4>2 · Overload protection (LV)</h4>
<p>IEC 60364-4-43 §433.1: the protective device must suit the cable,</p>
$$I_b\le I_n\le I_z,\qquad I_2\le1.45\,I_z$$
<p>with $I_z$ the installed rating of all parallel conductors (§433.4), $I_n$ a breaker's current setting $I_r$ (trip rating × thermal pickup) or a fuse's rating, and $I_2$ the conventional operating current: 1.45 $I_n$ for an IEC 60898 MCB, 1.30 $I_n$ for an IEC 60947-2 MCCB/ACB, 1.6 $I_n$ for a gG fuse ≥ 16 A (1.9 for 4–16 A). Checked for cables up to 1 kV protected by a breaker's own trip unit or a fuse; a relay-tripped breaker is shown as not applicable.</p>

<h4>3 · Voltage drop</h4>
<p>The drop across the cable itself, with all flows treated as lagging ($\sin\varphi\ge0$):</p>
$$\Delta V_{ph}=I\,\ell\,(r\cos\varphi+x\sin\varphi),\qquad \Delta V\,[\%]=\frac{\Delta V_{ph}}{U_n/\sqrt3}\times100$$
<p>$\ell$ in km, $r,x$ in Ω/km, and $U_n$ the nominal voltage of the buses the cable connects — not the cable's own voltage class (an 11 kV-class cable on a 3.3 kV feeder drops against 3.3 kV). The limit, though, applies from the <strong>origin of the installation</strong> (IEC 60364-5-52 §525, Table G.52.1: 3 % lighting / 5 % other from a public LV supply, 6 % / 8 % from a private transformer): the drop from the bus fed by the source or transformer down to the cable's far end, read from the load-flow voltages and shown as Σ. Default limit 5 %; a warning is raised above 60 % of it.</p>

<h4>4 · Fault withstand — the adiabatic equation</h4>
<p>During the fault the conductor heats with no time to lose heat, so the minimum cross-section is</p>
$$S\ \ge\ \frac{I_{th}\sqrt{t}}{k},\qquad I_{th}=I''_k\sqrt{m+n}$$
<p>IEC 60364-4-43 §434.5.2 requires this for a fault at <em>any</em> point, so it is checked twice: at the <strong>largest</strong> fault current of any type (three-phase, earth fault, line-to-line, double-earth) at the cable's ends, and at the <strong>smallest</strong> far-end fault (IEC 60909 $c_{min}$, cables at their end-of-fault temperature per §2.5 eq. 3: PVC 160 °C, XLPE 250 °C), where a time-inverse device is slowest. $t$ is the upstream device's clearing time at each current, from the same device models as the protection and arc-flash studies: an overcurrent relay's IEC 60255-151 curve through its CT plus breaker opening time, a breaker's own trip unit (instantaneous, short-time or long-time region; the instantaneous region clears in 0.025 s for an MCB/MCCB and 0.05 s for an ACB, IEEE 1584 Table 1), or $1.2\times$ a gG fuse's pre-arcing time. A fault the device does not clear within 5 s (the adiabatic validity limit) fails — except at the far end when overload protection is coordinated (§435.1). With no device modelled, 100 ms is assumed and flagged. $m$ is the DC heat factor from the governing bus's $\kappa$ (see <a href="#" data-help="fault-iec60909">Short circuit</a>; default $\kappa=1.8$ when none is available), and $n=1$. Using $I_{th}$ rather than the bare $I''_k$ matters: at fuse and MCCB clearing times the DC component adds 20–45 % heat, so $I''_k$ alone under-sizes the cable by 18–29 %. A per-cable option (<code>bare_isc</code>) uses $I''_k$ directly for the simpler hand-calculation basis.</p>
<table class="help-ref-table"><thead><tr><th>$k$ (A·√s/mm²)</th><th>XLPE (90 °C)</th><th>PVC ≤ 300 mm²</th><th>PVC &gt; 300 mm²</th><th>Bare (200 °C)</th></tr></thead><tbody>
<tr><td>Copper</td><td>143</td><td>115</td><td>103</td><td>129</td></tr>
<tr><td>Aluminium</td><td>94</td><td>76</td><td>68</td><td>84</td></tr></tbody></table>
<p>An insulation outside the table takes the conductor's PVC value (the lowest), with a warning.</p>

<div class="hc-example"><span class="hc-label">Worked example</span>
<p>20 kA fault, XLPE copper, cleared in 0.5 s at $\kappa=1.8$, 50 Hz.</p>
$$\ln(\kappa-1)=-0.2231,\quad m=\frac{e^{4(50)(0.5)(-0.2231)}-1}{2(50)(0.5)(-0.2231)}=0.0896,\quad I_{th}=20\sqrt{1.0896}=20.9\ \text{kA}$$
$$S_{min}=\frac{20\,877\times\sqrt{0.5}}{143}=\mathbf{103\ mm^2}\ \Rightarrow\ \text{use 120 mm}^2$$</div>

<h4>Verdict</h4>
<ul>
<li><strong>Fail</strong> — any criterion breached. The recommendation is the smallest library size (same conductor, insulation and voltage class) satisfying all four.</li>
<li><strong>Warning</strong> — thermal loading above 80 %, or voltage drop from the origin above 60 % of the limit.</li>
<li><strong>Unknown</strong> — ampacity unset or load flow not run; never a silent pass.</li>
</ul>
<p>Cable resistance in the library is hot (90 °C XLPE, 70 °C PVC): $R_{op}=R_{20}[1+\alpha(\theta-20)]$ with $\alpha_{Cu}=0.00393$, $\alpha_{Al}=0.00403$ per K, i.e. ×1.275 (Cu) / ×1.282 (Al) at 90 °C and ×1.20 at 70 °C.</p>` },

{ id: 'cable-ampacity', group: 'cables', title: 'Installed ampacity (IEC 60364-5-52)',
  std: 'IEC 60364-5-52 Tables B.52.2–B.52.5, B.52.10–B.52.19 · Cable properties ▸ Ampacity',
  kw: 'installed current carrying capacity derating installation method a1 a2 b1 b2 c d1 d2 e f g ambient grouping soil resistivity loaded conductors single phase three phase',
  html: String.raw`
<p>A cable's tabulated current-carrying capacity assumes reference conditions. The installed ampacity corrects it for the real ones by multiplying <em>independent</em> factors:</p>
$$I_z=I_{tab}(S,\ \text{method},\ \text{conductor},\ \text{insulation},\ n_{loaded})\cdot k_{temp}\cdot k_{grp}\cdot k_{soil}$$
<p>Reference conditions: 30 °C ambient air, 20 °C ground, soil thermal resistivity 2.5 K·m/W, burial depth 0.7 m.</p>
<h4>Loaded conductors</h4>
<p>The standard tabulates each method twice: <strong>two loaded conductors</strong> for a single-phase circuit (Tables B.52.2 PVC, B.52.3 XLPE) and <strong>three</strong> for a three-phase circuit (B.52.4, B.52.5) — a three-phase cable runs hotter, so its rating is roughly 10–15 % lower. SLD cables are three-phase; a DB way uses two or three by its pole count. Methods E–G come from Tables B.52.10–B.52.13.</p>
<h4>Installation methods (Table B.52.1)</h4>
<table class="help-ref-table"><thead><tr><th>Method</th><th>Description</th><th>Environment</th></tr></thead><tbody>
<tr><td>A1 / A2</td><td>Conductors / multi-core cable in conduit in a thermally insulated wall</td><td>air</td></tr>
<tr><td>B1 / B2</td><td>Conductors / multi-core cable in conduit on a wall or in trunking</td><td>air</td></tr>
<tr><td>C</td><td>Cable clipped direct to a wall</td><td>air</td></tr>
<tr><td>D1 / D2</td><td>Cable in ducts in the ground / direct in the ground</td><td>ground</td></tr>
<tr><td>E</td><td>Multi-core cable in free air</td><td>air</td></tr>
<tr><td>F</td><td>Single-core cables touching in free air (trefoil for three loaded)</td><td>air</td></tr>
<tr><td>G</td><td>Single-core cables spaced in free air (three loaded only)</td><td>air</td></tr></tbody></table>
<p>Where the standard has no value (methods A–D above 300 mm², F and G below 25 mm², G single-phase) the calculator says so rather than inventing one.</p>
<h4>The correction factors</h4>
<ul>
<li>$k_{temp}$ — ambient air temperature (Table B.52.14), or ground temperature for D1/D2 (B.52.15), per insulation: PVC 1.22 at 10 °C, 1.00 at 30 °C, 0.87 at 40 °C, 0.71 at 50 °C, 0.50 at 60 °C; XLPE is flatter. Linearly interpolated between table points.</li>
<li>$k_{grp}$ — grouping, from the table for the method: <strong>B.52.17</strong> in air (bunched; single layer on wall/floor; under a wooden ceiling; on perforated tray; on ladder or cleats), <strong>B.52.18</strong> direct in the ground (touching, one diameter, 0.125 / 0.25 / 0.5 m apart), <strong>B.52.19</strong> in ducts (multi- or single-core, touching to 1 m apart). Bunched: 1 circuit 1.00, 2 → 0.80, 3 → 0.70, 6 → 0.57, 9 → 0.50, 12 → 0.45, 20 → 0.38. A count between listed values takes the <em>next listed count up</em> (10 circuits use the 12-circuit factor) — the standard does not interpolate.</li>
<li>$k_{soil}$ — soil thermal resistivity (buried only), relative to 2.5 K·m/W, Table B.52.16. Its values are for cables in ducts; for cables direct in the ground IEC notes they would be higher, so using them there is conservative.</li>
</ul>
<p>IEC 60364-5-52 has no depth-of-laying factor, so none is applied.</p>
<p>The result panel prints where the number came from, for example <code>3 loaded conductors · B1 · PVC · 40 °C air ×0.87 · 3 circuit(s) Bunched ×0.70 · combined ×0.609</code>, so a derated ampacity is never a bare number.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>16 mm² PVC copper, method B1, 40 °C ambient, three circuits bunched together ($k=0.87\times0.70=0.609$):</p>
$$\text{single-phase (B.52.2, 76 A):}\ I_z=76\times0.609=\mathbf{46.3\ A}\qquad \text{three-phase (B.52.4, 68 A):}\ I_z=68\times0.609=\mathbf{41.4\ A}$$
<p>On the single-phase circuit a 40 A breaker is the largest standard rating that satisfies $I_n\le I_z$; on the three-phase circuit it still does (40 ≤ 41.4), with far less margin.</p></div>
<p>This table family is installed <em>current capacity</em>. It is different from the conductor R/X library used for volt drop and fault current, and values must never be copied between them.</p>` },

{ id: 'cable-dbcheck', group: 'cables', title: 'Distribution-board circuit check',
  std: 'IEC 60364-5-52 Annex G · 4-43 §433.1 · 4-41 §411.4/411.5 · 5-54 §543.1, Tables 54.3/54.7 · SANS 10142-1 Cl. 5.5.2, 5.5.6, 6.6 · Schedules ▸ Check circuits',
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
<p>The gate is the <em>total</em> from the <strong>origin of the installation</strong> — the bus of the board's voltage zone fed by the source or transformer — i.e. this way plus $V_{origin}-V_{board}$ from the load flow (not the drop from 1.0 p.u., which would count MV and transformer drop, or miss drop when the supply sits above 1.0 p.u.). Limits per IEC 60364-5-52 Table G.52.1, chosen per board in the Schedules toolbar: public LV supply 3 % lighting / 5 % other, private supply (own transformer or generator) 6 % / 8 %. Without a load flow the way alone is shown, with a note. Warning within 10 % of the limit.</p>

<h4>3 · Earth continuity conductor (IEC 60364-5-54 §543.1)</h4>
<p>An ECC complies by either route. The <em>selection</em> rule, Table 54.7:</p>
$$S_{ECC}\ge\begin{cases}S & S\le16\ \text{mm}^2\\ 16 & 16<S\le35\\ S/2\ (\text{rounded up to a preferred size}) & S>35\end{cases}$$
<p>or the <em>adiabatic</em> calculation, §543.1.2 — which is how the reduced earth of a twin-and-earth cable (2.5/1.5, 4/1.5, 6/2.5 mm²) complies:</p>
$$S_{ECC}\ge\frac{\sqrt{I^2t}}{k},\qquad I=\frac{c_{max}U_0}{Z_s},\quad t=\begin{cases}0.1\ \text{s} & \text{MCB instantaneous trip reached}\\ 0.3\ \text{s} & \text{earth-leakage unit}\\ \text{declared} & \text{time from the device's curve}\end{cases}$$
<p>$k$ from Table 54.3 for a conductor in the cable: 115 Cu/PVC, 143 Cu/XLPE, 76 Al/PVC, 94 Al/XLPE. If the protection does not operate there is no $t$ and only the table can pass the conductor. With no ECC entered the check assumes the smallest size that complies by either route, and warns when the twin-and-earth CPC for that cable size would fail the loop check — enter the installed ECC.</p>

<h4>4 · Earth-fault loop and disconnection</h4>
<p>For a TN single-line-to-ground fault, $I_{k1}=\sqrt3\,c\,U_n/|Z_1+Z_2+Z_0|$ and the loop impedance the standard means is $Z_s=U_0/I_{k1}$; with $U_0=U_n/\sqrt3$ that is exactly</p>
$$Z_s=\frac{|Z_1+Z_2+Z_0|}{3}$$
<p>The engine takes the supply impedance at the board (from the network's sequence impedances, or a measured $Z_e$ you enter) and adds the way's own phase and ECC conductor resistance:</p>
$$Z_s=Z_{supply}+r_{ph}\,\ell+r_{ECC}\,\ell,\qquad I_{ef}=\frac{c_{min}\,U_0}{Z_s},\quad c_{min}=0.95$$
<p>Disconnection within the IEC 60364-4-41 time (0.4 s final circuits ≤ 32 A; 5 s distribution circuits) is guaranteed when the breaker's <em>instantaneous</em> trip current is reached. The upper limit of each IEC 60898-1 magnetic band is used — the current at which operation is <em>guaranteed</em>, not merely possible:</p>
$$I_a=k_{mag}\,I_n,\quad k_{mag}=5\ (\text{B}),\ 10\ (\text{C}),\ 20\ (\text{D});\qquad \text{pass if }I_{ef}\ge I_a\iff Z_s\le Z_{s,max}=\frac{c_{min}U_0}{I_a}$$
<p>If the magnetic trip is not reached, an <strong>RCD</strong> on the way is the alternative route. In a TN system (§411.4.4) it complies when $Z_s\,I_{\Delta n}\le U_0$; in a TT system (§411.5.3) when $R_A\,I_{\Delta n}\le50$ V — tested on $Z_s$, which is never less than $R_A$. The earthing system is taken from the source or transformer feeding the board. For a way that reaches neither, a disconnection time read off the device's curve (entered per way) passes if it is within the limit — IEC 60898-1 alone guarantees operation only at its conventional points, so the thermal region is not credited without it. The report states which route passed. $Z_s$ adds the way's $R_1+R_2$ to the complex supply impedance.</p>
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
