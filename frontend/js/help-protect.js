/* Help articles — protection & safety. Rendered by help.js; TeX between $…$ / $$…$$. */
HELP_ARTICLES.push(

{ id: 'prot-tcc', group: 'protect', title: 'Time-current curves & relay settings',
  std: 'IEC 60255-151 · IEEE C37.112 · IEC 60269 · Analyse ▸ Protection & safety',
  kw: 'idmt tcc curve tds pickup relay 50 51 67 21 mho fuse gg coordination grading',
  html: String.raw`
<p>The TCC chart plots each protective device's operating time against current on log-log axes so the trip times can be graded upstream to downstream. Every curve is evaluated at $M=I/I_{pickup}$, the current multiple; below $M=1$ a relay never operates.</p>
<h4>Inverse-time overcurrent relays</h4>
<p><strong>IEC 60255</strong> curves:</p>
$$t=\text{TDS}\left(\frac{k}{M^{a}-1}+c\right)$$
<p><strong>IEEE C37.112</strong> curves:</p>
$$t=\text{TDS}\left(\frac{A}{M^{p}-1}+B\right)$$
<table class="help-ref-table"><thead><tr><th>Curve</th><th>Constants</th></tr></thead><tbody>
<tr><td>IEC Standard Inverse</td><td>$k=0.14,\ a=0.02,\ c=0$</td></tr>
<tr><td>IEC Very Inverse</td><td>$k=13.5,\ a=1.0,\ c=0$</td></tr>
<tr><td>IEC Extremely Inverse</td><td>$k=80,\ a=2.0,\ c=0$</td></tr>
<tr><td>IEC Long-Time Inverse</td><td>$k=120,\ a=1.0,\ c=0$</td></tr>
<tr><td>IEEE Moderately Inverse</td><td>$A=0.0515,\ p=0.02,\ B=0.114$</td></tr>
<tr><td>IEEE Very Inverse</td><td>$A=19.61,\ p=2.0,\ B=0.491$</td></tr>
<tr><td>IEEE Extremely Inverse</td><td>$A=28.2,\ p=2.0,\ B=0.1217$</td></tr>
<tr><td>Definite time</td><td>$t=\text{TDS}$ (fixed delay above pickup)</td></tr></tbody></table>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>IEC Standard Inverse, TDS = 0.3, pickup 400 A, fault 4 kA: $M=10$.</p>
$$t=0.3\times\frac{0.14}{10^{0.02}-1}=0.3\times\frac{0.14}{0.04713}=\mathbf{0.891\ s}$$</div>
<h4>Relay pickup and CT referral</h4>
<p>A relay's pickup is set in secondary amps; the chart refers it to primary through the CT ratio, $I_{pickup,pri}=I_{set}\times\dfrac{I_{CT,pri}}{I_{CT,sec}}$. A CT that saturates changes the current the relay actually sees — see <a href="#" data-help="prot-ct-pt">CT saturation &amp; PT burden</a>.</p>
<h4>Other characteristics</h4>
<ul>
<li><strong>Circuit breakers</strong> — long-time (thermal) and short-time regions plus an instantaneous (magnetic) pickup, which can be dragged directly on the chart.</li>
<li><strong>Fuses</strong> — generic gG (IEC 60269) pre-arcing curves scaled per rating: one shape, anchored so pre-arcing reaches 0.1 s at $8\times I_n$. Total clearing time is taken as $1.2\times$ the pre-arcing time. Not the per-rating min/max corridor of IEC 60269-1 — use manufacturer data for precise grading.</li>
<li><strong>Directional (67)</strong> — overcurrent curves qualified by a direction setting.</li>
<li><strong>Distance (21)</strong> — mho characteristics in a primary-referred R-X inset diagram.</li>
<li><strong>User curves</strong> — import a time-current table from CSV.</li>
<li><strong>Fault overlay</strong> — vertical markers where the calculated fault currents cross each device curve.</li>
</ul>
<h4>Grading</h4>
<p>Adjacent devices are coordinated when the upstream device is slower than the downstream by a margin at every fault level in between:</p>
$$t_{up}(I)\ \ge\ t_{down}(I)+\Delta t$$
<p>The required margin $\Delta t$ (the coordination time interval) is 0.3 s by default for relay/breaker pairs. Fuses are handled by pair type: a relay or breaker over a <em>downstream</em> fuse needs only 0.2 s (no breaker opening time on the fuse side), an <em>upstream</em> fuse over a relay or breaker needs the full margin, and fuse–fuse pairs are graded by the $I^2t$ ratio rather than a time interval.</p>
<p>The auto-coordination engine walks the topology, grades each relay and breaker against its neighbours, and reports miscoordination. See <a href="#" data-help="prot-sequence">Sequence of operation</a> for the time-ordered check.</p>` },

{ id: 'prot-ct-pt', group: 'protect', title: 'CT saturation & PT burden',
  std: 'IEC 61869-2 (CT) · IEC 61869-3 (PT) · Analyse ▸ Protection & safety ▸ Duty check',
  kw: 'ct current transformer saturation knee point alf accuracy class burden pt voltage transformer',
  html: String.raw`
<h4>CT saturation</h4>
<p>Relay operating times are only right if the CT delivers the primary current faithfully. When a CT saturates, the secondary waveform clips and the relay sees less current — so it operates <em>slower</em> and arc-flash incident energy is <em>higher</em>. The same model is used by the TCC chart, the arc-flash clearing time and the duty check.</p>
<p>Knee-point voltage comes from the accuracy class if not entered directly. For a protection core such as 5P20 (accuracy-limit factor $ALF=20$):</p>
$$V_{AL}=ALF\cdot I_{sn}\,(R_{ct}+R_b),\qquad V_k\approx0.8\,V_{AL},\qquad R_b=\frac{VA_{burden}}{I_{sn}^{2}}$$
<p>$R_{ct}$ defaults to about 0.3 Ω for 5 A secondaries and 3 Ω for 1 A. The primary current at which the core begins to saturate is</p>
$$I_{sat}=\frac{V_k}{R_{ct}+R_b}\times\frac{I_{pri}}{I_{sec}}$$
<p>Above $I_{sat}$ the effective rms current is reduced by a saturation-angle waveform-clipping model. With $k_s=\dfrac{V_k}{I_{sec,ideal}(R_{ct}+R_b)}<1$:</p>
$$\theta=\arccos(1-2k_s),\qquad \eta=\sqrt{\frac{\theta-\tfrac12\sin2\theta}{\pi}},\qquad I_{eff}=I\cdot\max(\eta,0.05)$$
<p>The floor of 5 % keeps a fully saturated CT from reporting zero.</p>
<h5>DC offset</h5>
<p>The IEC 60909 peak factor $\kappa$ at the fault bus derates the knee voltage, $V_k\to V_k/\kappa$. This is a bounded proxy for first-peak asymmetry: a fully offset fault demands $\kappa$ times the flux of a symmetrical one, so the CT saturates sooner. It is <em>not</em> a time-domain flux simulation — no remanence, no saturation recovery mid-fault.</p>
<h5>Adequacy check</h5>
<p>Each protection-relay CT is flagged when its (offset-derated) saturation threshold does not cover the prospective fault current at its bus: $I_{sat}<I''_k$. It is listed in the duty check's "CT Saturation Adequacy" table.</p>
<h4>PT burden</h4>
<p>A PT is never driven near saturation in service; its failure mode is <em>burden mismatch</em>. IEC 61869-3 only guarantees the declared accuracy class within 25–100 % of rated burden (at 80–120 % rated voltage). With connected burden $S_b$ and rated burden $S_r$:</p>
$$\text{loading}=\frac{S_b}{S_r}\times100\%$$
<ul>
<li>&gt; 100 % — <strong>overburdened</strong>: core and secondary IR drop push ratio and phase error outside the class limits (the checkable defect).</li>
<li>&lt; 25 % — <strong>under-burdened</strong>: the standard's test points no longer bracket the operating point (informational).</li>
</ul>
<p>Only PTs that feed a protection or measurement relay (via its <code>associated_pt</code>) are checked.</p>` },

{ id: 'prot-sequence', group: 'protect', title: 'Sequence of operation',
  std: 'Analyse ▸ Protection & safety',
  kw: 'primary backup trip order clearing time grading margin fault type breaker time',
  html: String.raw`
<p>Simulates and verifies the time-ordered sequence in which relays, breakers and fuses operate for a fault at a chosen bus, so you can confirm that the device closest to the fault clears it first and that backup operates only if the primary fails.</p>
<h4>Method</h4>
<ol>
<li><strong>Fault current.</strong> Uses the fault-study results already stored per bus — both $I_{k3}$ and $I_{k1}$ — so a three-phase or SLG sequence needs no re-run.</li>
<li><strong>Protection path.</strong> Walks the topology from the fault back to the source, collecting each device that sees the fault current.</li>
<li><strong>Trip times.</strong> Evaluates each device's curve at the current it carries (CT-saturation aware), then adds the breaker opening time $t_{CB}$ (a setting on the study dialog, default 50 ms) to a relay's operate time:
$$t_{clear}=t_{relay}(I)+t_{CB}$$</li>
<li><strong>Order and margin.</strong> Ranks the devices by clearing time and checks the grading margin between neighbours:
$$\Delta t=t_{clear,backup}-t_{clear,primary}\ \ge\ \Delta t_{min}$$</li>
</ol>
<p>The report is a timeline: primary → backup → final, with the trip time of each and the margin to the next device. A device that sees the fault but has no trip path is flagged; so is any pair whose margin is smaller than required.</p>
<div class="hc-note"><span class="hc-label">Tip</span>Run it for the <em>minimum</em> fault too. A backup that grades well at maximum fault can fail to operate at all — or take tens of seconds — when the fault is at the far end of a long, high-impedance feeder.</div>` },

{ id: 'prot-duty', group: 'protect', title: 'Equipment duty check',
  std: 'IEC 62271-100 · IEC 60947-2 · Analyse ▸ Protection & safety',
  kw: 'breaking capacity making capacity icu icm asymmetrical duty transformer loading busbar',
  html: String.raw`
<p>Compares the calculated fault current with the rated withstand of every protective device, and flags any that is under-rated.</p>
<h4>Circuit breakers and fuses</h4>
<table class="help-ref-table"><thead><tr><th>Check</th><th>Duty</th><th>Capability</th></tr></thead><tbody>
<tr><td>Breaking</td><td>$I_b$ at the device's bus (with motor contribution)</td><td>rated breaking capacity $I_{cu}$ / $I_{cs}$</td></tr>
<tr><td>Making</td><td>peak current $i_p$</td><td>$I_{cm}$ — see below</td></tr>
<tr><td>Asymmetrical breaking</td><td>$I_{b,asym}=\sqrt{I_b^2+i_{dc}^2}$ at 100 ms</td><td>$I_{cu}\sqrt{1+2\beta^{2}}$</td></tr></tbody></table>
<p>When no making rating is entered it is assumed:</p>
<ul>
<li><strong>MV</strong> (IEC 62271-100): $I_{cm}=2.5\,I_{cu}$ at 50 Hz, $2.6\,I_{cu}$ at 60 Hz.</li>
<li><strong>LV</strong> (IEC 60947-2 Table 2): $I_{cm}=n\,I_{cu}$ with $n=1.41$ ($\le4.5$ kA), 1.5 ($\le6$), 1.7 ($\le10$), 2.0 ($\le20$), 2.1 ($\le50$), 2.2 above.</li>
</ul>
<p>Making margin is $(1-i_p/I_{cm})\times100\,\%$. The asymmetrical duty allows for a network whose DC component decays more slowly than the standard $\tau=45$ ms (high $X/R$) — a rating tested at the standard DC component understates such a duty.</p>
<h4>Verdicts</h4>
<ul>
<li><strong>Fail</strong> — duty exceeds capability.</li>
<li><strong>Warning</strong> — utilisation above 80 %, continuous rating exceeded, or making margin under 10 %.</li>
<li><strong>Pass</strong> otherwise.</li>
</ul>
<h4>Transformers and busbars</h4>
<p>Transformer loading from the load flow: fail above 100 %, warning above 80 %. CT saturation and PT burden are reported in their own tables — see <a href="#" data-help="prot-ct-pt">CT &amp; PT</a>.</p>` },

{ id: 'prot-arcflash', group: 'protect', title: 'Arc flash (IEEE 1584-2002)',
  std: 'IEEE 1584-2002 · NFPA 70E · Analyse ▸ Protection & safety',
  kw: 'arc flash incident energy arcing current boundary ppe category clearing time working distance electrode vcb hcb voa cal/cm2 nfpa 70e reduced',
  html: String.raw`
<p>Each bus chooses its edition through <em>Arc Flash Method</em>. New buses default to IEEE 1584-2018 (<a href="#" data-help="prot-arcflash-2018">next article</a>); 2002 remains for byte-identical reproduction of older studies and labels. Everything below the equations — clearing time, PPE, boundary — is common to both.</p>
<h4>1 · Arcing current</h4>
<p>From the bolted three-phase fault current $I_{bf}$ (kA), open-circuit voltage $V$ (kV) and conductor gap $G$ (mm):</p>
$$\log I_a=K+0.662\log I_{bf}+0.0966V+0.000526G+0.5588V\log I_{bf}-0.00304G\log I_{bf}\quad(V\le1\ \text{kV})$$
$$\log I_a=0.00402+0.983\log I_{bf}\quad(V>1\ \text{kV})$$
<p>with $K=-0.153$ (open air) or $-0.097$ (enclosed). $I_a$ is clamped to $I_{bf}$.</p>
<h4>2 · Incident energy</h4>
<p>Normalised to 610 mm and 0.2 s, then scaled to the real time $t$ and distance $D$:</p>
$$\log E_n=K_1+K_2+1.081\log I_a+0.0011G$$
$$E=4.184\,C_f\,E_n\,\frac{t}{0.2}\left(\frac{610}{D}\right)^{x}\ \ [\text{J/cm}^2]\ \Rightarrow\ E\,[\text{cal/cm}^2]=C_f\,E_n\,\frac{t}{0.2}\left(\frac{610}{D}\right)^{x}$$
<table class="help-ref-table"><thead><tr><th>Term</th><th>Value</th></tr></thead><tbody>
<tr><td>$K_1$</td><td>$-0.792$ open air, $-0.555$ enclosed</td></tr>
<tr><td>$K_2$</td><td>$0$ ungrounded / high-resistance grounded, $-0.113$ grounded (unknown ⇒ 0, conservative)</td></tr>
<tr><td>$C_f$</td><td>1.5 for $V\le1$ kV, 1.0 above</td></tr>
<tr><td>$x$ (Table 4)</td><td>open air 2.000; cable 2.000; LV MCC/panel 1.641; LV switchgear 1.473; MV switchgear 0.973</td></tr></tbody></table>
<h4>3 · The reduced-current pass</h4>
<p>Protective devices slow down near their pickup, and a lower arcing current can mean a <em>longer</em> arc. The study therefore runs twice — at the full $I_a$ and at a reduced $I_a$ — evaluates the real clearing time from the device curves at each current, and the <strong>higher</strong> incident energy and the <strong>larger</strong> boundary govern.</p>
$$I_{a,red}=0.85\,I_a\ (V\le1\ \text{kV}),\qquad I_{a,red}=0.90\,I_a\ (V>1\ \text{kV, deliberate conservative extension})$$
<h4>4 · Clearing time</h4>
<p>The upstream device is found from the topology. For a relay: $t=t_{relay}(I_{eff})+t_{CB}$ with $t_{CB}=80$ ms and $I_{eff}$ the CT-saturated current; for a fuse: $1.2\times$ the pre-arcing time; for a breaker: its own characteristic. Capped at 2 s (the arc-sustainability assumption). A small LV transformer (below 125 kVA, under 240 V) is exempt as generally minimal.</p>
<h4>5 · Boundary and PPE</h4>
<p>The arc flash boundary is the distance at which $E$ falls to 1.2 cal/cm² (onset of a second-degree burn), found by bisection on $E(D)$. PPE category follows NFPA 70E:</p>
<table class="help-ref-table"><thead><tr><th>Category</th><th>$E$ (cal/cm²)</th></tr></thead><tbody>
<tr><td>0</td><td>&lt; 1.2</td></tr><tr><td>1</td><td>1.2 – 4</td></tr><tr><td>2</td><td>4 – 8</td></tr><tr><td>3</td><td>8 – 25</td></tr><tr><td>4</td><td>25 – 40</td></tr><tr><td>DANGER</td><td>&gt; 40 — do not work energised</td></tr></tbody></table>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>$I_{bf}=25$ kA, 0.48 kV, $G=32$ mm enclosed (VCB), $D=455$ mm, LV switchgear ($x=1.473$), ungrounded, $t=0.2$ s.</p>
$$\log I_a=-0.097+0.662(1.3979)+0.0966(0.48)+0.000526(32)+0.5588(0.48)(1.3979)-0.00304(32)(1.3979)=1.1306\ \Rightarrow\ I_a=13.5\ \text{kA}$$
$$\log E_n=-0.555+1.081(1.1306)+0.0011(32)=0.7024\ \Rightarrow\ E_n=5.04$$
$$E=1.5\times5.04\times\frac{0.2}{0.2}\times\left(\frac{610}{455}\right)^{1.473}=1.5\times5.04\times1.540=\mathbf{11.6\ cal/cm^2}$$
<p>PPE category 3, arc flash boundary about 2.1 m. Halving the clearing time halves the energy — the most effective single measure.</p></div>
<h4>Applicability (2002)</h4>
<p>208 V–15 kV, three-phase, 50/60 Hz, bolted fault 0.7–106 kA, gaps 13–152 mm, working distance ≥ 305 mm, clearing time up to 2 s. Above 15 kV the Ralph Lee theoretical model applies.</p>
<h4>Reducing the hazard</h4>
<ol>
<li><strong>Shorten clearing time</strong> — energy is directly proportional to it: instantaneous trips, arc-flash detection relays (&lt;35 ms), bus differential (87B), zone-selective interlocking, maintenance-mode switches.</li>
<li><strong>Increase working distance</strong> — roughly inverse-square: $E\propto D^{-x}$.</li>
<li><strong>Reduce available fault current</strong> — current-limiting fuses or reactors.</li>
<li><strong>Change electrode configuration</strong> — open air concentrates less than enclosed.</li>
<li><strong>Remote operation</strong>, or <strong>de-energise</strong> for category 4 / DANGER (NFPA 70E §130.2).</li>
</ol>` },

{ id: 'prot-arcflash-2018', group: 'protect', title: 'Arc flash (IEEE 1584-2018)',
  std: 'IEEE 1584-2018 · Analyse ▸ Protection & safety',
  kw: 'arc flash 2018 three anchor 600 2700 14300 enclosure correction factor cf electrode vcb vcbb hcb voa hoa',
  html: String.raw`
<p>The current edition. Instead of one closed-form fit it is a <strong>three-anchor regression</strong>: arcing current and incident energy are computed at three fixed voltages — 600 V, 2700 V and 14,300 V — from coefficient tables for each electrode configuration (VCB, VCBB, HCB, VOA, HOA), then blended by the system voltage. It adds an enclosure-size correction and has a closed-form boundary.</p>
<h4>1 · Arcing current at each anchor</h4>
$$\log_{10}I_{a,V}=k_1+k_2\log_{10}I_{bf}+k_3\log_{10}G$$
$$I_{a,V}=10^{\,\log_{10}I_{a,V}}\cdot\left(k_4I_{bf}^{6}+k_5I_{bf}^{5}+k_6I_{bf}^{4}+k_7I_{bf}^{3}+k_8I_{bf}^{2}+k_9I_{bf}+k_{10}\right)$$
<h4>2 · Blend by system voltage $V_{oc}$</h4>
<p><strong>Below 600 V</strong>, from the 600 V anchor $I_{600}$:</p>
$$I_a=\left[\left(\frac{0.6}{V_{oc}}\right)^{2}\left(\frac{1}{I_{600}^{2}}-\frac{0.36-V_{oc}^{2}}{0.36\,I_{bf}^{2}}\right)\right]^{-1/2}$$
<p><strong>Above 600 V</strong>, linear interpolation between anchors. With $I_1=\dfrac{I_{2700}-I_{600}}{2.1}(V_{oc}-2.7)+I_{2700}$ and $I_2=\dfrac{I_{14300}-I_{2700}}{11.6}(V_{oc}-14.3)+I_{14300}$:</p>
$$I_a=\begin{cases}I_2 & V_{oc}>2.7\ \text{kV}\\[2pt] I_1\dfrac{2.7-V_{oc}}{2.1}+I_2\dfrac{V_{oc}-0.6}{2.1} & 0.6<V_{oc}\le2.7\ \text{kV}\end{cases}$$
<p>$I_a$ is clamped to $I_{bf}$. A voltage- and configuration-dependent variation factor $\rho(V_{oc})$ gives the reduced current $I_{a,red}=\rho\,I_a$ for the second pass (the reduced-current logic of the 2002 article applies).</p>
<h4>3 · Incident energy at each anchor</h4>
$$E_V=\frac{12.552}{50}\,t\,\cdot10^{\,x_V},\qquad
x_V=k_1+k_2\log G+\frac{k_3I_{a,V}}{\sum_{j=4}^{10}k_jI_{bf}^{\,11-j}}+k_{11}\log I_{bf}+k_{12}\log D+k_{13}\log I_a+\log\frac1{C_F}$$
<p>$t$ in ms, $D$ in mm, $E_V$ in J/cm². Each anchor uses its own coefficient table (Tables 3/4/5). The anchors are blended exactly as the currents are, then converted: $E[\text{cal/cm}^2]=0.2390\,E[\text{J/cm}^2]$. Above 600 V the reduced pass rescales <em>each</em> anchor current by $\rho$, not just the final blend.</p>
<h4>4 · Enclosure size correction $C_F$</h4>
<p>VOA and HOA (open air) always have $C_F=1$. For boxes the equivalent enclosure size $EES=(H_1+W_1)/2$ (inches) is corrected relative to the "typical" 508 × 508 mm test box, with per-configuration coefficients:</p>
$$C_F=b_1\,EES^{2}+b_2\,EES+b_3\ \ (\text{typical}),\qquad C_F=\frac{1}{b_1\,EES^{2}+b_2\,EES+b_3}\ \ (\text{shallow})$$
<p>A box is <em>shallow</em> if $V_{oc}<0.6$ kV, width and height &lt; 508 mm and depth ≤ 203.2 mm. Dimensions above 660.4 mm are scaled by $\dfrac{660.4+(\text{dim}-660.4)(V_{oc}+a)/b}{25.4}$ and capped at 1244.6 mm. Enclosure dimensions of 0 mean "auto from equipment class".</p>
<h4>5 · Arc flash boundary — closed form</h4>
<p>Solving $E_V(D)=1.2$ cal/cm² for $D$ gives an algebraic inverse, so unlike 2002 no bisection is needed:</p>
$$\log D_V=\frac{k_1+k_2\log G+\dfrac{k_3I_{a,V}}{\sum k_jI_{bf}^{11-j}}+k_{11}\log I_{bf}+k_{13}\log I_a+\log\dfrac1{C_F}-\log\dfrac{E_b\,\cdot50/3}{t}}{-k_{12}}$$
<p>and the three anchors are blended as above. The larger of the full- and reduced-current results governs.</p>
<h4>Applicability</h4>
<p>208 V–15 kV; bolted fault 0.5–106 kA ($\le600$ V) or 0.2–65 kA ($>600$ V). Above 15 kV the Ralph Lee model applies. The coefficients were transcribed from the official IEEE 1584-2018 validation spreadsheet; the arcing-current variation polynomial is not published there and was fitted exactly to the seven $V_{oc}$ values the spreadsheet uses. Verified against six spreadsheet rows spanning all five configurations and all three blend regions to under 0.0003 %.</p>` },

{ id: 'prot-dcarcflash', group: 'protect', title: 'DC arc flash',
  std: 'Stokes & Oppenländer (1985) · Ammerman et al. (2010) · DGUV-I 203-077 · Analyse ▸ Protection & safety',
  kw: 'dc arc flash battery ups solar pv rectifier stokes oppenlander incident energy',
  html: String.raw`
<p>For DC systems — battery rooms, UPS, rectifiers, PV DC buses — where the IEEE 1584 AC regressions do not apply.</p>
<h4>Arc as a non-linear resistance</h4>
<p>The arc is a current-dependent resistance in series with the source resistance $R_{sys}=V_{sys}/I_{bolted}$:</p>
$$R_{arc}(I)=\frac{20+0.534\,G}{I^{0.88}},\qquad I_{arc}=\frac{V_{sys}}{R_{sys}+R_{arc}(I_{arc})}$$
<p>solved by fixed-point iteration from $I_{bolted}/2$. The arc voltage is then</p>
$$V_{arc}=I_{arc}R_{arc}=(20+0.534\,G)\,I_{arc}^{0.12}$$
<p>If $V_{sys}\le20+0.534\,G$ the source cannot sustain an arc across that gap and $I_{arc}=0$.</p>
<h4>Incident energy — spherical radiation</h4>
$$P_{arc}=V_{arc}I_{arc},\qquad E_{arc}=P_{arc}\,t,\qquad E_{inc}=\frac{E_{arc}}{4\pi D^{2}}\ \ [\text{J/m}^2]$$
$$E[\text{cal/cm}^2]=\frac{E_{inc}}{41868}$$
<p>The boundary follows analytically: $D_{AFB}=\sqrt{\dfrac{E_{arc}}{4\pi\cdot41868\cdot1.2}}$.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>250 V DC, $I_{bolted}=4$ kA ($R_{sys}=0.0625\ \Omega$), gap 25 mm, $t=0.1$ s, $D=455$ mm.</p>
<p>$20+0.534\times25=33.35$. Iterating $I=250/\big(0.0625+33.35/I^{0.88}\big)$ converges to $I_{arc}=2.63$ kA (66 % of bolted), so $V_{arc}=33.35\times2627^{0.12}=85.8$ V, $P_{arc}=225$ kW and $E_{arc}=22.5$ kJ. Then</p>
$$E_{inc}=\frac{22\,540}{4\pi(0.455)^2}=8.66\ \text{kJ/m}^2\ \Rightarrow\ E=\frac{8660}{41868}=\mathbf{0.21\ cal/cm^2},\qquad D_{AFB}=189\ \text{mm}$$</div>
<p>Valid for 48–1500 V DC, gaps 13–152 mm, working distance ≥ 305 mm, clearing time up to 2 s. PPE category follows NFPA 70E as for AC.</p>` },

{ id: 'prot-grounding', group: 'protect', title: 'Substation grounding (IEEE 80)',
  std: 'IEEE 80-2013 · Analyse ▸ Earthing & lightning',
  kw: 'grid resistance gpr touch step mesh voltage ground potential rise crushed rock surface layer soil resistivity two layer onderdonk decrement',
  html: String.raw`
<p>Designs and checks a ground grid: does it keep touch and step voltages within what a person can tolerate, and is the conductor big enough for the fault? Inputs are set on the bus: soil resistivity $\rho$, grid dimensions, conductor and rods, surface layer and fault duration.</p>
<h4>1 · Tolerable voltages</h4>
<p>For a body weight of 70 kg (0.157) or 50 kg (0.116), fault duration $t_s$ and surface-layer resistivity $\rho_s$:</p>
$$E_{touch}=\frac{(1000+1.5\,C_s\,\rho_s)\,k}{\sqrt{t_s}},\qquad E_{step}=\frac{(1000+6\,C_s\,\rho_s)\,k}{\sqrt{t_s}}$$
$$C_s=1-\frac{0.09\,(1-\rho/\rho_s)}{2h_s+0.09}$$
<p>$h_s$ is the surface-layer thickness. A high-resistivity crushed-rock layer raises the tolerable limits.</p>
<h4>2 · Grid resistance and ground potential rise</h4>
$$R_g=\rho\left[\frac1{L_T}+\frac1{\sqrt{20A}}\left(1+\frac1{1+h\sqrt{20/A}}\right)\right],\qquad \text{GPR}=I_G\,R_g$$
<p>$A$ is the grid area, $L_T$ total buried conductor length and $h$ burial depth. The grid current includes the decrement factor for the DC offset over the fault duration:</p>
$$I_G=D_f\,S_f\,I_{0},\qquad D_f=\sqrt{1+\frac{T_a}{t_f}\left(1-e^{-2t_f/T_a}\right)},\quad T_a=\frac{X/R}{2\pi f}$$
<p>$X/R$ is derived from the bus $\kappa$ ($R/X=-\tfrac13\ln\frac{\kappa-1.02}{0.98}$). The current split factor is $S_f=1$ (conservative).</p>
<h4>3 · Mesh and step voltage</h4>
$$E_m=\frac{\rho\,I_G\,K_m\,K_i}{L_M},\qquad E_s=\frac{\rho\,I_G\,K_s\,K_i}{L_S}$$
$$K_m=\frac{1}{2\pi}\left[\ln\!\left(\frac{D^{2}}{16hd}+\frac{(D+2h)^{2}}{8Dd}-\frac{h}{4d}\right)+\frac{K_{ii}}{K_h}\ln\frac{8}{\pi(2n-1)}\right],\quad K_h=\sqrt{1+h}$$
$$K_s=\frac1\pi\left[\frac1{2h}+\frac1{D+h}+\frac1D\left(1-0.5^{\,n-2}\right)\right],\qquad K_i=0.644+0.148\,n$$
<p>$D$ is conductor spacing, $d$ conductor diameter, $n=n_an_bn_cn_d$ the effective number of parallel conductors (for a rectangular grid $n_a=2L_c/L_p$, $n_b=\sqrt{L_p/4\sqrt A}$, $n_c=n_d=1$). $K_{ii}=1$ with perimeter rods, otherwise $1/(2n)^{2/n}$. Effective lengths: $L_M=L_c+L_{rod}$ without rods; with rods $L_M=L_c+\left[1.55+1.22\dfrac{L_r}{\sqrt{L_x^2+L_y^2}}\right]L_R$; and $L_S=0.75L_c+0.85L_{rod}$.</p>
<h4>4 · Verdict</h4>
<p><strong>Fail</strong> if the mesh voltage exceeds the tolerable touch voltage or the step voltage exceeds the tolerable step voltage. <strong>Warning</strong> if both are met but GPR exceeds the tolerable touch voltage (a remote person or a metallic path could still import that potential — verify transferred potentials). <strong>Pass</strong> otherwise; if GPR is below the touch limit the grid is inherently safe.</p>
<h4>5 · Minimum conductor size (Onderdonk)</h4>
$$A\,[\text{mm}^2]=I\,[\text{kA}]\sqrt{K_f^{2}\,t_c},\qquad K_f^{2}=\frac{\alpha_r\,\rho_r\cdot10^{4}}{TCAP\cdot\ln\!\left(1+\dfrac{T_m-T_a}{K_0+T_a}\right)}$$
<p>with the conductor material's constants ($\alpha_r$, $\rho_r$ in µΩ·cm, $K_0$, fusing temperature $T_m$, $TCAP$), ambient $T_a$ (default 40 °C) and fault-clearing time $t_c$, then rounded up to a standard size (16–300 mm²).</p>
<h4>Two-layer soil</h4>
<p>When the native soil is layered (upper $\rho_1$, thickness $h_1$, over $\rho_2$) an equivalent resistivity replaces $\rho$ in the grid-<em>resistance</em> formula only (mesh and step keep $\rho_1$, where the grid and feet actually are):</p>
$$\rho_{eq}=\rho_1F(K,h_{rel},r_0),\quad K=\frac{\rho_2-\rho_1}{\rho_2+\rho_1},\quad r_0=\sqrt{A/\pi}$$
<p>from the method of images (Sunde / Tagg). Anchors: $\rho_{eq}\to\rho_1$ for a thick top layer, $\to\rho_2$ as $h_1\to0$.</p>
<h4>Wenner four-pin test interpreter</h4>
<p>Fits $(\rho_1,\rho_2,h_1)$ to field readings of apparent resistivity $\rho_a(a)$ at probe spacings $a$ by non-linear least squares, using the same two-layer forward model:</p>
$$\rho_a(a)=\rho_1\left[1+4\sum_{n=1}^{\infty}K^{n}\left(\frac{1}{\sqrt{1+(2nh_1/a)^{2}}}-\frac{1}{\sqrt{4+(2nh_1/a)^{2}}}\right)\right]$$
<p>The fitted model can then be applied to the grid design above.</p>` },

{ id: 'prot-lightning', group: 'protect', title: 'Lightning risk (IEC 62305-2)',
  std: 'IEC 62305-2:2010 · Analyse ▸ Earthing & lightning',
  kw: 'lightning risk r1 lps spd collection area ng flash density structure service line tolerable',
  html: String.raw`
<p>Evaluates the risk $R_1$ of loss of human life for a rectangular structure with connected service lines, and recommends the minimum protection — an LPS class and coordinated surge protection (SPD) level — that brings $R_1$ within the tolerable limit $R_T=10^{-5}$ per year (IEC 62305-2 Table 7). Assessments are named and saved in the project.</p>
<h4>1 · Collection areas (m²)</h4>
<p>For length $L$, width $W$, height $H$, and a service line of length $L_L$:</p>
$$A_D=LW+2(3H)(L+W)+\pi(3H)^2,\qquad A_M=2\cdot500(L+W)+\pi\cdot500^2$$
$$A_L=40\,L_L,\qquad A_I=4000\,L_L$$
<h4>2 · Dangerous events per year</h4>
<p>With ground flash density $N_G$ (flashes/km²/yr), location factor $C_D$, and line factors $C_I$, $C_E$, $C_T$ (installation, environment, transformer — $C_T=0.2$ for a line with a HV/LV transformer):</p>
$$N_D=N_GA_DC_D\,10^{-6},\quad N_M=N_GA_M\,10^{-6},\quad N_L=N_GA_LC_IC_EC_T\,10^{-6},\quad N_I=N_GA_IC_IC_EC_T\,10^{-6}$$
<h4>3 · Risk components</h4>
$$R_A=N_DP_AL_A,\ \ R_B=N_DP_BL_B,\ \ R_M=N_MP_ML_M$$
$$R_U=N_LP_UL_U,\ \ R_V=N_LP_VL_V,\ \ R_W=N_LP_WL_W,\ \ R_Z=N_IP_ZL_Z$$
$$R_1=R_A+R_B+R_C^{*}+R_M^{*}+R_U+R_V+R_W^{*}+R_Z^{*}$$
<p>(* only where failure of internal systems endangers life — hospitals and structures at risk of explosion.) $P_B$ depends on the LPS class ($1.0$ none, $0.2$ IV, $0.1$ III, $0.05$ II, $0.02$ I); the SPD-dependent probabilities are 1.0 with none, 0.05 (III-IV), 0.02 (II) and 0.01 (I). With $K_{S1}=K_{S2}=1$ (no spatial-shielding credit), $P_{MS}=(K_{S3}K_{S4})^{2}$.</p>
<h4>4 · Loss factors (Annex C)</h4>
$$L_A=r_tL_T\frac{n_z}{n_t}\frac{t_z}{8760},\qquad L_B=r_pr_fh_zL_F\frac{n_z}{n_t}\frac{t_z}{8760},\qquad L_C=L_O\frac{n_z}{n_t}\frac{t_z}{8760}$$
<h4>5 · Decision</h4>
<p>If $R_1\le10^{-5}$ no protection is needed. Otherwise the engine walks a ladder of increasing protection — no LPS + SPD III-IV, LPS IV + SPD III-IV, LPS III + SPD III-IV, LPS II + SPD II, LPS I + SPD I — and recommends the first rung whose $R_1\le R_T$. If even LPS I with SPD I fails, it says so and lists the further measures needed (spatial shielding, fire suppression, restricted occupancy, re-routed lines).</p>
<div class="hc-warn">Simplifications, conservative where they matter: a single zone covering the structure ($n_z=n_t$ unless overridden); no adjacent-structure flashes ($N_{DJ}=0$); loss of cultural heritage ($R_3$), public service ($R_2$) and economic loss ($R_4$) are not evaluated.</div>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>A 30 m × 20 m × 8 m building, no lines: $A_D=600+2(24)(50)+\pi(24)^2=600+2400+1809=4809\ \text{m}^2$. At $N_G=6$ and $C_D=1$, $N_D=6\times4809\times10^{-6}=\mathbf{0.0289}$ dangerous events a year — one strike roughly every 35 years.</p></div>` },

{ id: 'prot-compliance', group: 'protect', title: 'Compliance report',
  std: 'IEC 60909 · IEC 60364 · IEC 62271 · IEC 60947 · SANS 10142-1 · Analyse ▸ Protection & safety',
  kw: 'compliance sans 10142 pass fail warning earth fault disconnection rcd earthing tn tt it maximum demand voltage tolerance',
  html: String.raw`
<p>Cross-checks the analysis results against standards limits and produces a pass / warning / fail report. Each section says what to run first; a check whose input is missing reports <em>info</em> with how to supply it, never a silent pass.</p>
<h4>Sections</h4>
<table class="help-ref-table"><thead><tr><th>Section</th><th>Test</th></tr></thead><tbody>
<tr><td>Network validation</td><td>topology is valid: components connected, sources and buses present, a swing bus defined</td></tr>
<tr><td>Fault duty (IEC 60909)</td><td>breaking / making capability against $I_b$ and $i_p$ — see <a href="#" data-help="prot-duty">Duty check</a></td></tr>
<tr><td>Voltage compliance (IEC 60038)</td><td>bus voltage within ±10 % of nominal (LV: SANS 10142-1 Cl. 5.3.2 / NRS 048-2)</td></tr>
<tr><td>Thermal loading</td><td>$|I|/I_{rated}$ for cables, $|S|/S_r$ for transformers</td></tr>
<tr><td>Cable short-circuit withstand</td><td>adiabatic $S\ge I_{th}\sqrt t/k$ — see <a href="#" data-help="cable-sizing">Cable sizing</a></td></tr>
<tr><td>Protection device ratings</td><td>rated current, voltage and breaking capacity</td></tr>
<tr><td>Motor circuit protection (IEC 60947-4-1)</td><td>protective device against motor full-load current, on dedicated single-motor feeders only (a shared feeder can legitimately be rated below the sum of its loads)</td></tr>
<tr><td>PV DC string design (IEC 62548)</td><td>string $V_{oc}$ at the coldest site temperature and $V_{mp}$ at the hottest cell temperature against the inverter's DC-maximum and MPPT windows; MPPT input current with a 1.25 factor</td></tr>
<tr><td>SANS 10142-1</td><td>see below</td></tr></tbody></table>
<h4>SANS 10142-1 checks</h4>
<ul>
<li><strong>Cl. 5.5.2 — overcurrent coordination:</strong> $I_n\le I_z$ (device rating not above cable ampacity).</li>
<li><strong>Cl. 5.6.3 — minimum conductor size:</strong> 1.5 mm² Cu for fixed wiring; 2.5 mm² for socket-outlet circuits.</li>
<li><strong>Cl. 8.3.1 — neutral earthing:</strong> LV source neutral earthed for TN/TT; insulation monitoring for IT.</li>
<li><strong>Cl. 6 / IEC 60364-1 §312 — earthing system:</strong> RCD not permitted on a PEN (TN-C); RCD mandatory on TT with $R_A\,I_{\Delta n}\le50$ V; IMD required on IT.</li>
<li><strong>Appendix B / NRS 034 — maximum demand:</strong> demand must not exceed supply capacity; warning above 80 % utilisation.</li>
<li><strong>Cl. 5.5.6 — earth-fault disconnection:</strong> the device's operating time evaluated at the earth-fault current must meet the limit — 0.4 s for final circuits up to 32 A, 5 s for distribution circuits. Uses the <em>minimum</em> current basis ($c_{min}=0.95$, hot conductors; IEC 60909-0 §5.3.1). For TN with no evaluable curve, the criterion falls back to $I_{k1}\ge10\,I_n$.</li>
<li><strong>Cl. 6.6 — voltage drop:</strong> total from the point of supply (3 % lighting, 5 % general); the per-way check is in <a href="#" data-help="cable-dbcheck">DB circuit check</a>.</li>
</ul>` }

);
