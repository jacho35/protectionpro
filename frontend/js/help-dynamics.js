/* Help articles — motors, stability & power quality. Rendered by help.js; TeX between $…$ / $$…$$. */
HELP_ARTICLES.push(

{ id: 'dyn-motor-static', group: 'dynamics', title: 'Motor starting (voltage dip)',
  std: 'IEEE 3002.7 · Analyse ▸ Stability & dynamics',
  kw: 'voltage dip locked rotor lrc starting current dol star delta autotransformer soft starter vfd',
  html: String.raw`
<p>For each motor, finds the voltage at every bus in the instant after it is switched on with the rotor locked, and compares the dip with acceptable limits. It is a static (snapshot) study — for the run-up itself see <a href="#" data-help="dyn-motor-dynamic">Dynamic motor starting</a>.</p>
<h4>Starting current</h4>
$$I_{FL}=\frac{P_r}{\sqrt3\,U\,\eta\cos\varphi}\ \ (\text{induction}),\qquad I_{FL}=\frac{S_r}{\sqrt3\,U}\ \ (\text{synchronous})$$
$$I_{start}=k_m\cdot LRC\cdot I_{FL},\qquad S_{start}=\sqrt3\,U\,I_{start}$$
<table class="help-ref-table"><thead><tr><th>Starting method</th><th>$k_m$</th></tr></thead><tbody>
<tr><td>Direct-on-line</td><td>1</td></tr>
<tr><td>Star-delta</td><td>$1/3$</td></tr>
<tr><td>Autotransformer (80 % tap)</td><td>$0.8^2=0.64$ (reduced-voltage current $\propto V^2$)</td></tr>
<tr><td>Soft starter</td><td>0.5</td></tr>
<tr><td>VFD</td><td>the drive limits line current to about $I_{FL}$, so $LRC$ does not apply</td></tr></tbody></table>
<h4>Terminal voltage — Thevenin superposition</h4>
<p>The starting motor is a constant-$PQ$ load at a low power factor (0.3) drawing $S_{start}$. Behind the network's Thevenin impedance $Z_{th}$ (source internal impedance included, evaluated at $c=1.0$) the terminal voltage $V$ satisfies</p>
$$V=V_{pre}-Z_{th}\left(\frac{S_{start}}{V}\right)^{*}$$
<p>solved by damped fixed-point iteration. If no solution exists — the start demands more than the network can transfer — the motor is reported as a genuine stall. The dip at any bus $b$ is</p>
$$\text{dip}_b\,[\%]=\frac{V_{pre,b}-V_{start,b}}{V_{pre,b}}\times100$$
<p>where $V_{start,b}$ is the load-flow voltage with the motor in its starting state less the source drop that the load-flow's ideal swing bus cannot show.</p>
<h4>Verdict</h4>
<ul><li>System dip: pass at ≤ <strong>15 %</strong> at every bus.</li><li>Sensitive (PQ) buses: pass at ≤ <strong>10 %</strong>.</li></ul>
<div class="hc-example"><span class="hc-label">Rule-of-thumb check</span>
<p>For a small start on a stiff bus the dip is approximately $\Delta V\approx S_{start}/S_{sc}$. A 200 kW motor ($\eta=0.93,\cos\varphi=0.85$): $S_r=200/(0.93\times0.85)=253$ kVA, $S_{start}=6\times253=1.52$ MVA. On a 20 MVA fault level: $\Delta V\approx1.52/20=\mathbf{7.6\%}$.</p></div>
<p>Modelling the locked rotor as constant-$PQ$ (physically it is a constant impedance, $S\propto V^2$) draws slightly more current at the depressed voltage — a mildly pessimistic bias that is deliberate.</p>` },

{ id: 'dyn-motor-dynamic', group: 'dynamics', title: 'Dynamic motor starting',
  std: 'IEEE 3002.7 · Chapman · Analyse ▸ Stability & dynamics',
  kw: 'acceleration swing equation slip torque stall run-up inertia thermal i2t equivalent circuit deep bar',
  html: String.raw`
<p>Integrates the motor's acceleration against the supply network, giving speed, current, torque and voltage trajectories, the acceleration time, stall detection and a rotor thermal check.</p>
<h4>Mechanics</h4>
$$2H\,\frac{d\omega}{dt}=T_e(V,s)-T_L(\omega),\qquad s=1-\omega$$
<p>in per-unit on the motor base (RK2 integration). The load torque is one of three shapes, each with a breakaway fraction $b$:</p>
$$T_L=T_{L,r}\Big[b+(1-b)\,r^{2}\Big]\ (\text{quadratic}),\quad T_{L,r}\Big[b+(1-b)\,r\Big]\ (\text{linear}),\quad T_{L,r}\ (\text{constant}),\qquad r=\frac{\omega}{\omega_{rated}}$$
<p>With no inertia supplied, $H\approx0.12\,P_{kW}^{0.15}$ s for the motor alone.</p>
<h4>Motor electrical model</h4>
<p>A single-cage equivalent circuit with a shunt magnetising branch and a linear deep-bar rotor resistance:</p>
$$Y_{in}(s)=\frac{1}{jX_m}+\frac{1}{R_1+R_2(s)/s+jX},\qquad R_2(s)=R_{2,run}+(R_{2,start}-R_{2,run})\,s$$
$$I_2=\frac{V_m}{R_1+R_2(s)/s+jX},\qquad T_e=|I_2|^{2}\,\frac{R_2(s)}{s}$$
<p>The parameters are fitted to the two points the nameplate specifies: locked rotor ($I=LRC\cdot FLC$ and $T=LRT\cdot FLT$ at $s=1$) and the rated point ($T=FLT$ at $s_{rated}$). $R_{2,start}$ comes from locked-rotor torque, $X$ from locked-rotor current (magnetising branch included) and $R_{2,run}$ from the rated-point torque quadratic. Torque in between (for example breakdown torque) is a model prediction, reported so it can be compared with the datasheet.</p>
<h4>Network</h4>
<p>The supply is a Thevenin equivalent at the motor bus — the superposition hand method:</p>
$$V_{bus}(t)=V_{pre}-Z_{th}\,I_{line}(t)$$
<p>$V_{pre}$ is the pre-start voltage from a baseline load flow with the motor off; $Z_{th}$ is the parallel of all non-motor source paths at $c=1.0$. Where several motors start at once, a multi-port reduction $V_{port}=V_{pre}-Z\,I_{inj}$ resolves their mutual coupling.</p>
<h4>Starters</h4>
<p>DOL; star-delta ($Y_{in}/3$, $T/3$, changeover at a speed threshold); autotransformer (80 % tap, same changeover); soft starter (voltage ramp with a current limit through firing-angle reduction). VFD starts are not simulated — the drive controls the trajectory and holds line current near FLC. Synchronous motors run up through their damper cage like induction machines, fitted at an assumed rated slip of 5 %, and the start succeeds at 95 % speed (pull-in by excitation is assumed from there).</p>
<h4>Outputs</h4>
<p>Acceleration time, stall flag, peak current, the voltage-dip trajectory, and rotor thermal use as $\int I_2^2\,dt$ (an $I^2t$ measure) against the motor's permitted locked-rotor withstand.</p>` },

{ id: 'dyn-transient', group: 'dynamics', title: 'Transient stability',
  std: 'Stevenson · Kundur ch. 13 · Analyse ▸ Stability & dynamics',
  kw: 'swing equation rotor angle cct critical clearing time avr governor pss exciter inverter grid forming equal area kron',
  html: String.raw`
<p>Time-domain rotor-angle simulation of multiple machines after a disturbance (a fault with clearing, a tripped branch or generator, or a load step).</p>
<h4>Machine model</h4>
<p>Each synchronous machine is a voltage $E'$ behind its transient reactance $X'_d$. Utilities are infinite buses. The rotor obeys the swing equation, integrated with RK4:</p>
$$\frac{d\delta}{dt}=\Delta\omega,\qquad
\frac{d\Delta\omega}{dt}=\frac{\omega_s}{2H}\left(P_m-P_e-D\,\frac{\Delta\omega}{\omega_s}\right)$$
<p>The network is Kron-reduced to the machines' internal nodes, so the electrical power of machine $i$ is</p>
$$P_{e,i}=\sum_j|E_i||E_j|\big(G_{ij}\cos\delta_{ij}+B_{ij}\sin\delta_{ij}\big),\qquad \delta_{ij}=\delta_i-\delta_j$$
<p>with $Y_{red}=G+jB$ rebuilt for each network state: pre-fault, fault-on (faulted bus grounded) and post-fault (branch, generator or load changed).</p>
<h4>Controls</h4>
<table class="help-ref-table"><thead><tr><th>Element</th><th>Model</th></tr></thead><tbody>
<tr><td>Governor — droop + lag</td><td>$\dfrac{dP_m}{dt}=\dfrac{P_{m0}+P_{sec}-\Delta\omega/(\omega_sR)-P_m}{T_g}$, capped at rating (anti-windup)</td></tr>
<tr><td>Governor — isochronous</td><td>adds reset $\dfrac{dP_{sec}}{dt}=-\dfrac{\Delta\omega}{\omega_s\,R\,T_r}$ so speed returns to nominal</td></tr>
<tr><td>AVR</td><td>$\dfrac{dE}{dt}=\dfrac{K_a(V_{ref}-V_t)-(E-E_0)}{T_a}$, clamped to $[E_{min},E_{max}]$</td></tr>
<tr><td>Two-axis model</td><td>$E'_q,E'_d$ flux-decay via $T'_{do},T'_{qo}$, the AVR driving field voltage $E_{fd}$</td></tr>
<tr><td>Turbine options</td><td>DEGOV1 diesel, GAST gas, TGOV1 steam, HYGOV hydro — standard-<em>shaped</em> reduced-order models, not certified vendor sets</td></tr>
<tr><td>Exciter options</td><td>SEXS, ST1, AC</td></tr>
<tr><td>PSS (PSS1A shape)</td><td>washout + two lead-lag stages on $\Delta\omega$ added to the exciter error; default 2:1 per stage</td></tr>
<tr><td>Loads</td><td>frozen as constant admittances, or voltage-dependent (constant P / I / Z / ZIP); induction motors take a single-cage slip model and can stall</td></tr>
<tr><td>Inverter sources</td><td>constant admittance, or dynamic <em>grid-forming</em> (virtual synchronous machine with synthetic inertia, P-f droop and a virtual impedance that grows past the current limit)</td></tr></tbody></table>
<h4>Stability verdict and critical clearing time</h4>
<p>A machine whose angle departs $|\delta-\delta_{COI}|>180^\circ$ from its island's centre of inertia has lost synchronism. For a fault, the <strong>critical clearing time</strong> is found by binary search (18 halvings) on the clearing time, re-simulating each candidate — a first-swing metric evaluated on the classical constant-impedance network, the equal-area convention.</p>
<div class="hc-example"><span class="hc-label">Equal-area cross-check</span>
<p>For a machine against an infinite bus, classical stability is lost when the decelerating area can no longer absorb the accelerating area. With $P_m$ constant and $P_{max}$ before, $0$ during and $P_{max}$ after the fault:</p>
$$\cos\delta_{cr}=\frac{P_m}{P_{max}}\,(\pi-2\delta_0)-\cos\delta_0,\qquad t_{cr}=\sqrt{\frac{4H\,(\delta_{cr}-\delta_0)}{\omega_s\,P_m}}$$
<p>The engine reproduces this to about 1 % in the verification suite.</p></div>
<div class="hc-warn">The turbine and exciter blocks reproduce qualitative step-response character. A default PSS damps a typical local mode; real tuning compensates phase at the specific machine's mode, which this reduced-order default does not attempt.</div>` },

{ id: 'dyn-flicker', group: 'dynamics', title: 'Voltage flicker (Pst / Plt)',
  std: 'IEC 61000-3-3 Annex · IEC 61000-4-15 · Analyse ▸ Power quality',
  kw: 'pst plt relative voltage change repetitive motor start flickermeter',
  html: String.raw`
<div class="hc-warn">A <strong>planning-level screening estimate</strong>, not a flickermeter. A certified IEC 61000-4-15 reading needs the sampled AC waveform through a specific demodulation and perception-weighting chain; a single-line diagram has no such waveform. Confirm a borderline result against the standard's curve or field measurement.</div>
<h4>Method</h4>
<p>The physical input to every flicker assessment is the relative voltage change $d\,(\%)$ that one switching event causes. It comes from the same Thevenin superposition as <a href="#" data-help="dyn-motor-static">motor starting</a>:</p>
$$d\,[\%]=\frac{V_{pre}-V_{start}}{V_{pre}}\times100$$
<p>For repetitive rectangular steps of size $d$ occurring $r$ times per minute, IEC 61000-3-3's simplified method gives a curve-fitted severity anchored at the best-known reference point — a 3 % step at one change per minute is $P_{st}\approx1$ — with the high-rate roll-off exponent 0.31:</p>
$$P_{st}\approx\frac{d}{d_{anchor}}\,r^{\,0.31},\qquad d_{anchor}=3.0\ \%$$
<p>Both $d_{anchor}$ and the exponent are exposed so they can be recalibrated against the standard's table. For a single repetitively switched load whose emission does not vary over two hours, $P_{lt}\approx P_{st}$.</p>
<h4>Limits</h4>
<p>LV connection defaults: $P_{st}\le1.0$, $P_{lt}\le0.65$. MV/HV limits are project-specific allocations (IEC 61000-3-7) and are entered as overrides rather than hard-coded.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>A compressor start causes $d=2.4\,\%$ and repeats 6 times per minute.</p>
$$P_{st}\approx\frac{2.4}{3.0}\times6^{0.31}=0.8\times1.743=\mathbf{1.39}$$
<p>which exceeds 1.0: reduce $d$ (soft start, stiffer supply) or the repetition rate. At 1 per minute the same step gives $0.8$ and passes.</p></div>` },

{ id: 'dyn-harmonics', group: 'dynamics', title: 'Harmonic analysis (IEEE 519)',
  std: 'IEEE 519-2014 · Analyse ▸ Power quality',
  kw: 'thd tdd vfd pulse 12-pulse ihd harmonic current injection distortion pcc rectifier',
  html: String.raw`
<p>A frequency-domain harmonic-current-injection study. Non-linear loads (chiefly variable-frequency drives) are harmonic current sources; the network is re-solved at each harmonic order to find the voltage distortion that appears on every bus.</p>
<h4>Method</h4>
<p>At each characteristic order $h$ a drive injects $I_h=(I_h/I_1)\,I_1$ into its bus, with the spectrum taken from typical manufacturer values by rectifier pulse number and input reactor (6-pulse, 12-pulse cancelling 5th/7th, 18-pulse cancelling 11th/13th, or an active front end). The network is rebuilt at frequency $h\,f_1$ — all reactances scaled by $h$ — and solved as a nodal admittance system:</p>
$$\mathbf{Y}_h\,\mathbf{V}_h=\mathbf{I}_h$$
<table class="help-ref-table"><thead><tr><th>Element</th><th>Harmonic model at order $h$</th></tr></thead><tbody>
<tr><td>Utility, generator, machines</td><td>shunt $R+jhX''$ to ground (sub-transient / short-circuit reactance)</td></tr>
<tr><td>Capacitor bank</td><td>susceptance $jhB$ — the usual driver of parallel resonance</td></tr>
<tr><td>Tuned capacitor bank</td><td>series C-L-R branch</td></tr>
<tr><td>Static load</td><td>parallel R-L (CIGRÉ type 2), giving frequency-dependent damping</td></tr>
<tr><td>Cable, transformer</td><td>series $R+jhX$ (leakage reactance, without the off-nominal tap ratio)</td></tr></tbody></table>
<p>Sources of the same order are summed in phase (no diversity) — the conservative screening assumption.</p>
<h4>Distortion indices</h4>
$$\text{IHD}_h=\frac{|V_h|}{|V_1|}\times100\%,\qquad
\text{THD}_V=\sqrt{\sum_{h\ge2}\text{IHD}_h^{\,2}},\qquad
\text{TDD}=\frac{\sqrt{\sum_{h\ge2}I_h^{2}}}{I_L}\times100\%$$
<p>$I_L$ is the maximum demand load current at the point of common coupling.</p>
<h4>IEEE 519-2014 limits used</h4>
<table class="help-ref-table"><thead><tr><th>Bus voltage</th><th>Individual $V_h$</th><th>$\text{THD}_V$</th></tr></thead><tbody>
<tr><td>≤ 1 kV</td><td>5 %</td><td>8 %</td></tr>
<tr><td>1 – 69 kV</td><td>3 %</td><td>5 %</td></tr>
<tr><td>69 – 161 kV</td><td>1.5 %</td><td>2.5 %</td></tr>
<tr><td>&gt; 161 kV</td><td>1.0 %</td><td>1.5 %</td></tr></tbody></table>
<table class="help-ref-table"><thead><tr><th>$I_{sc}/I_L$ at the PCC</th><th>TDD limit</th></tr></thead><tbody>
<tr><td>&lt; 20</td><td>5 %</td></tr><tr><td>20 – 50</td><td>8 %</td></tr><tr><td>50 – 100</td><td>12 %</td></tr><tr><td>100 – 1000</td><td>15 %</td></tr><tr><td>&gt; 1000</td><td>20 %</td></tr></tbody></table>
<p>The current limits are Table 2 (120 V–69 kV); above 69 kV a stricter scale (×0.5, or ×0.25 above 161 kV) is applied conservatively.</p>` },

{ id: 'dyn-freqscan', group: 'dynamics', title: 'Frequency scan (resonance)',
  std: 'Analyse ▸ Power quality',
  kw: 'resonance parallel series impedance driving point z vs frequency capacitor filter',
  html: String.raw`
<p>Sweeps the harmonic order $h$ continuously from the fundamental to $h_{max}$ and, at each frequency, assembles the same harmonic network as <a href="#" data-help="dyn-harmonics">Harmonic analysis</a> and inverts the nodal admittance matrix. The diagonal entry is the <em>driving-point impedance</em> seen from bus $k$:</p>
$$Z_{kk}(h)=\left[\mathbf{Y}_h^{-1}\right]_{kk}$$
<p>This is the quantity a harmonic current source at that bus multiplies to give voltage distortion, $V_h=Z_{kk}(h)\,I_h$.</p>
<ul>
<li>A <strong>parallel resonance</strong> — the inductance of the source and transformers against a shunt capacitor — is a sharp $|Z|$ <em>maximum</em>: harmonic currents near that order are amplified.</li>
<li>A <strong>series resonance</strong> is an $|Z|$ <em>minimum</em>: that branch sinks harmonic current, which is the basis of a tuned filter.</li>
</ul>
<h4>The hand check</h4>
<p>A capacitor bank $Q_c$ on a bus with short-circuit level $S_{sc}$ resonates near</p>
$$h_r=\sqrt{\frac{S_{sc}}{Q_c}}$$
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>A 2 Mvar bank on an 11 kV bus with $S_{sc}=50$ MVA: $h_r=\sqrt{50/2}=\mathbf{5.0}$. The 5th harmonic — the strongest characteristic harmonic of a 6-pulse drive — sits exactly on the resonance and will be heavily amplified. Moving to a 3 Mvar bank gives $h_r=4.08$; adding a detuning reactor moves it below 4.</p></div>
<p>Results are impedances in ohms at each bus's own voltage base. They are on-demand and not saved with the project.</p>` },

{ id: 'dyn-filter', group: 'dynamics', title: 'Passive filter sizing',
  std: 'IEEE 1531 · Arrillaga · Analyse ▸ Power quality',
  kw: 'single tuned filter reactor capacitor quality factor detuned harmonic kvar',
  html: String.raw`
<p>Designs single-tuned LC(R) filter branches that bring voltage distortion within IEEE 519, then verifies the design by re-running the harmonics study.</p>
<h4>Single-tuned branch design</h4>
<p>A branch giving net fundamental compensation $Q_f$ at bus voltage $U$, tuned to order $h_t$ (a few percent below the target harmonic, so component tolerance and temperature drift never leave the tuned point above it):</p>
$$X_{eff}=\frac{U^{2}}{Q_f},\qquad X_C=X_{eff}\,\frac{h_t^{2}}{h_t^{2}-1},\qquad X_L=\frac{X_C}{h_t^{2}},\qquad R=\frac{X_C/h_t}{Q}$$
$$C=\frac{1}{\omega_1X_C},\qquad L=\frac{X_L}{\omega_1},\qquad h_t=\sqrt{\frac{X_C}{X_L}}$$
<p>$Q$ is the quality factor (typically 30–50), which sets the damping resistance.</p>
<h4>Procedure</h4>
<ol>
<li>Run the harmonics engine for the baseline THD and compliance picture.</li>
<li>Find the dominant injected orders at the chosen bus (default: the worst-THD bus) from the drive spectra.</li>
<li>Add one tuned branch per dominant order, splitting the total kvar equally, and re-run the harmonics engine.</li>
<li>Stop at the first branch count that satisfies IEEE 519 everywhere, or report the best attempt with the residual violations.</li>
</ol>
<p>Total filter kvar defaults to the uncompensated reactive demand at the filter bus's island, capped at $1.2\times$ so the filter doubles as power-factor correction. The recommendation is expressed as ordinary <code>capacitor_bank</code> properties (rated kvar, tuning order, quality factor) plus engineering values in µF, mH and Ω per branch.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>$Q_f=600$ kvar at $U=0.4$ kV, tuned to $h_t=4.7$ (to catch the 5th), $Q=40$.</p>
$$X_{eff}=\frac{0.4^2\times10^{6}}{600\times10^{3}}=0.2667\ \Omega,\quad X_C=0.2667\times\frac{22.09}{21.09}=0.2793\ \Omega,\quad X_L=\frac{0.2793}{22.09}=12.65\ \text{m}\Omega$$
$$R=\frac{0.2793/4.7}{40}=1.49\ \text{m}\Omega,\qquad C=\frac{1}{314.16\times0.2793}=11.4\ \text{mF}$$</div>` },

{ id: 'dyn-battery', group: 'dynamics', title: 'Battery sizing & discharge',
  std: 'IEEE 485-style factors · Peukert · Analyse ▸ Sizing & installation',
  kw: 'duty cycle soc depth of discharge dod aging temperature peukert ocv lead acid lithium lfp nmc',
  html: String.raw`
<p>Answers "how big must the battery be for this duty cycle?" and shows the state of charge and terminal voltage through the discharge.</p>
<h4>Sizing — energy method</h4>
$$E_{req}=\frac{\sum_i P_i\,t_i}{\eta_{inv}\;DoD}\;K_{age}\,K_{design}\,K_{temp}$$
<ul>
<li>$\eta_{inv}=\sqrt{\eta_{rt}}$ — one-way conversion efficiency from the round-trip efficiency.</li>
<li>$DoD$ — the usable depth-of-discharge window.</li>
<li>$K_{age}=1.25$ — size so the battery still meets the duty at its 80 % end-of-life capacity (IEEE 485 §6.3.3).</li>
<li>$K_{design}=1.10$ — design and growth margin (§6.3.2).</li>
<li>$K_{temp}$ — low-temperature correction: 1.00 at 25 °C rising toward cold for lead-acid; much flatter for Li-ion (1.00 at ≥10 °C, 1.10 below).</li>
</ul>
<h4>Discharge simulation</h4>
<p>One-minute forward steps over the duty cycle. State of charge falls with the energy drawn through $\eta_{inv}$. For lead-acid the drawn current is Peukert-corrected on the battery's hour rating:</p>
$$I_{eff}=I\left(\frac{I}{I_{rated}}\right)^{k-1},\qquad k=1.25\ (\text{lead-acid}),\ \approx1.0\ (\text{Li-ion})$$
<p>so a discharge at $2\times$ the rated current empties a lead-acid bank in $H/2^{k}$ hours, not $H/2$. Terminal voltage is</p>
$$V(t)=\text{OCV}(\text{SoC})-\text{sag}\cdot\frac{I}{I_{1C}}$$
<p>with a per-chemistry OCV(SoC) lookup and a rated 1C sag standing in for internal resistance (LFP 3 %, NMC 5 %, lead-acid 10 %).</p>
<p>Flags: discharge-power limit exceeded, inverter overload, DoD floor reached before the duty ends, and low-voltage cut-off reached.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>Duty: 20 kW for 1 h then 5 kW for 3 h; $\eta_{rt}=0.90$, $DoD=80\%$, 25 °C Li-ion.</p>
$$\sum Pt=20+15=35\ \text{kWh},\quad \eta_{inv}=\sqrt{0.90}=0.9487,\quad E_{req}=\frac{35}{0.9487\times0.80}\times1.25\times1.10=\mathbf{63.4\ kWh}$$</div>` },

{ id: 'dyn-backup', group: 'dynamics', title: 'Backup adequacy & autonomy',
  std: 'Analyse ▸ Sizing & installation',
  kw: 'outage island hybrid inverter bess battery autonomy essential load shed pv',
  html: String.raw`
<p>A snapshot study of what happens when the grid is lost: every utility source is removed and the rest of the network is split into electrical islands (traversal is blocked by open breakers and switches, exactly as in the load flow's source walk). Each island's load is then tested against the backup capability of its hybrid PV inverters and battery units.</p>
<h4>Three checks per island</h4>
<ol>
<li><strong>Inverter capacity.</strong> The island load in kVA must fit within the summed inverter ratings: $S_{load}\le\sum S_{inv}$ — a hybrid inverter's backup output is limited by its rating regardless of battery size.</li>
<li><strong>Discharge power.</strong> The island's load in kW must be covered by the summed battery discharge limits, without PV (night) and with the PV output available at the modelled irradiance.</li>
<li><strong>Autonomy.</strong> Usable battery energy divided by the net island load:
$$t_{aut}=\frac{E_{bat}\,(\text{SoC}-\text{SoC}_{floor})\,\sqrt{\eta_{rt}}}{P_{load}-P_{PV}}$$
reported without and with PV. When PV alone covers the load, the with-PV autonomy is unbounded and reported as null with a note.</li>
</ol>
<p>Loads flagged <code>essential = no</code> (default yes) are assumed shed by the changeover during the outage: excluded from every check and from the autonomy denominator, and reported per island as shed kW. An island that carries load but has no battery-backed source is reported as <em>unbacked</em>.</p>
<div class="hc-note"><span class="hc-label">Snapshot, not a time series</span>State of charge and irradiance are taken as modelled. For a battery that runs down over a day use <a href="#" data-help="flow-timeseries">Time-series load flow</a> or <a href="#" data-help="dyn-battery">Battery sizing</a>.</div>` }

);
