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
<p>IEC 60255-151 specifies the inverse characteristic up to $G_D=20\times$ the setting, and relays hold the operate time at $t(20)$ above it. The chart does the same, so the curve goes flat beyond 20× pickup. The relay's <em>Curve Limit</em> changes the multiple, and 0 removes the limit. Without the hold an Extremely Inverse curve would be 84 % faster at 50× than at 20×.</p>
<div class="hc-example"><span class="hc-label">Worked example</span>
<p>IEC Standard Inverse, TDS = 0.3, pickup 400 A, fault 4 kA: $M=10$.</p>
$$t=0.3\times\frac{0.14}{10^{0.02}-1}=0.3\times\frac{0.14}{0.04713}=\mathbf{0.891\ s}$$</div>
<h4>Relay pickup and CT referral</h4>
<p>A relay's pickup is set in secondary amps; the chart refers it to primary through the CT ratio, $I_{pickup,pri}=I_{set}\times\dfrac{I_{CT,pri}}{I_{CT,sec}}$. A CT that saturates changes the current the relay actually sees — see <a href="#" data-help="prot-ct-pt">CT saturation &amp; PT adequacy</a>.</p>
<h4>Other characteristics</h4>
<ul>
<li><strong>Circuit breakers</strong> — long-time (thermal) and short-time regions plus an instantaneous (magnetic) pickup, which can be dragged directly on the chart. The thermal region is $t=k/(M^2-M_{nt}^2)$, with its asymptote at the conventional non-tripping current: $M_{nt}=1.13$ for an MCB (IEC 60898-1) and 1.05 for an MCCB or ACB (IEC 60947-2). For an MCCB or ACB, $k=\text{class}\times(36-M_{nt}^2)$, so the class is the trip time in seconds at $6\times I_r$. An MCB trips in 30 s at $2.55\,I_n$, the middle of the IEC 60898-1 1–60 s band.</li>
<li><strong>Fuses</strong> — representative gG (IEC 60269) pre-arcing curves, fitted per rating to the IEC 60269-1 gates. The curve passes $1.6\,I_n$ at 600 s and the geometric middle of the 10 s / 5 s gate currents at 7.07 s. It also passes the geometric middle of the two 0.1 s gate currents at 0.1 s. Below 0.1 s it steepens to 0.01 s at twice that current, which keeps the 0.01 s pre-arcing $I^2t$ inside the standard's corridor. Total clearing time is taken as $1.2\times$ the pre-arcing time. This is a mid-corridor curve, not a manufacturer's; use manufacturer data for precise grading.</li>
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

{ id: 'prot-ct-pt', group: 'protect', title: 'CT saturation & PT adequacy',
  std: 'IEC 61869-2 (CT) · IEC 61869-3 (PT) · Analyse ▸ Protection & safety ▸ Duty check',
  kw: 'ct current transformer saturation knee point alf accuracy class burden pt voltage transformer vt voltage factor earth fault factor effectively earthed',
  html: String.raw`
<h4>CT saturation</h4>
<p>Relay operating times are only right if the CT delivers the primary current faithfully. When a CT saturates, the secondary waveform clips and the relay sees less current — so it operates <em>slower</em> and arc-flash incident energy is <em>higher</em>. The same model is used by the TCC chart, the arc-flash clearing time and the duty check.</p>
<p>The core is modelled as an ideal square loop: the CT reproduces the current until the secondary EMF reaches the saturation EMF $V_{sat}$, then delivers nothing for the rest of the half-cycle. From a protection class such as 5P20 ($ALF=20$), $V_{sat}$ is the IEC 61869-2 accuracy-limit EMF at <em>rated</em> burden; an entered knee point (e.g. class PX) is used directly, and an IEEE C-class gives $V_C+20\,I_{sn}R_{ct}$:</p>
$$V_{sat}=ALF\cdot I_{sn}\,(R_{ct}+R_{b,rated}),\qquad R_b=\frac{VA}{I_{sn}^{2}}$$
<p>The CT drives its <em>connected</em> burden (relay plus leads), so saturation starts at</p>
$$I_{sat}=\frac{V_{sat}}{R_{ct}+R_{b,conn}}\times\frac{I_{pri}}{I_{sec}},\qquad ALF'=ALF\,\frac{R_{ct}+R_{b,rated}}{R_{ct}+R_{b,conn}}$$
<p>$R_{ct}$ defaults to about 0.3 Ω for 5 A secondaries and 3 Ω for 1 A; connected burden defaults to rated. Long leads on a 5 A secondary can halve $ALF'$.</p>
<p>Above $I_{sat}$ the secondary is clipped. A numerical relay measures the <em>fundamental</em> (DFT) of the clipped wave, which is lower than its rms. With $k_s=\dfrac{V_{sat}}{I_{sec,ideal}(R_{ct}+R_{b,conn})}<1$:</p>
$$\theta=\arccos(1-2k_s),\qquad \eta_1=\frac{\sqrt{\left(\theta-\tfrac12\sin2\theta\right)^2+\sin^4\theta}}{\pi},\qquad I_{eff}=I\cdot\max(\eta_1,0.05)$$
<p>This symmetrical model is what the TCC chart plots.</p>
<h5>DC offset</h5>
<p>A fully offset fault needs far more flux than a symmetrical one: the IEC 61869-2 transient factor is $K_{tf}=1+\omega T_p\,(1-e^{-t/T_p})$, up to $1+X/R$. Arc-flash clearing time therefore simulates the square-loop CT in the time domain under a fully offset fault ($X/R$ from the bus $\kappa$, zero remanence), runs the relay over the measured fundamental, and adds the extra operate time compared with a symmetrical fault. A CT can saturate transiently even when it is ample symmetrically. Remanence is not modelled; it can only make saturation earlier.</p>
<h5>Adequacy check</h5>
<p>Each protection-relay CT is flagged when $I_{sat}<I''_k$ at its bus (Ik1 for a core-balance CT) — the class criterion, $ALF'\ge I''_k/I_{pn}$ — with a warning under 20 % headroom. The table also gives the time a fully offset fault takes to saturate the core, $t_s=-T_p\ln\!\left(1-\dfrac{K_s-1}{\omega T_p}\right)$ with $K_s=V_{sat}/(I_{sec}Z)$ (IEEE C37.110). Differential (87) and distance (21) relays need transient dimensioning (Ktd), which is flagged but not checked. Guessed accuracy classes (PX without a knee, metering cores, unrecognised strings) warn.</p>
<h4>PT burden</h4>
<p>A PT is never driven near saturation in service; its failure mode is <em>burden mismatch</em>. IEC 61869-3 only guarantees the declared accuracy class within 25–100 % of rated burden for burden range II (at 80–120 % rated voltage). With connected burden $S_b$ and rated burden $S_r$:</p>
$$\text{loading}=\frac{S_b}{S_r}\times100\%$$
<ul>
<li>&gt; 100 % — <strong>overburdened</strong>: core and secondary IR drop push ratio and phase error outside the class limits (the checkable defect).</li>
<li>&lt; 25 % — <strong>under-burdened</strong>: the standard's test points no longer bracket the operating point (informational).</li>
</ul>
<p>Burden range I (1–10 VA at unity pf, rated below 10 VA) is classed from 0 VA, so it has no lower limit.</p>
<h4>PT voltage and voltage factor</h4>
<p>The rated primary $U_{pr}$ is matched to the bus line voltage $U_n$ or phase voltage $U_n/\sqrt3$, whichever is nearer. A declared phase-to-phase connection always uses $U_n$. Service voltage above 120 % of $U_{pr}$ exceeds the 1.2 continuous factor every VT carries (fail). Below 80 % it is outside the measuring accuracy range (warning).</p>
<p>A phase-to-earth winding also sees the healthy-phase rise of an earth fault. The earth fault factor at the bus comes from the fault study's sequence impedances ($Z_2=Z_1$):</p>
$$k=\max\left|a^2-\frac{Z_0-Z_1}{2Z_1+Z_0}\right|,\ \left|a-\frac{Z_0-Z_1}{2Z_1+Z_0}\right|$$
<p>It equals 1 for $Z_0=Z_1$ and $\sqrt3$ with no zero-sequence path. The required voltage factor is $k\cdot U/U_{pr}$, compared with the declared rated voltage factor (IEC 61869-3 Table 303). A bus with $k\le1.4$ is effectively earthed and 1.5 for 30 s suffices. Otherwise the VT needs 1.9: for 30 s only if earth faults are tripped automatically, else for 8 h. An undeclared voltage factor on a non-effectively earthed bus warns.</p>
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
  std: 'IEC 62271-100 · IEC 62271-1 · IEC 60947-2 · IEC 60269 · IEC 60038 · Analyse ▸ Protection & safety',
  kw: 'breaking capacity making capacity icu icm asymmetrical duty transformer loading busbar',
  html: String.raw`
<p>Compares the calculated fault current with the rated withstand of every protective device, and flags any that is under-rated.</p>
<h4>Circuit breakers and fuses</h4>
<table class="help-ref-table"><thead><tr><th>Check</th><th>Duty</th><th>Capability</th></tr></thead><tbody>
<tr><td>Breaking — LV breaker, fuse</td><td>largest <em>prospective</em> phase current of any fault type, $\max(I''_{k3},I''_{k1},I''_{kLL})$ — IEC 60947-2 and IEC 60269 rate against the prospective current, with no decay credit</td><td>$I_{cu}$ / fuse breaking capacity</td></tr>
<tr><td>Breaking — MV breaker</td><td>$\max(I_b,\ I''_{k1},\ I''_{kLL})$ — the decayed breaking current for the balanced fault (IEC 62271-100); unbalanced faults take $I_b=I''_k$ (IEC 60909-0 §9)</td><td>rated short-circuit breaking current</td></tr>
<tr><td>Making</td><td>peak $i_p=\kappa\sqrt2\,I''_{k,max}$</td><td>$I_{cm}$ — see below</td></tr>
<tr><td>Asymmetrical breaking (MV only)</td><td>$\sqrt{I_b^2+i_{dc}^2}$ at contact parting</td><td>$I_{sc}\sqrt{1+2\beta^{2}}$</td></tr>
<tr><td>Short-time withstand (ACB with a short-time delay)</td><td>$I^2 t_{sd}$</td><td>$I_{cw}^2\,t_{cw}$ (IEC 60947-2)</td></tr>
<tr><td>Voltage</td><td>system voltage; for MV the highest voltage $U_m$ (IEC 60038: 12 kV for 11 kV, 24 for 22, 36 for 33)</td><td>rated voltage — fail below the nominal, warning below $U_m$</td></tr></tbody></table>
<p>The double-line-to-ground field of the fault study is the earth current $3I_0$, not a current any pole interrupts, so it is not used. A device on a distribution board is checked at the board's fault level. Contact parting defaults to 0.1 s, where the fault study evaluates $I_b$; a faster MV breaker (<em>Contact Parting Time</em> below 0.1 s) is checked on the undecayed $I''_k$ with its DC component re-evaluated at that time.</p>
<p>When no making rating is entered it is assumed:</p>
<ul>
<li><strong>MV</strong> (IEC 62271-100): $I_{cm}=2.5\,I_{cu}$ at 50 Hz, $2.6\,I_{cu}$ at 60 Hz.</li>
<li><strong>LV</strong> (IEC 60947-2 Table 2): $I_{cm}=n\,I_{cu}$ with $n=1.41$ ($\le4.5$ kA), 1.5 ($\le6$), 1.7 ($\le10$), 2.0 ($\le20$), 2.1 ($\le50$), 2.2 above.</li>
</ul>
<p>Making margin is $(1-i_p/I_{cm})\times100\,\%$. The asymmetrical duty allows for a network whose DC component decays more slowly than the standard $\tau=45$ ms (high $X/R$) — a rating tested at the standard DC component understates such a duty.</p>
<h4>Verdicts</h4>
<ul>
<li><strong>Fail</strong> — duty exceeds capability.</li>
<li><strong>Warning</strong> — utilisation above 80 %, continuous rating exceeded, making margin under 10 %, or an MV rated voltage below $U_m$.</li>
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
<p>This article is the IEEE 80 <em>simplified</em> method for an equally spaced rectangular grid. For diagonal conductors, uneven spacing, L-shapes, rods anywhere or fences, give the bus an <strong>earth grid</strong>, solved numerically: see <a href="#" data-help="prot-earth-grid">Earth grids of any shape</a>. For EN 50522 limits see <a href="#" data-help="prot-en50522">Touch voltage to EN 50522</a>.</p>
<h4>1 · Tolerable voltages</h4>
<p>For a body weight of 70 kg (0.157) or 50 kg (0.116), fault duration $t_s$ and surface-layer resistivity $\rho_s$:</p>
$$E_{touch}=\frac{(1000+1.5\,C_s\,\rho_s)\,k}{\sqrt{t_s}},\qquad E_{step}=\frac{(1000+6\,C_s\,\rho_s)\,k}{\sqrt{t_s}}$$
$$C_s=1-\frac{0.09\,(1-\rho/\rho_s)}{2h_s+0.09}$$
<p>$h_s$ is the surface-layer thickness. A high-resistivity crushed-rock layer raises the tolerable limits.</p>
<p>On an earth grid, a <b>footwear resistance</b> $R_{shoe}$ (Ω per foot) can be credited, as CDEGS SESThreshold does: each shoe is in series with its foot, so the touch limit becomes $(1000+1.5\,C_s\rho_s+R_{shoe}/2)\,k/\sqrt{t_s}$ and the step limit $(1000+6\,C_s\rho_s+2R_{shoe})\,k/\sqrt{t_s}$. 0 (the default) is the equations above.</p>
<h4>2 · Grid resistance and ground potential rise</h4>
$$R_g=\rho\left[\frac1{L_T}+\frac1{\sqrt{20A}}\left(1+\frac1{1+h\sqrt{20/A}}\right)\right],\qquad \text{GPR}=I_G\,R_g$$
<p>$A$ is the grid area, $L_T$ total buried conductor length and $h$ burial depth. The grid current includes the decrement factor for the DC offset over the fault duration:</p>
$$I_G=D_f\,S_f\,I_{0},\qquad D_f=\sqrt{1+\frac{T_a}{t_f}\left(1-e^{-2t_f/T_a}\right)},\quad T_a=\frac{X/R}{2\pi f}$$
<p>$X/R$ is derived from the bus $\kappa$ ($R/X=-\tfrac13\ln\frac{\kappa-1.02}{0.98}$). $I_0$ is the share of the earth-fault current fed from remote sources: current that returns through a transformer or generator neutral at the bus stays in the grid conductors (§15.1). The split factor $S_f$ (§15.9, Annex C) is a bus input, 1 by default (conservative).</p>
<h4>3 · Mesh and step voltage</h4>
$$E_m=\frac{\rho\,I_G\,K_m\,K_i}{L_M},\qquad E_s=\frac{\rho\,I_G\,K_s\,K_i}{L_S}$$
$$K_m=\frac{1}{2\pi}\left[\ln\!\left(\frac{D^{2}}{16hd}+\frac{(D+2h)^{2}}{8Dd}-\frac{h}{4d}\right)+\frac{K_{ii}}{K_h}\ln\frac{8}{\pi(2n-1)}\right],\quad K_h=\sqrt{1+h}$$
$$K_s=\frac1\pi\left[\frac1{2h}+\frac1{D+h}+\frac1D\left(1-0.5^{\,n-2}\right)\right],\qquad K_i=0.644+0.148\,n$$
<p>$D$ is conductor spacing, $d$ conductor diameter, $n=n_an_bn_cn_d$ the effective number of parallel conductors (for a rectangular grid $n_a=2L_c/L_p$, $n_b=\sqrt{L_p/4\sqrt A}$, $n_c=n_d=1$). $K_{ii}=1$ with perimeter rods, otherwise $1/(2n)^{2/n}$. Effective lengths: $L_M=L_c+L_{rod}$ without rods; with rods $L_M=L_c+\left[1.55+1.22\dfrac{L_r}{\sqrt{L_x^2+L_y^2}}\right]L_R$; and $L_S=0.75L_c+0.85L_{rod}$.</p>
<h4>4 · Verdict</h4>
<p><strong>Fail</strong> if the mesh voltage exceeds the tolerable touch voltage or the step voltage exceeds the tolerable step voltage. <strong>Warning</strong> if both are met but GPR exceeds the tolerable touch voltage (a remote person or a metallic path could still import that potential — verify transferred potentials). <strong>Pass</strong> otherwise; if GPR is below the touch limit the grid is inherently safe.</p>
<h4>5 · Minimum conductor size (Onderdonk)</h4>
$$A\,[\text{mm}^2]=I\,[\text{kA}]\sqrt{K_f^{2}\,t_c},\qquad K_f^{2}=\frac{\alpha_r\,\rho_r\cdot10^{4}}{TCAP\cdot\ln\!\left(1+\dfrac{T_m-T_a}{K_0+T_a}\right)}$$
<p>with the conductor material's constants ($\alpha_r$, $\rho_r$ in µΩ·cm, $K_0$, fusing temperature $T_m$, $TCAP$), ambient $T_a$ (default 40 °C) and fault-clearing time $t_c$, then rounded up to a standard size (16–300 mm²). The bus's <em>Conductor Size</em> (mm²) is checked against it: a smaller conductor fails the study. The grid geometry uses the size's solid-equivalent diameter $d=\sqrt{4A/\pi}$.</p>
<h4>Selected bus only</h4>
<p>With one or more buses selected, the study asks whether to evaluate only those. The fault study still covers the whole network, because each bus's earth-fault current depends on it.</p>
<h4>Two-layer soil</h4>
<p>The simplified equations are for uniform soil (IEEE 80 §16.2.3). With two-layer soil on (upper $\rho_1$, thickness $h_1$, over $\rho_2$, $K=\frac{\rho_2-\rho_1}{\rho_2+\rho_1}$), the same grid is solved numerically twice by the method of moments — once in the layered soil, once in uniform $\rho_1$ — and the uniform IEEE 80 values of $R_g$, $E_m$ and $E_s$ are multiplied by the ratios the layering produces. A resistive lower layer ($K>0$) raises the surface gradients inside the grid; a conductive one lowers the resistance. An earth grid object solves layered soil directly instead of by ratios.</p>
<h4>Wenner four-pin test interpreter</h4>
<p>Fits $(\rho_1,\rho_2,h_1)$ to field readings of apparent resistivity $\rho_a(a)$ at probe spacings $a$ by non-linear least squares, using the same two-layer forward model:</p>
$$\rho_a(a)=\rho_1\left[1+4\sum_{n=1}^{\infty}K^{n}\left(\frac{1}{\sqrt{1+(2nh_1/a)^{2}}}-\frac{1}{\sqrt{4+(2nh_1/a)^{2}}}\right)\right]$$
<p>The fitted model can then be applied to the grid design above.</p>` },

{ id: 'prot-earth-grid', group: 'protect', title: 'Earth grids of any shape (numerical)',
  std: 'IEEE 80-2013 §16.8, Annex H · Analyse ▸ Earthing & lightning ▸ Earth grids',
  kw: 'earth grid diagonal conductor uneven spacing l shaped rods fence separately earthed bonded transfer voltage method of moments numerical touch step heatmap surface potential cdegs etap winigs annex h annex b epri equipotential image series two layer soil sunde thin wire kernel element length convergence validation limitations footwear decrement split factor onderdonk conductor size connectivity drawn touch area hover 3d',
  html: String.raw`
<p>An <strong>earth grid</strong> is described once in the project and any number of buses use it (bus ▸ Grounding ▸ Earth Grid). It can have any layout: diagonal conductors, uneven spacing, an L-shaped outline, rods anywhere and of any length, fences bonded to the grid or separately earthed, and conductors added by hand. A bus without an earth grid keeps the per-bus IEEE 80 calculation (<a href="#" data-help="prot-grounding">Substation grounding</a>), unchanged.</p>
<h4>1 · Why a numerical method</h4>
<p>The IEEE 80 simplified equations (§16.5, Annex D) describe an equally spaced square, rectangular, T, triangular or L-shaped mesh in uniform soil, with rods at the perimeter or throughout. They were fitted to computer solutions over a stated range (§16.7): grid area 6.25–10 000 m², 1–40 meshes along a side, mesh 2.5–22.5 m, uniform soil, uniform spacing. IEEE 80 §16.8 calls for computer analysis instead when parameters fall outside those limits, the soil is two-layer, conductors or rods are unevenly spaced, local danger points must be found, or buried metal is not connected to the grid. An earth grid handles all of these:</p>
<ul>
<li>diagonal (non-orthogonal) conductors, e.g. across corner meshes;</li>
<li>uneven spacing, e.g. conductors closer together towards the perimeter;</li>
<li>L-shaped outlines;</li>
<li>rods at any position, of any length;</li>
<li>fences, bonded to the grid or separately earthed;</li>
<li>two-layer soil;</li>
<li>the worst touch and step voltage located anywhere, not only at the corner mesh.</li></ul>
<h4>2 · Which method, which limits</h4>
<table class="help-ref-table"><thead><tr><th>Grid</th><th>IEEE 80 limits (default)</th><th>EN 50522 limits</th></tr></thead><tbody>
<tr><td>Plain rectangle: equal spacing, uniform soil, rods by rule or none, no diagonals, added metal, fences or drawn touch area</td><td><b>IEEE 80 simplified</b> equations are the headline (checkable by hand); the numerical result is shown beside them</td><td>Numerical</td></tr>
<tr><td>Anything else</td><td><b>Numerical</b> (method of moments); the reason the equations don't apply is stated</td><td>Numerical</td></tr></tbody></table>
<p>The <em>Method</em> setting can force <em>numerical</em> on a plain rectangle. <em>IEEE 80</em> on a grid the equations don't cover falls back to numerical with a note. EN 50522 has no simplified touch-voltage equations, so it always uses the numerical result (see <a href="#" data-help="prot-en50522">Touch voltage to EN 50522</a>).</p>
<p><b>Compare like with like.</b> The simplified equations are conservative on a plain rectangle: on a 30 × 30 m, 6 × 6 grid with 20 rods, Sverak gives $R_g$ = 1.68 Ω against 1.46 Ω numerically, and $E_m$ is 8 % above the numerical worst touch. So judge a design change — adding diagonals, say — numerical against numerical. The results window shows the numerical value for every grid for this reason.</p>
<h4>3 · Physical model</h4>
<p><b>The field.</b> At 50/60 Hz the current field in soil is quasi-static: the skin depth $\delta=503\sqrt{\rho/f}$ is about 710 m at 100 Ω·m and 50 Hz, far larger than a substation. The soil potential obeys the steady conduction equation $\nabla\cdot(\sigma\nabla V)=0$ with an insulating ground surface ($\partial V/\partial z=0$ at $z=0$), $V$ and $\sigma\,\partial V/\partial z$ continuous at a layer interface, and $V\to\rho I/(2\pi r)\to0$ at remote earth.</p>
<p><b>The metal.</b> Grid conductors, rods, fence posts and buried fence wires are thin straight wires with a radius. Metal bonded together is at one potential:</p>
<ul>
<li><b>the grid</b> — everything bonded to it, including bonded fences. Its potential is the GPR;</li>
<li><b>unbonded groups</b> — each separately earthed fence, or conductor marked not bonded. Its potential floats: it takes no net current from the fault, and the solve returns its potential.</li></ul>
<p>"Every bonded conductor at the same potential" is IEEE 80's assumption. Once it holds, topology does not enter the equations: a diagonal is just more metal at the GPR. It is checked for every grid (section 7), because a long, thin conductor in low-resistivity soil is not at one potential along its length. EN 50522 Figures J.4/J.5 show this for a single 95 mm² Cu wire at 0.6 m: its earth impedance stops falling beyond an effective length of about 0.7 km at 50 Ω·m, 1.0 km at 100 Ω·m and 3.2 km at 1000 Ω·m.</p>
<p><b>Soil.</b> Uniform $\rho_1$, or two horizontal layers: $\rho_1$ from the surface to depth $H$ over $\rho_2$ below, with reflection factor $K=(\rho_2-\rho_1)/(\rho_2+\rho_1)$. The potential per ampere of a point source at depth $z_0$, seen at depth $z$ and horizontal distance $r$, is the classical image series (Sunde; Dawalibi &amp; Mukhedkar), with $R(\zeta)=\sqrt{r^2+\zeta^2}$:</p>
$$\text{field 1, source 1:}\quad \frac{\rho_1}{4\pi}\sum_{n=-\infty}^{\infty}K^{|n|}\left[\frac1{R(z-z_0+2nH)}+\frac1{R(z+z_0+2nH)}\right]$$
$$\text{field 2, source 1:}\quad \frac{\rho_1(1+K)}{4\pi}\sum_{n\ge0}K^{n}\left[\frac1{R(z-z_0+2nH)}+\frac1{R(z+z_0+2nH)}\right]$$
$$\text{field 1, source 2:}\quad \frac{\rho_1(1+K)}{4\pi}\sum_{n\ge0}K^{n}\left[\frac1{R(z_0-z+2nH)}+\frac1{R(z+z_0+2nH)}\right]$$
$$\text{field 2, source 2:}\quad \frac{\rho_2}{4\pi}\left[\frac1{R(z-z_0)}-\frac{K}{R(z+z_0-2H)}+(1-K^2)\sum_{n\ge0}\frac{K^{n}}{R(z+z_0+2nH)}\right]$$
<p>These satisfy all three boundary conditions; checked numerically, $V$ and $(1/\rho)\,\partial V/\partial z$ are continuous at the interface and $\partial V/\partial z=0$ at the surface to a residual of $7\times10^{-5}$. Uniform soil is $K=0$: the source plus its surface image. Terms weighing less than $10^{-6}$ are dropped, and images farther than five grid diagonals are lumped as a constant.</p>
<p><b>Surface layer (crushed rock).</b> It is not part of the field model: it is thin, highly resistive and carries almost none of the grid current. It enters only the body circuit — IEEE 80 $C_s$ (§7.4), or EN 50522 $R_{F2}=1.5\,\rho_S$ — as both standards treat it.</p>
<h4>4 · Numerical method</h4>
<p><b>Geometry to wires.</b> The layout generator builds the conductors, diagonals and rods of a rectangle or L. Conductors and rods added by hand are appended, and each fence is built from its offset of the outline: posts along the fence line, plus a buried fence conductor if one is set. Before discretising, every horizontal wire is split where it meets or crosses another at the same depth, and where a rod top or another wire's end lands on it; collinear duplicates are merged, keeping the larger radius. This matters numerically: when two conductors cross inside elements whose mid-points both sit at the crossing, two rows of the system become nearly identical — on the Annex H Grid 6 diagonals that gave negative leakage currents and a surface potential above GPR. With every crossing a node it cannot happen.</p>
<p><b>Elements.</b> Each wire is cut into $\lceil L/\ell\rceil$ equal elements ($\ell$ = element length, default 1 m). The first and last element of each wire are halved again, because leakage density changes fastest at conductor ends and junctions. A wire crossing the layer interface is split there, so no element straddles two layers. Each element carries a uniform leakage current.</p>
<p><b>Thin-wire kernel.</b> The potential at point $P$ from element $j$ carrying current $I_j$ uniformly along its length $L_j$ — source current on the element's axis, field point on the other element's axis, the radius $a_j$ keeping the self-term finite — is</p>
$$V(P)=\frac{I_j}{L_j}\int_{A_j}^{B_j}\frac{ds}{\sqrt{|P-s|^2+a_j^2}}=\frac{I_j}{L_j}\Big[\operatorname{asinh}\tfrac{t_2}{\rho_\perp}-\operatorname{asinh}\tfrac{t_1}{\rho_\perp}\Big]$$
<p>where $t_1$, $t_2$ are the element ends measured from the foot of the perpendicular from $P$, and $\rho_\perp^2$ = (perpendicular distance)² + $a_j^2$. Each soil image applies the same integral to the mirrored element. Setting every element mid-point to its group potential gives $[G]\,I=V$, $G_{ij}$ = potential at mid-point $i$ per ampere in element $j$.</p>
<p><b>Floating groups.</b> With unbonded groups the unknowns are the element currents plus one potential $V_k$ per floating group, and each floating group takes no net current:</p>
$$\begin{bmatrix}G & -E\\ E^{T} & 0\end{bmatrix}\begin{bmatrix}I\\ V\end{bmatrix}=\begin{bmatrix}b\\ 0\end{bmatrix},\qquad b_i=\begin{cases}1 & \text{grid element}\\ 0 & \text{otherwise}\end{cases},\quad E_{ik}=1\ \text{if element } i \text{ is in group } k$$
<p><b>Resistance and scaling.</b> The solve is per volt of GPR:</p>
$$R_g=\frac{1}{\sum I_{\text{grid}}},\qquad V_s(x,y)=\sum_j I_j\,G_j(x,y,0)$$
<p>Every voltage scales linearly with the grid current, so one solve serves every bus on the grid; each bus multiplies the per-unit results by its own GPR $=I_G\,R_g$.</p>
<p><b>Evaluating the kernel quickly.</b> For each pair of depths, the sum over all soil images of the point-source term $c/\sqrt{r^2+\Delta z^2}$ depends only on the horizontal distance $r$. It is tabulated once (2.5 mm nodes to 2 m, 25 mm to 20 m, then geometric), so each point–element pair costs one interpolation however long the two-layer series is; in uniform soil the point kernel is evaluated directly. Within 4 element lengths of an element image the exact line integral above replaces the point value; beyond that a point source is within about 0.5 % (worst case along a rod's axis). Against a reference that evaluates every near image exactly, a 100 × 100 m grid over resistive rock (100/1000 Ω·m, $H$ = 3 m) agrees to 0.004 % on $R_g$ and 0.02 % on touch voltage. That matters: over a large grid on rock the surface sits at about 97 % of GPR, so touch $(1-V)$ magnifies an error in $V$ about thirtyfold.</p>
<p><b>Speed.</b> A 200 × 200 m, 21 × 21 grid (3460 elements) solves in about 2 s; the whole study takes about 14 s in uniform soil and 35 s in two-layer soil.</p>
<p><b>Foot radius.</b> A surface point is never taken closer than 0.08 m — the IEEE 80 §7.3 foot radius — to the axis of an electrode that reaches the surface, such as a fence post. Without it, a raster point exactly on a post axis would report the post's own potential as a step (123 V on Annex H Grid 5, against the programs' 83–91 V). Buried conductors are unaffected.</p>
<p><b>Element length.</b> Convergence on Annex H Grid 3 (two-layer, 20 rods crossing the interface):</p>
<table class="help-ref-table"><thead><tr><th>Max element</th><th>Elements</th><th>$R_g$ (Ω)</th><th>T1 (V)</th><th>S1 (V)</th><th>Solve</th></tr></thead><tbody>
<tr><td>4.0 m</td><td>460</td><td>0.9687</td><td>262.8</td><td>106.3</td><td>0.1 s</td></tr>
<tr><td>2.0 m</td><td>660</td><td>0.9692</td><td>262.9</td><td>104.1</td><td>0.2 s</td></tr>
<tr><td><b>1.0 m</b> (default)</td><td>1200</td><td>0.9668</td><td>261.5</td><td>102.0</td><td>0.5 s</td></tr>
<tr><td>0.5 m</td><td>2200</td><td>0.9663</td><td>261.3</td><td>101.2</td><td>0.9 s</td></tr></tbody></table>
<p>Going from 1 m to 0.5 m changes $R_g$ by 0.05 %, touch by 0.1 % and step by 1 %. The limit is 4000 elements: a grid that would need more has its element length raised automatically, and a note gives the longest element used. A finer length can be set per grid (Calculation ▸ Advanced).</p>
<h4>5 · Touch, step and transferred voltage</h4>
<p><b>Definitions</b> (IEEE 80 §3, §8.1):</p>
<ul>
<li><b>Touch voltage</b> — GPR minus the surface potential where a person stands with a hand on a grounded structure. <b>Mesh voltage</b> is the maximum touch voltage within a mesh.</li>
<li><b>Step voltage</b> — the surface-potential difference over 1 m with the feet, touching no grounded object.</li>
<li><b>Transferred voltage</b> — a touch voltage carried into or out of the site by a conductor earthed elsewhere.</li></ul>
<p>The simplified equations evaluate $E_m$ at the centre of the corner mesh and $E_s$ from the outer corner to 1 m diagonally outside (Table 12). IEEE 80 §16.1 notes that even on an equally spaced square grid the true worst mesh voltage lies slightly off the corner-mesh centre, and that the corner mesh stops being the worst case on an unsymmetrical grid, with rods on or near the perimeter, or with very non-uniform spacing. Annex B Exhibit 2 shows why a search is needed: on its unequally spaced grid the worst touch voltage (17.08 % of GPR) is over the largest interior mesh, while the corner mesh gives only 9.29 %.</p>
<p><b>Where they are evaluated</b> — the IEEE 80 Annex H.3 conventions the commercial programs were benchmarked on:</p>
<table class="help-ref-table"><thead><tr><th>Quantity</th><th>Area</th><th>Reference potential</th></tr></thead><tbody>
<tr><td>Touch, grid</td><td>inside the grid outline (H.3.6 "inside perimeter conductor"); extended to 1 m outside a <b>bonded</b> fence (H.3.5)</td><td>GPR</td></tr>
<tr><td>Touch, unbonded fence</td><td>within 1 m of the fence line, either side</td><td>the fence's own potential</td></tr>
<tr><td>Step</td><td>from 1 m outside the grid perimeter inward (H.3.5/H.3.6 S1), and 1 m outside each fence line</td><td>—</td></tr>
<tr><td>Transfer, grid → unbonded fence</td><td>—</td><td>GPR − $V_{fence}$</td></tr></tbody></table>
<p>A <b>drawn touch area</b> (a polygon saved with the grid) covers the case in IEEE 80 §17.1: a fence enclosing more than the grid, with service areas people can reach. A drawn area is where people stand, so the step check covers the same area (not the outline + 1 m). With no generated layout it also replaces the convex hull of the conductors as the outline drawn and the grid area reported.</p>
<p><b>Search.</b></p>
<ul>
<li><b>Touch</b> — surface potential on a 0.5 m raster over the touch area (the Annex H spacing; coarsened only when more than about 60 000 points would be needed). The twelve lowest points are refined on a 0.1 m sub-raster. The worst touch voltage and its location are reported.</li>
<li><b>Step</b> — axis-aligned 1 m differences read off the raster screen the 400 steepest points, plus the raster edge. At each candidate the exact 1 m step is computed in 16 directions, and the eight strongest are searched again on a 0.1 m sub-raster inside the step area, because the peak at a rod or conductor corner falls between raster points. The worst step and its direction are found anywhere, not only on the corner diagonal.</li></ul>
<p><b>Fences.</b></p>
<ul>
<li><b>Bonded fence</b> (IEEE 80 §17.3) — posts, and optionally a buried fence conductor, are part of the grid. The touch area extends to 1 m outside the fence, because people touch the fence from outside.</li>
<li><b>Unbonded (separately earthed) fence</b> — its own floating group. Reported: its potential, the worst touch voltage within 1 m reach referred to the fence, and the grid-to-fence transfer voltage, which nothing may bridge.</li>
<li>Annex H takes its fence touch point T4 at the corner of the fence's perimeter conductor, 1 m outside the fence line and so 1.41 m from the fence corner. That point is beyond 1 m reach, so it is not used here; checked on its own it gives 49.0 V against the programs' 49.9–51.1 V.</li></ul>
<h4>6 · Limits, grid current and conductor size</h4>
<p><b>Tolerable voltages</b> (IEEE 80 §8.4, Eq. 29/30 step and 32/33 touch, 50 or 70 kg body):</p>
$$E_{touch}=\frac{(1000+1.5\,C_s\rho_s+R_{shoe}/2)\,k}{\sqrt{t_s}},\qquad E_{step}=\frac{(1000+6\,C_s\rho_s+2R_{shoe})\,k}{\sqrt{t_s}},\qquad k=0.116\ (50\text{ kg}),\ 0.157\ (70\text{ kg})$$
<p>$C_s$ is Eq. 27; with no surface layer $\rho_s=\rho_1$ and $C_s=1$. $R_{shoe}$ is the optional footwear resistance per foot (Calculation ▸ Footwear resistance): each shoe is in series with its foot, so the feet in parallel add $R_{shoe}/2$ for touch and in series $2R_{shoe}$ for step — the form CDEGS SESThreshold uses. 0 (the default) is IEEE 80 as written.</p>
<p><b>Grid current</b> (§15, Eqs. 3–4): $I_G=D_f\,S_f\,I_f$.</p>
<ul>
<li>$I_f$ is the fault study's $I''_{k1}$ at the bus, reduced to the share fed from remote sources; the share returning through a transformer or generator neutral at the bus stays in the metal (§15.1).</li>
<li>$S_f$ is the bus's split factor (§15.9, Annex C); $D_f$ the decrement factor for the bus's X/R and $t_s$ (§15.10).</li>
<li><b>Worst fault location</b> (§15.8): each bus on the grid is evaluated with its own current and the worst is the design case. A fault on the supply side of a local transformer often is; that is why the LV bus of a Dyn transformer shows a GPR near zero.</li></ul>
<p>EN 50522 replaces the current (no decrement factor), the limits and the pass logic: see <a href="#" data-help="prot-en50522">Touch voltage to EN 50522</a>.</p>
<p><b>Conductor size.</b> The grid conductor is entered as a cross-section in mm² (16–300 mm² offered), as it is bought. The geometry uses the solid-equivalent diameter $d=\sqrt{4A/\pi}$. A stranded conductor of the same area is about 10–15 % larger outside, so the solid value is slightly conservative (a thinner conductor gives a marginally higher resistance and touch voltage). A measured outside diameter can be entered under Advanced, for the geometry only. Rod and post diameters are in mm. A project saved with a diameter converts on opening to its solid-equivalent size (to 0.01 mm²), which returns the same diameter.</p>
<p>The minimum size is IEEE 80's Onderdonk equation (§11.3) on the full $D_f\,I''_{k1}$ over $t_c$ — the grid conductor carries the whole fault current back to a local neutral, not only $I_G$. $T_m$ is the lower of the material's fusing point and the joint limit (§11.3.1.1). A conductor smaller than the minimum fails the study, and the issue names the next standard size.</p>
<h4>7 · Built-in checks</h4>
<ul>
<li><b>Connectivity</b> — a union-find over the element end points confirms that every bonded non-fence conductor forms one metallic network. A piece that touches nothing would otherwise be silently treated as bonded; if the network splits, the note gives the number of pieces. Fences are excluded, because their fabric joins the posts.</li>
<li><b>Equal potential</b> — the leakage currents from the solve are made to flow along the conductors, each with a series impedance with earth return (Carson, simplified):
$$z=R_{ac}+\frac{\omega\mu_0}{8}+j\,\frac{\omega\mu_0}{2\pi}\ln\frac{D_e}{a},\qquad D_e=658.87\sqrt{\rho_1/f}$$
The fault current is injected in turn at the four extreme nodes, and the largest drop from the injection node is reported as a percentage of GPR. Above 5 % the equal-potential assumption is questionable and a note says so. It is a first-order check: it takes the equipotential leakage distribution and ignores mutual coupling between conductors, which raises the effective inductance, so a large drop should be taken seriously. The Annex H grids give 0.8–1.5 %.</li>
<li><b>IEEE 80 applicability</b> — the reason the simplified equations don't apply is stated (e.g. "the grid has diagonal conductors"). For a plain rectangle the §16.7 tested range and the §16.5.2 depth range for $K_s$ are checked.</li></ul>
<h4>8 · Validation</h4>
<p><b>Closed forms and invariances</b></p>
<table class="help-ref-table"><thead><tr><th>Case</th><th>This program</th><th>Reference</th><th>Deviation</th></tr></thead><tbody>
<tr><td>Rod 3 m, $a$ = 8 mm, 100 Ω·m (Dwight)</td><td>33.53 Ω</td><td>33.49 Ω</td><td>+0.1 %</td></tr>
<tr><td>Buried wire 20 m, $a$ = 5 mm, $h$ = 0.5 m (Sunde)</td><td>8.486 Ω</td><td>8.496 Ω</td><td>−0.1 %</td></tr>
<tr><td>Grid 6 rotated 30° and shifted</td><td>$R$ to $3\times10^{-6}$, potentials to $10^{-5}$</td><td>identical</td><td>—</td></tr>
<tr><td>Annex B Exhibit 1 grid without rods, independent solver</td><td>1.411 Ω</td><td>1.410 Ω</td><td>+0.03 %</td></tr></tbody></table>
<p><b>IEEE 80 Annex H</b> — "in range" means inside the spread of CDEGS, ETAP and WinIGS; otherwise the deviation is to the nearer end.</p>
<table class="help-ref-table"><thead><tr><th>Case</th><th>Quantity</th><th>This program</th><th>Programs</th><th></th></tr></thead><tbody>
<tr><td>Grid 1 (uniform 140 Ω·m, no rods)</td><td>$R_g$</td><td>1.000 Ω</td><td>1.0–1.01</td><td>in range</td></tr>
<tr><td></td><td>T1 corner-mesh centre</td><td>195.4 V</td><td>194.9–200.9</td><td>in range</td></tr>
<tr><td></td><td>T3 worst touch</td><td>203.1 V</td><td>202.7–209.0</td><td>in range</td></tr>
<tr><td></td><td>S1</td><td>91.1 V</td><td>87.2–89.3</td><td>+2.0 %</td></tr>
<tr><td>Grid 2 (+20 rods)</td><td>$R_g$</td><td>0.917 Ω</td><td>0.917–0.92</td><td>in range</td></tr>
<tr><td></td><td>T1 / T3</td><td>145.5 / 149.7 V</td><td>145.4–150.2 / 149.6–154.0</td><td>in range</td></tr>
<tr><td></td><td>S1</td><td>70.7 V</td><td>70.7–79.3</td><td>in range</td></tr>
<tr><td>Grid 3 (two-layer 300/100 Ω·m, $H$ 6.1 m)</td><td>$R_g$</td><td>0.967 Ω</td><td>0.97–0.972</td><td>−0.3 %</td></tr>
<tr><td></td><td>T1 / T3</td><td>261.5 / 262.9 V</td><td>261.0–268.5 / 262.5–269.7</td><td>in range</td></tr>
<tr><td></td><td>S1</td><td>102.0 V</td><td>101.9–117.0</td><td>in range</td></tr>
<tr><td>Grid 4 (+ separately earthed fence)</td><td>$R_g$</td><td>0.965 Ω</td><td>0.96–0.97</td><td>in range</td></tr>
<tr><td></td><td>grid → fence transfer</td><td>310.2 V</td><td>309.2–312.4</td><td>in range</td></tr>
<tr><td></td><td>T1 / T2 / T3</td><td>260.5 / 129.5 / 261.7 V</td><td>within each range</td><td>in range</td></tr>
<tr><td></td><td>T4 (fence-conductor corner)</td><td>49.0 V</td><td>49.9–51.1</td><td>−1.9 %</td></tr>
<tr><td></td><td>S1 / S2</td><td>95.5 / 39.8 V</td><td>97.0–97.4 / 37.4–38.1</td><td>−1.5 % / +4.3 %</td></tr>
<tr><td></td><td>$R$ of the fence alone ¹</td><td>1.69 Ω</td><td>1.6–1.62</td><td>+4.1 %</td></tr>
<tr><td>Grid 5 (L-shape, bonded fence, two-layer)</td><td>$R_g$ / GPR</td><td>0.807 Ω / 601 V</td><td>0.81 / 602.7–606.4</td><td>−0.3 % / −0.2 %</td></tr>
<tr><td></td><td>worst touch ²</td><td>128.5 V</td><td>131.6–138.1</td><td>−2.3 %</td></tr>
<tr><td></td><td>worst step</td><td>90.8 V</td><td>83.0–90.7</td><td>+0.1 %</td></tr>
<tr><td><b>Grid 6</b> (diagonals, rods 7.5/2.5 m, two-layer)</td><td>$R_g$ / GPR</td><td>1.426 Ω / 1062 V</td><td>1.42–1.43 / 1054–1068</td><td>in range</td></tr>
<tr><td></td><td>worst touch</td><td>136.3 V</td><td>134.4–140.2</td><td>in range</td></tr>
<tr><td></td><td>worst step</td><td>85.6 V</td><td>77.4–99.2</td><td>in range</td></tr></tbody></table>
<p>¹ The fence-conductor depth is not given; 0.5 m is assumed. ² "Every other perimeter crossing" gives 25 rods on this outline; the three programs themselves spread 5 % here.</p>
<p><b>IEEE 80 Annex B</b> (EPRI TR-100622, an older program)</p>
<table class="help-ref-table"><thead><tr><th>Case</th><th>Quantity</th><th>This program</th><th>EPRI</th><th>Deviation</th></tr></thead><tbody>
<tr><td>Ex. 1 (70 × 70 m, 11 × 11, 400 Ω·m)</td><td>$R_g$</td><td>2.645 Ω</td><td>2.67</td><td>−0.9 %</td></tr>
<tr><td></td><td>worst touch</td><td>965.0 V</td><td>984.3</td><td>−2.0 %</td></tr>
<tr><td>Ex. 2 (+20 rods) ³</td><td>$R_g$</td><td>2.489 Ω</td><td>2.52</td><td>−1.2 %</td></tr>
<tr><td></td><td>worst touch</td><td>709.9 V</td><td>756.2</td><td>−6.1 %</td></tr>
<tr><td></td><td>step</td><td>460.5 V</td><td>459.1</td><td>+0.3 %</td></tr>
<tr><td>Ex. 4 (L-shape)</td><td>$R_g$ / touch / step</td><td>2.313 Ω / 713.8 V / 471.5 V</td><td>2.34 / 742.9 / 441.8</td><td>−1.1 / −3.9 / +6.7 %</td></tr>
<tr><td>Exhibit 1 (two-layer, 9 rods 9.1 m)</td><td>$R_g$</td><td>1.137 Ω</td><td>1.353</td><td>−15.9 % ⁴</td></tr>
<tr><td>Exhibit 2 (unequal spacing) ³</td><td>$R_g$</td><td>1.462 Ω</td><td>1.416</td><td>+3.3 %</td></tr>
<tr><td></td><td>corner-mesh / worst touch (% GPR)</td><td>8.6 / 15.4</td><td>9.29 / 17.08</td><td>−7 / −10 %</td></tr></tbody></table>
<p>³ Rod positions are read off the figures; for Ex. 2 "every other perimeter crossing" is assumed. ⁴ Without the rods the result equals an independent solver (first table), so the difference comes from the rods reaching into the more conductive lower layer. Rods crossing the interface are validated by Annex H Grids 3 and 4, where three modern programs agree with this solver to 0.5 %. The Exhibit 1 difference is recorded as unexplained and is not tuned away.</p>
<p><b>Reading the evidence.</b> Against the three current programs of Annex H the solver is inside their spread, or within 2.5 % of it, for resistance and touch voltage on every grid — including the diagonal Grid 6 and the separately earthed fence of Grid 4. Step voltages sit within 5 %, the same order as the programs' own spread (WinIGS is 20 % below the others on Grid 6). The EPRI program of Annex B gives 1 % more resistance and 2 % more touch voltage on the one fully specified case (Ex. 1); where rod positions are read from figures the touch-voltage gap grows to 4–10 %. No case is solved by both EPRI and the modern programs, so which is closer cannot be settled from the standard; the Annex H agreement — three independent programs, fully specified geometry — is the stronger evidence. Treat a touch voltage within a few percent of its limit as marginal.</p>
<h4>9 · Limitations</h4>
<ul>
<li><b>Equal potential of bonded metal</b> is checked (section 7) but not relaxed. Large sites with thin or steel conductors in low-resistivity soil — PV farms are the typical case — need a solver with conductor impedance.</li>
<li><b>Soil</b>: horizontal layers only — one or two, no lateral variation (IEEE 80 §16.2.3 notes real soil varies laterally too). The surface layer is in the body circuit only.</li>
<li><b>Frequency</b>: power frequency only — no lightning or switching transients (IEEE 80 §17.7, EN 50522 Annex F).</li>
<li><b>Not computed</b>: metal-to-metal touch (IEEE 80 §8.2) and transferred voltages beyond the unbonded fences modelled — pipes, cable sheaths, rails (IEEE 80 §17.9, EN 50522 §6).</li>
<li><b>Ground surface</b>: flat ground only. The touch area is the grid outline (or fence + 1 m) unless drawn.</li>
<li><b>EN 50522</b>: C1 (global earthing system) is not assessed; isolated or resonant-earthed currents are user inputs; Table 2 (LV transferred potential) and Annex D conductor sizing are not implemented.</li>
<li><b>Fault location</b>: one per bus; the worst over the buses on the grid is the design case.</li></ul>
<h4>10 · Modelling guide</h4>
<ul>
<li><b>Start from the bus.</b> <em>Create from bus</em> turns the bus's IEEE 80 data into an earth grid that gives exactly the same result. Then edit it.</li>
<li><b>One grid per site.</b> Point the HV and LV buses of a substation at the same grid. The HV bus usually sets the design current; the LV bus of a Dyn transformer has little remote current.</li>
<li><b>Corner meshes first.</b> On an evenly spaced grid the corner mesh carries the highest touch voltage (Annex H Grid 1, T3 on the corner diagonal). Remedies, in the order of IEEE 80 §16.6: diagonals across the corner meshes (<em>Diagonals: corner meshes</em>); closer spacing at the perimeter (uneven spacing positions); rods at the perimeter, especially the corners; a perimeter conductor 1 m outside the fence; more surface-layer resistivity or thickness; faster clearing. Compare each change numerically against numerical.</li>
<li><b>Uneven spacing.</b> Enter the conductor positions, e.g. 0, 3, 12, 24, 45.7, 67, 79, 88.4, 91.4. The worst touch voltage can then be in an interior mesh (Exhibit 2): read its location on the plan, not only the value.</li>
<li><b>Fences.</b> A <b>bonded</b> fence extends the touch area to 1 m outside it: lay a perimeter conductor about 1 m outside the fence (<em>Conductor offset</em>) so the potential outside does not drop steeply (IEEE 80 §17.3). A <b>separately earthed</b> fence (not bonded, typically 2–3 m outside the grid with its own conductor) lowers the touch voltage on the fence but creates a grid-to-fence transfer voltage: nothing may bridge the two. Typical posts: spacing about 3 m, depth about 0.8 m, diameter about 50 mm.</li>
<li><b>Rods.</b> <em>Perimeter, evenly spaced</em> reproduces the per-bus placement (corners first). <em>Every perimeter crossing</em> or <em>every other crossing</em> put rods at conductor joints, as IEEE 80's examples do. Rods into a lower, more conductive layer are very effective (Exhibit 1); rods ending in a resistive lower layer much less so.</li>
<li><b>Placing by hand.</b> In the editor's plan, <em>+ Conductor</em> and <em>+ Rod</em> place added metal by clicking; points snap to conductor ends, crossings, rods and conductors (Alt places freely). The <em>3-D</em> view shows burial depths, rods and fences.</li>
<li><b>Soil.</b> Fit $\rho_1/\rho_2/H$ from field readings with the Wenner interpreter. With a resistive lower layer ($K&gt;0$) surface gradients and touch voltage rise sharply; the uniform-soil equations can underestimate touch voltage there by up to 2.4×.</li>
<li><b>Design current.</b> Check the split factor $S_f$ (IEEE 80 §15.9, Annex C; EN 50522 Annex I reduction factor $r$) and the fault duration. For isolated or resonant systems enter the bus's design earth-fault current.</li>
<li><b>Element length.</b> 1 m is adequate; use 0.5 m to confirm a marginal result.</li>
<li><b>Reading the results.</b> The plan shows touch or step voltage as a heat map over its area — green to red up to the limit, red to purple (hatched) above it, with the limit drawn as a contour; <em>Colours vs highest</em> stretches the scale when everything is within the limit. ✕ marks the worst touch point and the short segment the worst 1 m step. Hover (or tap) the plan for the touch and step voltage and surface potential at a point; the highest value in the legend is the calculated worst point, which is refined more finely than the map. Fence posts are squares, rods dots, and unbonded metal is dashed.</li></ul>
<h4>11 · Saved data</h4>
<p>Each grid is saved with the project (also what the API and Python client send):</p>
<table class="help-ref-table"><thead><tr><th>Field</th><th>Meaning</th></tr></thead><tbody>
<tr><td>id, name</td><td>identity; buses refer to <code>id</code> through <code>earth_grid_id</code></td></tr>
<tr><td>soil</td><td>rho1, two_layer (on/off), rho2, h1</td></tr>
<tr><td>surface</td><td>rho_s, h_s (h_s = 0: no surface layer)</td></tr>
<tr><td>conductor</td><td>material, area_mm2, optional diameter_m (measured outside diameter, geometry only), depth_m, joint</td></tr>
<tr><td>layout</td><td>type rect / l / none; length_x, width_y; n_x, n_y or x_lines, y_lines (explicit positions); notch_x, notch_y (L); diagonals none / corner_meshes / all_meshes / full</td></tr>
<tr><td>rods</td><td>rule none / perimeter_even (with count) / perimeter_nodes / perimeter_alternate / corners / all_nodes; length_m, diameter_m</td></tr>
<tr><td>fences[]</td><td>name, offset_m (+ out / − in), bonded, post_spacing_m, post_depth_m, post_diameter_m, conductor_offset_m (none = no fence conductor), conductor_depth_m</td></tr>
<tr><td>extra_conductors[]</td><td>x1, y1, x2, y2, optional depth_m, area_mm2 (or diameter_m), bonded</td></tr>
<tr><td>extra_rods[]</td><td>x, y, optional length_m, diameter_m, bonded</td></tr>
<tr><td>touch_area</td><td>optional polygon [[x, y], …]</td></tr>
<tr><td>method</td><td>auto / ieee80 / numerical</td></tr>
<tr><td>limits</td><td>ieee80 / en50522</td></tr>
<tr><td>body_weight</td><td>50 / 70 (IEEE 80)</td></tr>
<tr><td>ieee80</td><td>footwear_ohm — per foot, in the IEEE 80 limits</td></tr>
<tr><td>en50522</td><td>footwear_ohm, hand_ohm, measures_m (yes/no)</td></tr>
<tr><td>element_length_m</td><td>numerical element length, 0.2–5 m</td></tr></tbody></table>
<p>Per bus: <code>earth_grid_id</code>, plus Fault Duration ($t_s$ / $t_f$), Fault Clearing Time ($t_c$), split factor ($S_f$ or $r$), ambient temperature and the optional design earth-fault current. The grounding study can be limited to selected buses; the fault study still covers the whole network.</p>` },

{ id: 'prot-en50522', group: 'protect', title: 'Touch voltage to EN 50522',
  std: 'EN 50522:2022 §5.4, Annex A/B, Table 1 · earth grid ▸ Limits',
  kw: 'en 50522 iec 61936 permissible touch voltage utp uvtp c1 c2 c3 c4 earth potential rise ue body current footwear reduction factor figure 8 specified measures m',
  html: String.raw`
<p>An earth grid can be checked against EN 50522 instead of IEEE 80 (earth grid ▸ Calculation ▸ Limits). The grid is solved the same way; only the current, the limits and the pass logic change.</p>
<h4>1 · Current to earth and earth potential rise (Table 1)</h4>
<p>For low-impedance neutral earthing $I_E=r\cdot I''_{k1}$, or $r\cdot(I''_{k1}-I_N)$ with a neutral earthed in the substation; $r$ is the bus's reduction (split) factor, and the fault study's remote share removes $I_N$. There is no decrement factor. Isolated or resonant-earthed systems use $I_C$ or $I_{RES}$: enter them as the bus's <em>Design Earth-Fault Current</em>. Then $U_E=I_E\,R_g$.</p>
<h4>2 · Permissible touch voltage</h4>
<p>$U_{Tp}(t_f)$ is Table B.4 (Figure 8), interpolated in log $t$: 725 V at 0.05 s, 655 V at 0.1 s, 525 V at 0.2 s, 225 V at 0.5 s, 115 V at 1 s, 95 V at 2 s, 85 V at 5–10 s, 80 V beyond. It is for bare hand-to-feet contact. With footwear and the ground under the feet (Formula A.3, $HF=1$):</p>
$$U_{vTp}=U_{Tp}+\frac{I_B(t_f)}{HF}\,(R_H+R_F),\qquad R_F=R_{F1}+1.5\ \text{m}^{-1}\cdot\rho_S$$
<p>$I_B$ is Table B.1 (e.g. 200 mA at 0.5 s); $R_{F1}$ the footwear (0 by default, 1000 Ω for old wet shoes per the standard's note); $\rho_S$ the surface-layer resistivity. $1.5\,\rho_S$ is the same two-feet model as IEEE 80 Eq. 15.</p>
<h4>3 · Procedure (Figure 9)</h4>
<table class="help-ref-table"><thead><tr><th>Condition</th><th>Test</th></tr></thead><tbody>
<tr><td>C2</td><td>$U_E\le2\,U_{Tp}$ — touch criterion met, $U_T$ need not be calculated</td></tr>
<tr><td>C3</td><td>$U_E\le4\,U_{Tp}$ with the specified measures M of Annex E applied (a yes/no on the grid)</td></tr>
<tr><td>C4</td><td>otherwise the calculated prospective touch voltage (the numerical worst touch) must not exceed $U_{vTp}$</td></tr></tbody></table>
<p>C1 (part of a global earthing system) is an engineering judgement and is not assessed.</p>
<h4>4 · Step voltage</h4>
<p>Needed only when $U_E>20\,U_{Tp}$ (A.3). The permissible value uses $HF=0.04$ (foot to foot), $BF=1$ and the body impedance of Table B.3 at that current, with no footwear credited: $U_{Sp}=\frac{I_B}{0.04}\,Z_T$, e.g. $5\ \text{A}\times775\ \Omega=3875$ V at 0.5 s.</p>
<h4>5 · Not covered here</h4>
<p>Transferred potentials (§6 and Table 2 for LV systems) are checked separately. Conductor size is by IEEE 80's Onderdonk equation; EN 50522 Annex D is not implemented.</p>` },

{ id: 'prot-lightning', group: 'protect', title: 'Lightning risk (IEC 62305-2)',
  std: 'IEC 62305-2:2024 and 2010 · Analyse ▸ Earthing & lightning',
  kw: 'lightning risk r1 r f frequency of damage lps spd entrance bonding peb collection area ng nsg strike point density flash density loss class structure service line tolerable 2024 2010 sans',
  html: String.raw`
<p>Assesses a rectangular structure with its service lines and recommends the lightest protection — lightning protection system (LPS), entrance SPDs and coordinated SPDs — that brings the risk within the tolerable value $R_T$ (typically $10^{-5}$ per year; an input, since the authority having jurisdiction sets it). Each assessment picks its <b>edition</b>: <b>2024</b> (Ed. 3, the current standard, default for a new assessment) or <b>2010</b> (Ed. 2, still the adopted text in some countries, e.g. SANS 62305-2). An assessment saved before editions were offered stays 2010, so its numbers reproduce. The 2024 method usually gives a higher risk: on the standard's own house example the 2010 method says no protection is needed; 2024 requires entrance SPDs.</p>
<h4>1 · Dangerous events</h4>
<p>Collection area of the structure (length $L$, width $W$, height $H$) and of a line section of length $L_L$:</p>
$$A_D=LW+2(3H)(L+W)+\pi(3H)^2,\qquad A_L=40\,L_L$$
$$N_D=N\,A_DC_D\,10^{-6},\qquad N_L=N\,A_LC_IC_EC_T\,10^{-6}$$
<p>$N$ is the ground flash density $N_G$ (2010) or the <b>strike-point density</b> $N_{SG}=k\,N_G$ with $k=2$ unless the lightning-location data provider gives another value (2024, A.1). Strikes <em>near</em> the structure and the line:</p>
<ul><li><b>2010:</b> $A_M=2\cdot500(L+W)+\pi\,500^2$, $A_I=4000\,L_L$, $N_M=N_GA_M10^{-6}$, $N_I=N_GA_IC_IC_EC_T10^{-6}$.</li>
<li><b>2024:</b> the distance is set by the equipment withstand $U_W$ (kV): $r_M=350/U_W$ (the weakest internal system), $r_I=2000/U_W^{1.8}$; $A_M=2r_M(L+W)+\pi r_M^2$, $A_I=2r_IL_L$, and $N_M$, $N_I$ are divided by $k$.</li></ul>
<p>$C_I$ = 1 aerial; buried 0.5 (2010) or 0.3 (2024). $C_T$ = 0.2 for an HV section with an HV/LV transformer.</p>
<h4>2 · The risk</h4>
<p><b>2024</b> (eq. 6–8) — one risk $R=R_{L1}+R_{L2}$ summing loss of human life and physical damage, compared with $R_T$ <em>in each zone</em>:</p>
$$R=R_{AT}+R_{AD}+R_B+R_C+R_M+R_U+R_V+R_W+R_Z$$
$$R_B=N_DP_B\,(P_PL_{F1}+L_{F2}),\quad P_B=P_SP_{LPS}r_fr_p,\quad P_P=t_z/8760$$
<p><b>2010</b> — the risk of loss of life only: $R_1=R_A+R_B+R_C^{*}+R_M^{*}+R_U+R_V+R_W^{*}+R_Z^{*}$ with the losses scaled by $\tfrac{n_z}{n_t}\tfrac{t_z}{8760}$.</p>
<p>The internal-system components ($R_C$, $R_M$, $R_W$, $R_Z$, marked *) count only where failure of internal systems endangers life — hospitals and structures with a risk of explosion (not hotels or schools). In 2024 a risk of explosion also adds their physical-damage part.</p>
<h4>3 · Frequency of damage (2024)</h4>
$$F=F_C+F_M+F_W+F_Z,\qquad F_C=N_DP_CP_e,\ F_M=N_MP_MP_e,\ F_W=N_LP_WP_e,\ F_Z=N_IP_ZP_e$$
<p>How often surges damage the internal systems, against the tolerable $F_T$ (typically 0.1 per year for critical systems, 1 for non-critical). $P_C$ and $P_M$ combine the internal systems: $P_C=1-\prod(1-P_{SPD,i}C_{LD,i})$, $P_M=1-\prod(1-P_{SPD,i}P_{MS,i})$ with $P_{MS}=(K_{S1}K_{S2}K_{S3})^2$.</p>
<h4>4 · Losses</h4>
<p><b>2024</b>: a loss class per zone (Table C.2) — low (private buildings) $L_F=0.02$; normal (open to the public) $0.05$; high (hospital wards, prisons, control rooms, museums) $0.1$, $L_O=10^{-3}$; very high (operating theatres, intensive care, explosion) $0.2$, $L_O=10^{-2}$ — the highest value of each range, as recommended. <b>2010</b>: per use, $L_F$ from $0.01$ (other) to $0.1$ (hospitals, hotels, schools, and any structure with a risk of explosion); $L_O=10^{-3}$ hospital, $10^{-2}$ intensive care, $10^{-1}$ explosion.</p>
<h4>5 · Protection and the recommendation</h4>
<p>$P_{LPS}$ ($P_B$ in 2010) is $1$, $0.2$, $0.1$, $0.05$, $0.02$ for no LPS and classes IV–I; entrance SPDs give $P_{EB}$ and a coordinated SPD system $P_{SPD}$ of $0.05$, $0.02$, $0.01$ for LPL III–IV, II, I (2024 also offers better than LPL I, $0.002$). A line screen bonded at the entrance lowers $P_{LD}$ by its resistance $R_S$ and $U_W$ (2010 Table B.8, 2024 Table B.11). The recommendation evaluates every combination and reports, for each LPS class, the lightest SPDs that meet $R_T$ (and, in 2024, $F_T$); an LPS always brings its equipotential-bonding SPDs.</p>
<div class="hc-warn">2024 rules applied from the notes: for strikes to the structure, touch protection, fire provisions and coordinated SPDs count only with an LPS or a reinforced-concrete / steel frame acting as a natural LPS (Table 2 note h); an installed LPS sets $P_S=1$; $r_p=1$ with a risk of explosion or lithium-ion storage. Not assessed: thunderstorm warning systems, adjacent structures, environmental loss (Annex E). The dialog assesses the inside as one zone plus an optional exposed zone (roof / outside); the engine handles any number of zones and reproduces the standard's Annex F house, office and hospital examples.</div>
<div class="hc-example"><span class="hc-label">Worked example (IEC 62305-2:2024, Annex F.2)</span>
<p>A 15 × 20 × 6 m isolated masonry house, $N_{SG}=8$, a 1 km aerial LV line and an 800 m aerial telecom line, occupied 4,380 h a year, low loss ($L_{F1}=L_{F2}=0.02$), low fire risk ($r_f=10^{-3}$). $A_D=300+2(18)(35)+\pi\,18^2=2578\ \text{m}^2$, $N_D=0.0206$, $N_L=0.32+0.256$. The fire risk from the lines dominates: $R_V=0.576\times10^{-3}\times(0.5\times0.02+0.02)=1.73\times10^{-5}$, so $R=1.79\times10^{-5}>R_T$. Entrance SPDs of LPL III–IV ($P_{EB}=0.05$) bring it to $0.15\times10^{-5}$.</p></div>` },

{ id: 'prot-compliance', group: 'protect', title: 'Compliance report',
  std: 'IEC 60909 · IEC 60364 · IEC 62271 · IEC 60947 · SANS 10142-1 · Analyse ▸ Protection & safety',
  kw: 'compliance sans 10142 pass fail warning earth fault disconnection rcd earthing tn tt it maximum demand voltage tolerance',
  html: String.raw`
<p>Cross-checks the analysis results against standards limits and produces a pass / warning / fail report. Each section says what to run first; a check whose input is missing reports <em>info</em> with how to supply it, never a silent pass.</p>
<h4>Sections</h4>
<table class="help-ref-table"><thead><tr><th>Section</th><th>Test</th></tr></thead><tbody>
<tr><td>Network validation</td><td>topology is valid: components connected, sources and buses present (the load flow picks each island's slack from its sources, so a bus labelled Swing is optional)</td></tr>
<tr><td>Fault duty (IEC 60909)</td><td>breaking / making capability against $I_b$ and $i_p$ — see <a href="#" data-help="prot-duty">Duty check</a></td></tr>
<tr><td>Voltage compliance (IEC 60038)</td><td>bus voltage within ±10 % of nominal (LV: SANS 10142-1 Cl. 5.3.2 / NRS 048-2)</td></tr>
<tr><td>Thermal loading</td><td>$|I|/I_{rated}$ for cables, $|S|/S_r$ for transformers</td></tr>
<tr><td>Cable short-circuit withstand (IEC 60364-4-43 §434.5.2)</td><td>adiabatic $t\le(kS/I_{th})^2$ with $I_{th}=I\sqrt{m+1}$, checked twice with the supply-side device's own curve: at the <em>largest</em> fault current of any type at either end, and at the <em>smallest</em> far-end current of the minimum study. A far-end fault the device does not clear within 5 s passes only if the device gives §433.1 overload protection of the cable (§435.1). $k$ per Table 43A (PVC above 300 mm²: 103 Cu / 68 Al). Relay-tripped breakers are evaluated by <a href="#" data-help="cable-sizing">Cable sizing</a></td></tr>
<tr><td>Protection device ratings</td><td>rated current against the load current on the device's side of any transformer; rated voltage — MV $U_r\ge U_m$ (IEC 62271-1: 12 kV on an 11 kV system), LV $U_e\ge U_n$</td></tr>
<tr><td>Motor circuit protection (IEC 60947-4-1)</td><td>protective device against motor full-load current, on dedicated single-motor feeders only (a shared feeder can legitimately be rated below the sum of its loads)</td></tr>
<tr><td>PV DC string design (IEC 62548)</td><td>string $V_{oc}$ at the coldest site temperature and $V_{mp}$ at the hottest cell temperature against the inverter's DC-maximum and MPPT windows; MPPT input current with a 1.25 factor</td></tr>
<tr><td>SANS 10142-1</td><td>see below</td></tr></tbody></table>
<h4>SANS 10142-1 checks</h4>
<ul>
<li><strong>Cl. 5.5.2 / IEC 60364-4-43 §433.1 — overload coordination:</strong> $I_n\le I_z$ and $I_2\le1.45\,I_z$. $I_n$ is a breaker's setting $I_r$ (not its frame), $I_z$ covers all parallel runs; $I_2$ = 1.45 $I_n$ (MCB), 1.30 $I_r$ (MCCB/ACB), 1.6 $I_n$ (gG fuse ≥ 16 A — so a fuse needs $I_n\le0.91\,I_z$).</li>
<li><strong>Cl. 5.6.3 — minimum conductor size:</strong> 1.5 mm² Cu for fixed wiring; 2.5 mm² for socket-outlet circuits.</li>
<li><strong>Cl. 8.3.1 — neutral earthing:</strong> LV source neutral earthed for TN/TT; insulation monitoring for IT. The LV winding is read from the lower-case letters of the vector group (Dyn11 → yn, YNd11 → d: no LV neutral); for a star winding the LV grounding setting decides.</li>
<li><strong>Cl. 6 / IEC 60364-1 §312 — earthing system:</strong> RCD not permitted on a PEN (TN-C); RCD required on TT with $R_A\,I_{\Delta n}\le50$ V (IEC 60364-4-41 §411.5.3); IMD required on IT. Each LV source is judged with the residual devices of its own installation (everything reachable without crossing a transformer): board earth-leakage groups and breaker earth-fault releases, whose pickup counts as $I_{\Delta n}$.</li>
<li><strong>Appendix B / NRS 034 — maximum demand:</strong> the nameplate demand of the LV loads (× demand factor; induction motors at input kVA) must not exceed the installed LV transformer capacity; warning above 80 % utilisation.</li>
<li><strong>Cl. 5.5.6 — earth-fault disconnection:</strong> each breaker or fuse is judged at the <em>far end of its own circuit</em> — the lowest earth-fault current among the buses (or bus-less load terminals) on its load side — and its operating time there must meet the limit: Table 41.1 for final circuits (0.4 s at 230 V; socket circuits up to 63 A, fixed equipment up to 32 A), 5 s for distribution circuits. Uses the <em>minimum</em> current basis ($c_{min}=0.95$, hot conductors; IEC 60909-0 §5.3.1). Applies to circuits in TN installations; TT and IT circuits are covered by the earthing-system check. A breaker's earth-fault release counts. For TN with no evaluable curve, the criterion falls back to $I_{k1}\ge10\,I_n$.</li>
<li><strong>Cl. 6.6 — voltage drop:</strong> total from the point of supply (3 % lighting, 5 % general); the per-way check is in <a href="#" data-help="cable-dbcheck">DB circuit check</a>.</li>
</ul>` }

);
