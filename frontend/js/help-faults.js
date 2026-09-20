/* Help articles — short circuit & faults. Rendered by help.js; TeX between $…$ / $$…$$. */
HELP_ARTICLES.push(

{ id: 'fault-iec60909', group: 'faults', title: 'Short circuit (IEC 60909)',
  std: 'IEC 60909-0:2016 · IEC TR 60909-4 · Analyse ▸ Short circuit',
  kw: 'ik3 ip ib ith kappa voltage factor c correction factor sequence',
  html: String.raw`
<p>Finds the fault current at every bus for a three-phase, single line-to-ground (SLG), line-to-line (LL) and double line-to-ground (LLG) fault. The engine works in per-unit on the project base $S_b$ (<em>Settings ▸ Base MVA</em>) and builds a positive, negative and zero-sequence impedance seen from the fault point.</p>

<h4>1 · Per-unit basis</h4>
$$Z_b=\frac{U_b^{2}}{S_b},\qquad I_b=\frac{S_b}{\sqrt3\,U_b},\qquad z_{pu}=\frac{Z_\Omega}{Z_b}$$
<p>Each bus carries its own nominal voltage $U_b$; a cable takes the voltage of the zone it sits in (set by the nearest bus), not the possibly stale <code>voltage_kv</code> on the cable itself.</p>

<h4>2 · Element impedances</h4>
<table class="help-ref-table">
<thead><tr><th>Element</th><th>Positive-sequence impedance (pu on $S_b$)</th></tr></thead>
<tbody>
<tr><td>Utility (network feeder, Eq. 15)</td><td>$z_Q=\dfrac{c\,S_b}{S''_{kQ}}$, split with $X/R$: $x_Q=z_Q\dfrac{X/R}{\sqrt{1+(X/R)^2}}$, $r_Q=x_Q/(X/R)$</td></tr>
<tr><td>Transformer</td><td>$z_T=\dfrac{u_k\%}{100}\dfrac{S_b}{S_{rT}}\,K_T$ with $K_T=\dfrac{0.95\,c_{max}}{1+0.6\,x_T}$ (§6.3.3)</td></tr>
<tr><td>Generator</td><td>$Z_{GK}=K_G\,(R_G+jX''_d)$ with $K_G=\dfrac{U_n}{U_{rG}}\dfrac{c_{max}}{1+x''_d\sin\varphi_{rG}}$ (Eq. 18). When no $X/R$ is entered, $R_G=0.15X''_d$ (≤1 kV), $0.07X''_d$ (&gt;1 kV, &lt;100 MVA) or $0.05X''_d$ (≥100 MVA)</td></tr>
<tr><td>Cable / line</td><td>$z=\dfrac{(r+jx)\,\ell}{n_{par}\,Z_b}$ — per-km values × length, divided by the number of parallel runs</td></tr>
<tr><td>Induction motor (§13)</td><td>$x=x''\dfrac{S_b}{S_{rM}}$ with $S_{rM}=\dfrac{P_r}{\eta\cos\varphi}$; $r=x/(X/R)$</td></tr>
<tr><td>Solar PV / inverter (TR 60909-4)</td><td>Current-limited: $x=\dfrac{1}{k_{fc}}\dfrac{S_b}{S_{inv}}$, $X/R=10$, with $k_{fc}$ the fault-contribution multiple (default 1.1 pu)</td></tr>
</tbody></table>
<p>The voltage factor $c$ is <strong>1.10</strong> for maximum-current studies ($c_{max}$) and 0.95 for the minimum-current basis used when checking earth-fault disconnection ($c_{min}$).</p>

<h4>3 · Fault currents</h4>
<p>With $Z_1$ the driving-point impedance from the fault node (a nodal $Z_{bus}$ solve when the network is meshed, source-path parallel when radial), and $Z_2$, $Z_0$ the negative- and zero-sequence equivalents:</p>
$$I''_{k3}=\frac{c}{|Z_1|}\,I_b\qquad
I''_{k1}=\frac{3c}{|Z_1+Z_2+Z_0|}\,I_b\qquad
I''_{kLL}=\frac{\sqrt3\,c}{|Z_1+Z_2|}\,I_b$$
$$I''_{kE2E}=\left|3I_0\right|,\quad I_1=\frac{c}{Z_1+Z_2\parallel Z_0},\quad I_0=-I_1\frac{Z_2}{Z_2+Z_0}$$
<p>If a bus has no zero-sequence path (for example it sits between delta windings) then $Z_0\to\infty$: the SLG and LLG earth currents are exactly zero. The engine never invents a path.</p>

<h4>4 · Peak, breaking and thermal currents</h4>
<p><strong>Peak</strong> current uses the R/X ratio of the fault-point impedance:</p>
$$\kappa=1.02+0.98\,e^{-3R/X},\qquad i_p=\kappa\sqrt2\,I''_{k3}$$
<p>For a meshed network (§8.1.2, method b) $\kappa$ is raised to $1.15\kappa$ and capped at 1.8 for LV (≤1 kV) or 2.0 above.</p>
<p><strong>Breaking</strong> current sums each source's contribution with its decay factor (stepped by minimum breaking time $t_{min}$ of 0.02/0.05/0.10/≥0.25 s):</p>
$$I_b=\sum_i \mu_i\,I''_{k,i}\;+\;\sum_{motors} q_j\,\mu_j\,I''_{kM,j},\qquad
\mu=a+b\,e^{-d\,I''_{kG}/I_{rG}}\ (\le 1)$$
<p>with $(a,b,d)=(0.84,0.26,0.26)$ at 20 ms, $(0.71,0.51,0.30)$ at 50 ms, $(0.62,0.72,0.32)$ at 100 ms and $(0.56,0.94,0.38)$ from 250 ms. Utility feeders far from generators have $\mu=1$. Induction-motor decay is $q=a'+b'\ln m$ with $m$ the MW per pole pair.</p>
<p><strong>Steady-state</strong> $I_k$: utilities keep $I''_k$; generators use the synchronous reactance, $I_k=c/(x_d\,S_b/S_{rG})\,I_b$; induction motors contribute zero.</p>
<p><strong>Thermal-equivalent</strong> current, for withstand checks (§12):</p>
$$I_{th}=I''_{k3}\sqrt{m+n},\qquad m=\frac{e^{4fT_k\ln(\kappa-1)}-1}{2fT_k\ln(\kappa-1)},\qquad n=1$$
<p>$n=1$ is the far-from-generator upper bound. $T_k$ is the fault duration (default 1 s).</p>

<div class="hc-example"><span class="hc-label">Worked example</span>
<p>11 kV bus fed by a utility with $S''_{kQ}=500$ MVA, $X/R=15$, $S_b=100$ MVA, 50 Hz, $c=1.10$.</p>
<p>$z_Q=1.10\times100/500=0.220$ pu, $I_b=100/(\sqrt3\cdot11)=5.249$ kA, so $I''_{k3}=1.10/0.220\times5.249=\mathbf{26.24\ kA}$ (the utility's own 500 MVA level, as it must be).</p>
<p>$\kappa=1.02+0.98e^{-3/15}=1.822$, $i_p=1.822\sqrt2\times26.24=\mathbf{67.6\ kA}$.</p>
<p>$\ln(\kappa-1)=-0.1954$, $m=0.0511$ for $T_k=1$ s, $I_{th}=26.24\sqrt{1.0511}=\mathbf{26.9\ kA}$.</p></div>

<h4>Assumptions and limits</h4>
<ul>
<li>Loads are ignored in the fault network (IEC 60909 §3.2) except rotating machines. A static load contributes only through its <code>motor_fraction</code>, modelled as an induction motor with $x''\approx1/\text{LRC}$ (default locked-rotor ratio 6).</li>
<li>Three-winding transformers are expanded to a star of three two-winding legs before the walk.</li>
<li>Zero-sequence behaviour depends on transformer grounding — see <a href="#" data-help="fault-zero-seq">Zero-sequence &amp; earthing</a>.</li>
<li>Method (c) for $\kappa$ (equivalent frequency) is not implemented.</li>
</ul>` },

{ id: 'fault-voltage-depression', group: 'faults', title: 'Voltage depression during a fault',
  std: 'IEC 60909-0 §3.6 · Z-bus method · Analyse ▸ Short circuit (single bus)',
  kw: 'retained voltage sag zbus reacceleration motor recovery',
  html: String.raw`
<p>When one bus $k$ is faulted, every other bus $j$ sags. The retained voltage comes straight from the bus-impedance matrix. For a bolted fault at $k$ with pre-fault voltage 1 pu:</p>
$$V_j = 1-\frac{Z_{jk}}{Z_{kk}}$$
<p>$Z_{kk}$ is the driving-point impedance at the fault and $Z_{jk}$ the transfer impedance to bus $j$ — the same nodal $Z_{bus}$ solve that gives $I''_k$ on meshed networks. A bus electrically close to the fault sees $Z_{jk}\approx Z_{kk}$ and collapses; a bus behind a strong source sees $Z_{jk}\ll Z_{kk}$ and stays near 1 pu.</p>
<h4>Three time periods</h4>
<p>The study is repeated with the machine reactances of each period:</p>
<table class="help-ref-table"><thead><tr><th>Period</th><th>Generators</th><th>Motors</th></tr></thead><tbody>
<tr><td>Sub-transient (0–5 cycles)</td><td>$X''_d$</td><td>contributing</td></tr>
<tr><td>Transient (~5 cycles–0.5 s)</td><td>$X'_d$</td><td>decayed</td></tr>
<tr><td>Steady state (&gt;0.5 s)</td><td>$X_d$</td><td>fully decayed</td></tr></tbody></table>
<p>Buses are colour-coded: green &gt;80 %, yellow 50–80 %, orange 30–50 %, red &lt;30 %.</p>
<h4>Motor re-acceleration</h4>
<p>After the fault clears, motors that stayed connected draw a re-acceleration current from the recovering voltage. The recovery chart integrates each motor's slip against the network's retained voltage, so it shows whether the voltage returns above the level the motors need to re-speed or stalls the bus.</p>
<div class="hc-note"><span class="hc-label">Reading it</span>Use the sub-transient column for relay and contactor drop-out questions (the deepest, shortest sag), and the steady-state column for whether sustained-fault motors will stall.</div>` },

{ id: 'fault-zero-seq', group: 'faults', title: 'Zero-sequence & earthing',
  std: 'IEC 60909-0 §6 · IEC 60364-1 (TN / TT / IT)',
  kw: 'z0 grounding transformer delta star earthed neutral earthing system tn tt it magnetising core',
  html: String.raw`
<p>Earth-fault current is set almost entirely by the zero-sequence network. That network is built differently from the positive sequence because it is broken or bridged by transformer windings and by how neutrals are earthed.</p>
<h4>Transformer zero-sequence model</h4>
<p>The transformer's <strong>grounding setting is authoritative</strong>; the vector-group letters only classify each winding:</p>
<ul>
<li><strong>Delta or zigzag</strong> winding: an internal circulation path for $I_0$ — it acts as a zero-sequence source whether or not anything is earthed.</li>
<li><strong>Star</strong> winding: passes zero-sequence current <em>only if its neutral is earthed</em> (<code>grounding_hv</code> / <code>grounding_lv</code>). An earthing impedance $Z_n$ enters the zero-sequence loop as $3Z_n$.</li>
<li>When a grounding property is absent (older projects) the engine falls back to the vector-group letter <code>n</code>, so those results are unchanged.</li>
</ul>
<p>A <strong>single-earthed star–star</strong> unit (one neutral earthed, the other floating, no delta) is <em>not</em> a through path. The earthed neutral can only source current through the core's zero-sequence magnetising branch $Z_{0m}$:</p>
$$Z_{0}\;\approx\;Z_{T0}+Z_{0m}\quad\text{with}\quad Z_{0m}\ \begin{cases}0.6\ \text{pu (unit base)} & \text{three-limb core}\\ \text{open} & \text{five-limb, shell, single-phase bank}\end{cases}$$
<p>A datasheet open-circuit zero-sequence impedance can be entered as <code>z0m_pu</code> and overrides the core-type default.</p>
<h4>Cables and sources</h4>
<p>Cables carry $r_0,x_0$ per km. If neither is entered, the fault engine falls back to a composite $Z_0\approx3Z_1$, while the unbalanced load-flow uses $3.5\times$ each component. Both engines state which fallback they used in the result notes, and choosing a library cable (armoured distribution types carry $r_0,x_0$) avoids it. Utilities use $Z_0=Z_1\times(Z_0/Z_1)$ ratio; machines use their $X_0$.</p>
<h4>LV earthing systems (IEC 60364-1)</h4>
<p>Each LV source (≤1 kV) carries an earthing system. It reshapes the earth-fault loop:</p>
<table class="help-ref-table"><thead><tr><th>System</th><th>Effect on $I''_{k1}$</th><th>Compliance consequence</th></tr></thead><tbody>
<tr><td>TN-S, TN-C-S</td><td>Metallic return through the PE/PEN: $I''_{k1}=3c/|Z_1+Z_2+Z_0|$</td><td>Disconnect on overcurrent device, checked against $Z_s$</td></tr>
<tr><td>TN-C</td><td>As TN-S</td><td>No RCD on a PEN conductor</td></tr>
<tr><td>TT</td><td>Soil return adds $3(R_A+R_B)$ to the loop; $I_{k1}$ collapses</td><td>RCD required</td></tr>
<tr><td>IT</td><td>First fault cannot circulate: $I_{k1}\approx0$</td><td>Insulation monitoring device required</td></tr></tbody></table>
<p>Absent field means TN-S, so legacy projects are unchanged.</p>` },

{ id: 'fault-line-coupling', group: 'faults', title: 'Parallel circuits, mutual coupling & conductor temperature',
  std: 'Carson (1926) earth-return · IEC 60909-0 · line_coupling.py, conductor_temp.py',
  kw: 'parallel double circuit carson mutual z0 resistance temperature overhead',
  html: String.raw`
<h4>Parallel circuits in the zero sequence</h4>
<p>Positive-sequence impedance of $n$ identical parallel circuits is simply $Z_1/n$ — the circuits are magnetically independent enough. Zero sequence is not: $I_0$ flows in phase in all three conductors and returns through earth, so two circuits on one tower are strongly coupled and the coupling <em>raises</em> the effective impedance. With each circuit carrying $I_0/n$:</p>
$$V_0=\left[Z_{0s}+(n-1)Z_{0m}\right]\frac{I_0}{n}\quad\Rightarrow\quad
Z_{0,eff}=\frac{Z_{0s}+(n-1)\,Z_{0m}}{n}$$
<p>This collapses to $Z_{0s}/n$ when $Z_{0m}=0$ and to $Z_{0s}$ when the circuits are perfectly coupled ($Z_{0m}=Z_{0s}$). Using the plain divide on a typical double-circuit MV line understates earth-fault impedance and overstates the earth-fault current by about a factor of 1.7.</p>
<h4>Mutual impedance from Carson's earth-return model</h4>
$$z_m=\pi^{2}f\cdot10^{-4}+j\,4\pi f\cdot10^{-4}\ln\frac{D_e}{D_m}\ \ \Omega/\text{km},\qquad
D_e=658.87\sqrt{\frac{\rho}{f}}\ \text{m}$$
<p>$D_m$ is the geometric-mean distance between the two circuits' conductors, $\rho$ the soil resistivity, and the zero-sequence mutual is $Z_{0m}=3z_m$.</p>
<h4>Conductor operating temperature</h4>
<p>Underground cable libraries quote resistance hot (90 °C XLPE, 70 °C PVC) while overhead conductors are quoted at 20 °C. Every engine therefore sees an overhead line's resistance corrected once, when the project is built:</p>
$$R(T)=R_{20}\left[1+\alpha\,(T-20)\right]$$
<p>with $\alpha\approx0.004$ /°C for aluminium. At the 75 °C rated conductor temperature that is about 22 % more resistance than the library figure — the amount by which overhead losses and voltage drop would otherwise be under-reported. The correction is idempotent: the 20 °C value is kept, so saving and reloading never compounds it. Underground cables are left alone.</p>` },

{ id: 'fault-series', group: 'faults', title: 'Open-conductor & simultaneous faults',
  std: 'Stevenson · Blackburn · sequence-network boundary conditions · Analyse ▸ Short circuit',
  kw: 'open conductor single phasing two conductor open simultaneous series shunt',
  html: String.raw`
<p>A <em>series</em> fault interrupts a conductor instead of shorting to earth or another phase. It is analysed with the same three sequence networks, but connected across the two ends of the break rather than at a bus. Select one cable, then run the study.</p>
<p>Each network is first reduced to its Thevenin impedance seen <em>across the break</em>: $Z_1,Z_2,Z_0$ and an open-circuit driving voltage $E$ (the pre-fault voltage across the cable).</p>
<h4>One conductor open (single-phasing)</h4>
<p>The voltage across the open phase is non-zero while the other two phases are intact, so the three sequence voltages across the break are equal. The sequence networks are connected in <strong>parallel</strong> (the series dual of an LLG shunt fault):</p>
$$I_1=\frac{E}{Z_1+\dfrac{Z_2Z_0}{Z_2+Z_0}},\qquad I_2=-I_1\frac{Z_0}{Z_2+Z_0},\qquad I_0=-I_1\frac{Z_2}{Z_2+Z_0}$$
<p>The negative- and zero-sequence currents that appear are what overheat motors and trip earth-fault relays during single-phasing.</p>
<h4>Two conductors open</h4>
<p>The two open phases carry no current, so the sequence currents are equal. The networks connect in <strong>series</strong> (the dual of an SLG shunt fault):</p>
$$I_1=I_2=I_0=\frac{E}{Z_1+Z_2+Z_0}$$
<h4>Simultaneous series + shunt fault</h4>
<p>Select a cable <em>and</em> a bus: an open conductor on the cable coincident with a ground or phase fault at the bus. The two boundary conditions couple the sequence networks through a four-port formed from the $Z_{bus}$ of each sequence, and the engine solves the combined linear boundary equations for the six sequence currents (three at the break, three at the fault):</p>
$$\mathbf{A}\,\mathbf{x}=\mathbf{b},\qquad \mathbf{x}=\big[I_1,I_2,I_0\big]_{\text{series}},\ \big[I_1,I_2,I_0\big]_{\text{shunt}}$$
<p>The rows of $\mathbf{A}$ are the series boundary equations (open-phase conditions) and the shunt boundary equations (SLG, LL or LLG at the bus) written in sequence components.</p>
<div class="hc-warn">Results assume the break sits between two energised sources of the same network. A cable that isolates a dead-end load reports no through-current change.</div>` },

{ id: 'fault-ansi', group: 'faults', title: 'ANSI/IEEE breaker duty (C37.010)',
  std: 'ANSI/IEEE C37.010-1979 · C37.06 · Analyse ▸ Short circuit ▸ ANSI duty',
  kw: 'ansi c37 e/x momentary interrupting closing latching 1.6 80% x/r 15',
  html: String.raw`
<p>Answers one question for US-rated equipment: is each ANSI circuit breaker adequate for the fault duty at its location? It uses the standard's "E/X simplified method" — the preferred method in both of C37.010's worked examples.</p>
<h4>Two reduced networks</h4>
<p>Every rotating machine contributes to both networks, but at a reactance that is a <em>multiple</em> of its $X''_d$, keyed by machine type and size (§5.4.1):</p>
<table class="help-ref-table"><thead><tr><th>Source</th><th>First-cycle (momentary)</th><th>Interrupting</th></tr></thead><tbody>
<tr><td>Utility, generator, condenser, synchronous motor*</td><td>$1.0\,X''_d$</td><td>$1.0\,X''_d$ (generators) / $1.5\,X''_d$ (sync. motors)</td></tr>
<tr><td>Induction motor &gt;1000 hp (≤1800 rpm) or &gt;250 hp (3600 rpm)</td><td>$1.0\,X''_d$</td><td>$1.5\,X''_d$</td></tr>
<tr><td>Induction motor 50 hp up to those limits</td><td>$1.2\,X''_d$</td><td>$3.0\,X''_d$</td></tr>
<tr><td>Induction motor &lt;50 hp (three-phase)</td><td colspan="2">neglected</td></tr>
<tr><td>Static load treated as motors</td><td>$1.2\,X''_d$</td><td>$3.0\,X''_d$</td></tr></tbody></table>
<h4>Duties</h4>
<p>The symmetrical current uses reactance only (resistance is disregarded — conservative), but the engine keeps a full complex reduction so the local $X/R$ is exact:</p>
$$I_{sym}=\frac{E}{X},\qquad I_{mom}=1.6\,I_{sym,\,mom},\qquad I_{int}=I_{sym,\,int}$$
<p>Closing-and-latching capability of a breaker is $1.6\,K\,I_{rated}$ ($K=1.0$ for modern preferred-rating C37.06 breakers).</p>
<h4>The 80 % / X/R rule</h4>
<ul>
<li>$I_{int}\le0.8\,I_{cap}$ → pass, no further check.</li>
<li>$I_{int}>0.8\,I_{cap}$ and $X/R\le15$ → compare directly with $100\%$ of capability.</li>
<li>$I_{int}>0.8\,I_{cap}$ and $X/R>15$ → the standard requires its more exact E/Z method with AC/DC decrement curves. That is graphical and not implemented, so the breaker is flagged <strong>REVIEW</strong> rather than silently passed or failed.</li></ul>
<p>Scope: three-phase symmetrical duty only, which is what a breaker's ANSI nameplate is expressed in. * Hydro generators without amortisseurs (0.75 $X'_d$) are not distinguished.</p>` },

{ id: 'fault-dc', group: 'faults', title: 'DC short circuit & DC load flow',
  std: 'IEC 61660-1 · IEC TR 60909-4 · Analyse ▸ Power flow ▸ DC load flow; Short circuit ▸ DC short circuit',
  kw: 'dc battery rectifier charger converter ups substation auxiliary nodal',
  html: String.raw`
<h4>DC load flow</h4>
<p>Solves node voltages on a DC bus network (UPS, telecom, substation auxiliaries). Each DC bus plus every closed device bonded to it is one node. A cable between nodes is a loop conductance and a source is a Thevenin equivalent that both grounds the island and injects a Norton current:</p>
$$\big(\mathbf{G}+\mathbf{G}_s\big)\,\mathbf{V}=\mathbf{I}_{Norton}-\mathbf{I}_{load},\qquad G_{cable}=\frac{1}{2\,r\,\ell},\quad I_{Norton}=\frac{E}{R_s}$$
<p>DC cables use the <em>loop</em> resistance $2r\ell$ (go and return). A constant-power load is linearised as $I=P/V$ and the solve repeated until the voltages settle. In normal operation an active rectifier or charger holds the bus and the battery floats at about 0 A; only when an island has no converter does the battery become the source. This avoids the non-physical charger↔battery circulating current of a naive two-EMF solve.</p>
<h4>DC short circuit</h4>
<p>The IEC 61660-1 superposition method for the two source types that dominate stationary DC systems.</p>
<p><strong>Battery</strong> — an EMF $E_B$ behind the branch resistance and inductance to the fault:</p>
$$I_{kB}=\frac{0.95\,E_B}{R_{BBr}},\qquad i_{pB}=\frac{E_B}{R_{BBr}},\qquad \tau_B=\frac{L_{BBr}}{R_{BBr}}$$
<p><strong>Converter</strong> (rectifier, charger) — current-limited, so independent of downstream resistance:</p>
$$I_{kC}=k_{dc}\,I_{rated,DC},\qquad i_{pC}\approx1.05\,I_{kC}$$
<p>Each source's branch resistance to the fault is its internal resistance plus the effective (Laplacian) resistance of the passive cable network between the source bus and the faulted bus. Partial currents are summed at the fault, which is a conservative peak.</p>
<div class="hc-warn">Converters are treated as current-limited rather than run through IEC 61660's rectifier sub-procedure (which needs the feeding AC network's data). Capacitor and DC-motor contributions are not modelled.</div>` }

);
