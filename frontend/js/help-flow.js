/* Help articles — load flow & network studies. Rendered by help.js; TeX between $…$ / $$…$$. */
HELP_ARTICLES.push(

{ id: 'flow-loadflow', group: 'flow', title: 'Load flow (Newton-Raphson / Gauss-Seidel)',
  std: 'Stevenson · Glover · Analyse ▸ Power flow',
  kw: 'power flow ybus jacobian swing slack pv pq tap transformer islands dispatch thevenin',
  html: String.raw`
<p>Finds the steady-state voltage magnitude and angle at every bus for the specified generation and load, then derives branch flows, currents, loading and losses. Everything is per-unit on the project base $S_b$.</p>

<h4>1 · Network model — the bus admittance matrix</h4>
<p>Buses joined only by closed switches, breakers and fuses are merged into one node. Each series branch (cable, transformer) has $y=1/z$. A transformer with off-nominal tap ratio $t$ on the side of bus $i$ is stamped as</p>
$$Y_{ii}\mathrel{+}=\frac{y}{t^{2}},\quad Y_{jj}\mathrel{+}=y,\quad Y_{ij}=Y_{ji}\mathrel{-}=\frac{y}{t}$$
<p>and a plain series element as $Y_{ii},Y_{jj}\mathrel{+}=y$, $Y_{ij}=Y_{ji}\mathrel{-}=y$. Branch impedances are:</p>
$$z_{cable}=\frac{(r+jx)\,\ell}{n_{par}\,Z_b},\qquad
z_{xfmr}=\frac{u_k\%}{100}\,\frac{S_b}{S_r}\ \Rightarrow\ x=z\,\frac{X/R}{\sqrt{1+(X/R)^2}},\ \ r=\frac{x}{X/R}$$
<p>A chain of cables and transformers between two real buses with no bus in between is reduced <em>exactly</em> by Kron elimination of its internal nodes, so each cable's impedance is referred through the correct local tap ratio, however many transformers the chain cascades.</p>

<h4>2 · Bus types</h4>
<table class="help-ref-table"><thead><tr><th>Type</th><th>Specified</th><th>Solved for</th></tr></thead><tbody>
<tr><td>Swing (utility / reference)</td><td>$|V|,\ \theta$</td><td>$P,\ Q$</td></tr>
<tr><td>PV (generator, regulating inverter)</td><td>$P,\ |V|$</td><td>$Q,\ \theta$</td></tr>
<tr><td>PQ (load)</td><td>$P,\ Q$</td><td>$|V|,\ \theta$</td></tr></tbody></table>

<h4>3 · Newton-Raphson</h4>
<p>The power injected at bus $i$ is</p>
$$P_i=\sum_j|V_i||V_j|\big(G_{ij}\cos\theta_{ij}+B_{ij}\sin\theta_{ij}\big),\qquad
Q_i=\sum_j|V_i||V_j|\big(G_{ij}\sin\theta_{ij}-B_{ij}\cos\theta_{ij}\big)$$
<p>with $\theta_{ij}=\theta_i-\theta_j$. Each iteration solves the linearised mismatch equations</p>
$$\begin{bmatrix}\Delta P\\\Delta Q\end{bmatrix}=\begin{bmatrix}J_1&J_2\\J_3&J_4\end{bmatrix}\begin{bmatrix}\Delta\theta\\\Delta|V|\end{bmatrix},\qquad
J_1=\frac{\partial P}{\partial\theta},\ J_2=\frac{\partial P}{\partial|V|},\ J_3=\frac{\partial Q}{\partial\theta},\ J_4=\frac{\partial Q}{\partial|V|}$$
<p>and stops when $\max|\Delta P,\Delta Q|<10^{-6}$ pu (at most 100 iterations). A singular Jacobian is reported as such rather than iterated on.</p>

<h4>4 · Gauss-Seidel</h4>
<p>No Jacobian; each PQ bus is updated in turn</p>
$$V_i^{(k+1)}=\frac{1}{Y_{ii}}\left[\frac{P_i-jQ_i}{V_i^{(k)*}}-\sum_{j\ne i}Y_{ij}V_j\right]$$
<p>A PV bus first recomputes $Q_i$ from the latest voltages, then rescales $V_i$ back to its set-point magnitude. Because $\Delta V$ per sweep under-states the true error on meshed networks, convergence is confirmed by a final power-mismatch check (&lt;$10^{-5}$ pu) before it is reported.</p>

<h4>5 · Results</h4>
<p>Branch current and loading come from the solved voltages; the flow from bus $i$ into a branch is $S_{ij}=V_iI_{ij}^{*}$ with $I_{ij}=\frac{y}{t^2}V_i-\frac{y}{t}V_j$, and the loss is $S_{ij}+S_{ji}$. Loading is $|I|/I_{rated}$ for cables and $|S|/S_r$ for transformers.</p>

<h4>Sources, dispatch and islands</h4>
<ul>
<li><strong>Utility</strong> defaults to an ideal swing bus held at its set-point. Setting <code>lf_grid_model: thevenin</code> hangs it behind $Z=U^2/S''_k$ (with its $X/R$, no $c$ factor) via an internal EMF bus, so the point of supply sags with load.</li>
<li><strong>Generators, solar, wind and batteries</strong> are dispatched by priority, must-run, min/max loading and droop sharing; losses are shared in proportion to rating. Generators are PV buses limited by their reactive capability $Q_{min},Q_{max}$; a unit that hits a limit becomes a fixed-$Q$ PQ bus.</li>
<li><strong>SVC / STATCOM</strong> is a PV device that converts to a fixed-$Q$ shunt at its limits.</li>
<li><strong>Islands</strong> — sections with no source path (open breaker, tripped source) are de-energised and solved separately, not left to diverge.</li>
<li><strong>On-load tap changers</strong> iterate the tap by steps until the regulated bus is inside a half-step deadband.</li>
<li>A load or source wired only through a series cable or transformer with no bus gets an implicit terminal bus, so the feeding element has a real voltage drop.</li>
</ul>
<div class="hc-note"><span class="hc-label">Which solver?</span>Newton-Raphson converges in a handful of iterations even on stressed networks and is the default. Gauss-Seidel is slower but never singular; use it to sanity-check a case that Newton-Raphson reports as non-convergent.</div>` },

{ id: 'flow-unbalanced', group: 'flow', title: 'Unbalanced load flow',
  std: 'Symmetrical components · IEC 61000-3-13 (VUF) · Analyse ▸ Power flow',
  kw: 'vuf unbalance sequence phase neutral single phase two phase zero sequence negative',
  html: String.raw`
<p>Solves a three-phase network whose loads or sources are unbalanced, using the symmetrical-component method. Per-phase load is entered on static loads as <code>phase_a_pct / phase_b_pct / phase_c_pct</code> (default 33.33 % each), or as single-phase and line-to-line loads.</p>
<h4>Method</h4>
<ol>
<li><strong>Positive sequence.</strong> The balanced load-flow solver runs on $Y_1$ with the total three-phase power, giving $V_1$ at every bus.</li>
<li><strong>Sequence current injection.</strong> Each unbalanced load's per-phase complex power is converted to phase currents at the phase voltages implied by $V_1$, then to sequence currents with $a=e^{j120^\circ}$:
$$I_{ph}=3\,\overline{\left(\frac{S_{ph}}{V_{ph}}\right)},\qquad
\begin{bmatrix}I_0\\I_1\\I_2\end{bmatrix}=\frac13\begin{bmatrix}1&1&1\\1&a&a^2\\1&a^2&a\end{bmatrix}\begin{bmatrix}I_a\\I_b\\I_c\end{bmatrix}$$
The factor 3 arises because per-phase power is per-unit on the three-phase base while voltage is per-unit line-to-neutral. A line-to-line (2P) load uses the line voltage and produces $I_0=0$ exactly; a line-to-neutral (1P) load produces zero-sequence current.</li>
<li><strong>Negative and zero sequence.</strong> Two linear solves: $Y_2V_2=I_2$ and $Y_0V_0=I_0$. Transformer delta or zigzag windings block $I_0$ (they appear as zero-sequence shunts to earth at the winding), and parallel circuits use the mutual-coupling zero-sequence scale of <a href="#" data-help="fault-line-coupling">line coupling</a>.</li>
<li><strong>Recombine.</strong> Phase voltages and currents follow from $[V_a,V_b,V_c]^T=A\,[V_0,V_1,V_2]^T$, and neutral current is $I_n=3I_0$.</li>
</ol>
<h4>Voltage unbalance factor</h4>
$$\text{VUF}=\frac{|V_2|}{|V_1|}\times100\%$$
<p>IEC 61000-3-13 planning levels are 2 % (MV/LV). Motors need derating above about 1 % (NEMA MG 1): the negative-sequence field rotates against the rotor at nearly twice supply frequency and heats it.</p>
<div class="hc-warn">The positive sequence is solved with the total balanced power and phase voltages are then assumed balanced when converting loads to sequence currents (a single pass, no re-iteration). VUF is therefore understated for severe single-phase loading — treat it as a screening figure above about 5 %.</div>
<p>Cable $Z_0$ falls back to $3.5\times$ its positive-sequence components when no $r_0,x_0$ is entered (the short-circuit engine uses a composite $3Z_1$); the result notes say which.</p>` },

{ id: 'flow-timeseries', group: 'flow', title: 'Time-series (quasi-dynamic) load flow',
  std: 'Analyse ▸ Power flow',
  kw: '24h 8760 profile bess soc battery oltc losses energy hourly step',
  html: String.raw`
<p>Re-runs the balanced load flow once per time step over a 24 h or 8760 h horizon. It is a thin layer over <a href="#" data-help="flow-loadflow">Load flow</a> — no new power-flow mathematics — but state is carried between steps, so it is quasi-dynamic rather than $N$ independent snapshots.</p>
<h4>Profiles</h4>
<p>Every eligible load and source (static loads, motors, distribution boards, solar, wind, generators) is assigned a named profile: a 24-point hourly shape, linearly interpolated for sub-hourly steps and tiled across the horizon. Resolution order: the request's per-component override → the component's own <code>ts_profile</code> → the default profile → a per-type built-in (residential or industrial for loads, clear-sky for solar, flat elsewhere). The profile multiplies the component's <em>own</em> nameplate value captured at $t=0$:</p>
$$P_i(t)=P_{i,0}\cdot f_{profile}(t)$$
<p>applied to <code>demand_factor</code> for loads, <code>irradiance_pct</code> for solar (clipped 0–100), <code>wind_speed_pct</code> for wind and <code>rated_mva</code> for a scheduled generator. A "flat" profile reproduces the single-shot load flow exactly at every step.</p>
<h4>State carried between steps</h4>
<p><strong>Battery state of charge</strong> is integrated from the actually dispatched power, with one-way efficiency $\eta=\sqrt{\eta_{rt}}$:</p>
$$\text{SoC}_{t+\Delta t}=\text{SoC}_t-\frac{P_{dis}\,\Delta t}{\eta\,E_{cap}}\ \ (\text{discharging}),\qquad
\text{SoC}_{t+\Delta t}=\text{SoC}_t+\frac{\eta\,P_{chg}\,\Delta t}{E_{cap}}\ \ (\text{charging})$$
<p>A battery at 0 % or 100 % clamps there (with a warning) rather than crossing the bound. The clamp is a post-hoc fix, not a re-solve, so on the boundary step the reported dispatch is not strictly energy-consistent: <strong>use 15–60 minute steps for any run where a battery is expected to fully deplete or fill</strong>.</p>
<p><strong>OLTC tap</strong> starts each step from the previous step's converged tap, not the static default. <strong>Switched capacitor banks</strong> with <code>cap_control_mode: auto</code> use a voltage-hysteresis (on/off band) controller on their local bus, reading the previous step's solved voltage.</p>
<h4>Outputs</h4>
<ul>
<li>Per-bus minimum and maximum voltage with the step each occurred.</li>
<li>Per-branch peak loading.</li>
<li>Integrated energy losses: $E_{loss}=\sum_t P_{loss}(t)\,\Delta t$ (MWh).</li>
<li>Count of steps with a voltage or thermal violation; battery SoC and dispatch trajectories.</li>
</ul>
<p>A step whose solver diverges is recorded in <code>non_converged_steps</code> and the run continues. Cost scales with steps × per-solve time: a 2-bus feeder is about 4.5 s for 8760 steps, a 20-bus radial feeder about 60 s.</p>` },

{ id: 'flow-opf', group: 'flow', title: 'Optimal power flow (dispatch & Volt/VAR)',
  std: 'Merit-order economic dispatch · greedy discrete Volt/VAR · Analyse ▸ Power flow',
  kw: 'opf economic dispatch marginal cost merit order volt var tap capacitor setpoint losses',
  html: String.raw`
<p>Two coordinated stages, both driving the existing load-flow engine. There is no separate optimiser: each candidate is scored by a full load-flow solve.</p>
<h4>Stage 1 — economic dispatch</h4>
<p>Each source has a marginal cost $c_i$ (<code>cost_per_mwh</code>, engine defaults per type). For linear costs the optimum of</p>
$$\min\ \sum_i c_i P_i\quad\text{s.t.}\quad\sum_i P_i=P_{load}+P_{loss},\ \ P_i^{min}\le P_i\le P_i^{max}$$
<p>is <em>merit order</em>: fill cheapest units first up to their limits. The stage re-ranks every dispatchable source by ascending cost and lets the load-flow dispatcher (which handles must-run, min/max loading, islanding, droop and loss compensation) produce the schedule. The most expensive committed unit naturally becomes the marginal unit, balancing the island.</p>
<h4>Stage 2 — Volt/VAR optimisation</h4>
<p>A greedy discrete hill climb over the real control variables:</p>
<ul>
<li>Capacitor bank steps in service: $0\ldots n_{steps}$.</li>
<li>Transformer tap: $\pm2.5\%$ steps within $\pm10\%$.</li>
<li>Generator PV set-points and the utility swing set-point: $0.95\ldots1.05$ pu in 0.01 steps.</li>
</ul>
<p>Every move is scored lexicographically — <strong>(1)</strong> voltage and thermal violations, then <strong>(2)</strong> the chosen objective (generation cost per hour, or network MW loss), then <strong>(3)</strong> the other objective as tie-break — and the best single improving move is applied. The climb stops when no move improves the score or the move budget is used up.</p>
<p>Output: baseline versus optimised cost, losses and violations; the move list (element, setting, from → to); the dispatch table with per-source cost; and the recommended settings.</p>
<div class="hc-note"><span class="hc-label">Limits</span>Switching (topology) optimisation is out of scope. A greedy climb finds a local optimum — a different starting point can give a different, equally valid answer.</div>` },

{ id: 'flow-vstab', group: 'flow', title: 'Voltage stability (P-V & Q-V)',
  std: 'Kundur ch. 14 · Taylor · Analyse ▸ Stability & dynamics',
  kw: 'pv nose curve qv reactive margin loadability collapse lambda continuation',
  html: String.raw`
<p>A steady-state, long-term study — distinct from time-domain <a href="#" data-help="dyn-transient">transient stability</a>. It asks how far the load can grow, and how much reactive support is left, before the network can no longer be solved.</p>
<h4>P-V curve — loadability</h4>
<p>All loads are scaled by a factor $\lambda$ at constant power factor (via <code>demand_factor</code>) and the load flow is re-solved at each step. The <em>nose</em> — the largest $\lambda$ for which a solution exists — is found by stepping $\lambda$ up (default +10 %) until the solve fails, then <strong>bisecting</strong> the last-good / first-failed bracket 6 times.</p>
$$\text{loadability margin}=(\lambda_{crit}-1)\times100\%$$
<p>Collapse is declared on Newton-Raphson divergence, on the weakest energised bus falling below a floor (default 0.4 pu), or on an energised bus going dark. A stiff network that never collapses within the $\lambda$ cap reports the margin as a lower bound.</p>
<div class="hc-example"><span class="hc-label">Analytic check</span>
<p>For a source $E$ behind a lossless reactance $X$ feeding a load at lagging power-factor angle $\varphi$:</p>
$$P_{max}=\frac{E^{2}}{2X}\,\frac{\cos\varphi}{1+\sin\varphi},\qquad V_{nose}=\frac{E}{\sqrt{2\,(1+\sin\varphi)}}$$
<p>At unity power factor the nose voltage is $E/\sqrt2\approx0.707$ pu. The engine reproduces this closed form to within 1 % in the verification suite.</p></div>
<h4>Q-V curve — reactive margin</h4>
<p>A fictitious synchronous condenser ($P=0$, voltage-regulating) is installed at the weakest (or chosen) bus and turned into a PV bus. Its voltage set-point is swept high to low while the reactive injection needed to hold it is recorded. The bottom of the resulting curve, where $dQ/dV=0$, is the <strong>reactive margin</strong>: the extra $Q$ the bus could lose before the operating point vanishes. Skipped for source-controlled buses.</p>
<h4>Outputs</h4>
<p>$\lambda_{crit}$, loadability margin, per-bus P-V curves, the minimum-voltage envelope, critical bus and nose voltage, the Q-V curve and margin. Results are on-demand and not saved with the project.</p>` },

{ id: 'flow-contingency', group: 'flow', title: 'Contingency analysis (N-1 / N-2)',
  std: 'Load-flow security screening · Analyse ▸ Planning & reliability',
  kw: 'n-1 n-2 outage security overload loss of supply islanded ranked',
  html: String.raw`
<p>Screens whether the network survives the loss of any single element (N-1), and optionally any pair (N-2). Each contingency removes the element(s) and re-solves the load flow; a solve never raises an error, a non-convergent case is simply recorded as such.</p>
<h4>What can be outaged</h4>
<p>Series branches (cables, transformers) and sources (utility, generator, solar, wind, battery). Transparent devices and passive loads are not outaged.</p>
<h4>Violations flagged per outage</h4>
<ul>
<li><strong>Thermal overload</strong> — branch loading above the limit: $\dfrac{|I|}{I_{rated}}\times100>\text{limit}$.</li>
<li><strong>Voltage</strong> — any bus outside the configured band, $V_{min}\le V\le V_{max}$.</li>
<li><strong>Loss of supply</strong> — buses de-energised, with MW lost:
$$P_{lost}=\sum_{b\in\text{dead}}P_{load,b}$$
using the same per-bus load accounting as the load-flow solver.</li>
</ul>
<h4>Ranking and verdict</h4>
<p>Results are ranked worst first: non-converged &gt; loss of supply (islanded) &gt; violations &gt; secure. The network is <strong>N-1 secure</strong> only when every single outage is violation-free. N-2 pairs are capped (default 400 solved) and any skipped pairs are reported rather than dropped silently.</p>
<div class="hc-note"><span class="hc-label">Reading loss of supply</span>In a purely radial feeder every branch outage islands the load downstream of it — that is expected, not a defect. The useful findings are the outages that <em>overload</em> or <em>under-volt</em> a network that still has an alternative path.</div>` },

{ id: 'flow-hosting', group: 'flow', title: 'Hosting capacity (DER)',
  std: 'EPRI DRIVE-style screens · Analyse ▸ Planning & reliability',
  kw: 'der pv solar interconnection voltage rise thermal fault level protection desensitisation',
  html: String.raw`
<p>The maximum distributed generation (PV) that can be connected at a bus before a technical limit is crossed. It is deterministic and per candidate bus.</p>
<h4>Search</h4>
<p>A synthetic unity-power-factor PV source is injected at the bus and the load flow re-solved at increasing power. The sweep steps up in $\Delta P$ increments (default 0.5 MW, capped at 10 MW per bus) to bracket the first violation, then bisects the bracket 8 times:</p>
$$HC_b=\max\{P:\ \text{no violation at all buses with }P\text{ injected at }b\}$$
<h4>Screens</h4>
<ul>
<li><strong>Voltage rise</strong> — reverse power flow raises the local and upstream voltage. Limited when any bus exceeds $V_{max}$. For a feeder with impedance $R+jX$ the rise is approximately $\Delta V\approx\dfrac{PR-QX}{V}$, which is why a resistive LV feeder limits before a stiff MV one.</li>
<li><strong>Thermal</strong> — added generation loads a feeder or transformer above the limit in the <em>export</em> direction.</li>
<li><strong>Fault level and protection</strong> — at the capacity found above, fault analysis and the duty check are re-run with the DER connected. The screen fails if any device's duty verdict degrades to fail, or if the prospective fault level rises by more than 10 % at any bus. A DER contribution above 10 % of the fault level at its own bus raises a <em>coordination review</em> advisory (the usual trigger for re-grading overcurrent protection). When it fails, the capacity that would pass is found by a further 5-step bisection.</li>
</ul>
<p>The first screen to bind is reported per bus as the limiting factor.</p>
<div class="hc-warn">Deterministic and "dumb inverter": unity power factor and a hard trip at $V_{max}$. Smart-inverter volt-var response and probabilistic (Monte-Carlo) capacity are not modelled, and reverse-fed transformers are checked against their import rating.</div>` },

{ id: 'flow-capplace', group: 'flow', title: 'Optimal capacitor placement',
  std: 'Loss-sensitivity greedy heuristic · Analyse ▸ Planning & reliability',
  kw: 'var compensation shunt capacitor losses undervoltage kvar',
  html: String.raw`
<p>Decides where to add shunt VAR compensation and how much, to clear voltage violations and reduce losses.</p>
<h4>Algorithm</h4>
<p>The classic discrete greedy method. Repeat:</p>
<ol>
<li>Trial one standard bank unit ($Q_{unit}$) at every candidate bus, each with a full load-flow solve.</li>
<li>Commit the single placement that improves the score most.</li>
<li>Stop when nothing improves the score, or the per-bus or total budget is reached (hard cap of 400 solves).</li>
</ol>
<p>The score is lexicographic: <strong>voltage violations first</strong> (count, then severity), <strong>then losses</strong>. Compensation therefore clears undervoltage before it chases kW, and a unit that would push any bus over $V_{max}$ is never chosen.</p>
<h4>Bank model</h4>
<p>Placements are constant-susceptance banks, so delivered reactive power falls with the square of voltage — the same model the load flow uses for an ordinary capacitor bank:</p>
$$Q=Q_{rated}\,V^{2},\qquad B=\frac{Q_{rated}}{S_b}\ \text{(pu)}$$
<p>The recommended list is therefore directly applicable on the diagram as ordinary capacitor banks.</p>
<h4>Annualised value</h4>
$$\text{Value}=\Delta P_{loss}\ [\text{MW}]\times8760\ \text{h}\times c_{\$/MWh}$$
<p>using the utility's marginal cost (<code>cost_per_mwh</code>, as in <a href="#" data-help="flow-opf">OPF</a>). Placing at the load centre rather than the source is what captures loss savings, because the reactive current is then no longer carried through the feeder.</p>` },

{ id: 'flow-reliability', group: 'flow', title: 'Reliability (SAIDI / SAIFI)',
  std: 'IEEE 1366 · Billinton & Allan (analytical FMEA) · Analyse ▸ Planning & reliability',
  kw: 'saidi saifi caidi asai maifi eens failure rate repair time fmea customers',
  html: String.raw`
<p>Estimates how often and how long each load point is interrupted by analysing every failure mode of every component in turn.</p>
<h4>Method — analytical FMEA</h4>
<p>Each failable component has a permanent failure rate $\lambda$ (occurrences per year; per-km × length for cables and lines) and a mean repair time $r$ (hours). Each failure is analysed as a sustained outage: the component is removed, and the buses that lose <em>all</em> source paths are the interrupted load points. This is a connectivity walk through closed switching devices — no load-flow solve — using the perfect-selectivity assumption of classic radial FMEA. Sectionalising and restoration through normally-open points is out of scope.</p>
<p>Load points carry customer counts $N_k$ (<code>customers</code> on loads and boards, default 1) and demand $P_k$ in MW. Summing over all failure modes $k$:</p>
$$\text{SAIFI}=\frac{\sum\lambda_kN_k}{N_T},\qquad
\text{SAIDI}=\frac{\sum\lambda_kr_kN_k}{N_T},\qquad
\text{CAIDI}=\frac{\text{SAIDI}}{\text{SAIFI}}$$
$$\text{ASAI}=\frac{8760-\text{SAIDI}}{8760},\qquad
\text{MAIFI}=\frac{\sum\lambda^{m}_kN_k}{N_T},\qquad
\text{EENS}=\sum\lambda_kr_kP_k\ \ [\text{MWh/yr}]$$
<p>MAIFI counts momentary interruptions from $\lambda^m$ (overhead-line temporary faults cleared by reclosing).</p>
<h4>Default rates (overridable per component)</h4>
<table class="help-ref-table"><thead><tr><th>Component</th><th>$\lambda$</th><th>$r$ (h)</th></tr></thead><tbody>
<tr><td>Underground cable</td><td>0.05 /km·yr</td><td>26</td></tr>
<tr><td>Overhead line</td><td>0.10 /km·yr (+0.30 momentary)</td><td>5</td></tr>
<tr><td>Transformer, autotransformer</td><td>0.015 /yr</td><td>72</td></tr>
<tr><td>Circuit breaker</td><td>0.003 /yr</td><td>12</td></tr>
<tr><td>Bus, board, switch</td><td>0.002 /yr</td><td>8</td></tr>
<tr><td>Fuse</td><td>0.002 /yr</td><td>4</td></tr>
<tr><td>Utility supply</td><td>1.0 /yr</td><td>2</td></tr></tbody></table>
<p>These are typical IEEE 493 "Gold Book" and distribution-planning figures — replace them with your utility's own statistics for a design decision.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>200 customers on a radial supply through a 2 km underground cable and one transformer; either failure interrupts everyone.</p>
<p>Cable: $\lambda=0.05\times2=0.10$ /yr, $r=26$ h. Transformer: $\lambda=0.015$ /yr, $r=72$ h.</p>
<p>$\text{SAIFI}=0.10+0.015=\mathbf{0.115}$ /cust·yr, $\ \text{SAIDI}=0.10\times26+0.015\times72=2.6+1.08=\mathbf{3.68}$ h/cust·yr</p>
<p>$\text{CAIDI}=3.68/0.115=\mathbf{32.0}$ h, $\ \text{ASAI}=(8760-3.68)/8760=\mathbf{0.99958}$</p></div>` }

);
