/* ProtectionPro — Plain-language field explainers.
 *
 * Fills the ⓘ explainer for fields FIELD_INFO (constants.js) doesn't document.
 * FIELD_INFO wins where both have an entry, and only FIELD_INFO fields raise
 * the sidebar's "default" flag — these are help text, not default sources.
 * Keyed like FIELD_INFO: "componentType.fieldKey", or a bare "fieldKey"
 * shared by every component that has the field. Same text conventions:
 * '\n' starts a new paragraph; a last line "Used by: A, B." becomes the
 * study chips in the properties window.
 */
const FIELD_HELP = {
  // ── Shared across components ──
  name: 'The label shown on the diagram, in result tables, schedules and reports. Keep it unique so results can be traced back to the right item.',
  voltage_kv: 'Nominal line-to-line voltage at this component\'s terminals. Keep it the same as the bus it connects to.\nUsed by: Load Flow, Fault Analysis.',
  rated_mva: 'Nameplate apparent-power rating. Its per-unit impedances are on this base, and load flow reports loading against it.\nUsed by: Load Flow, Fault Analysis.',
  rated_kva: 'Nameplate apparent-power rating in kVA. Its per-unit impedances and rated current are on this base.\nUsed by: Load Flow, Fault Analysis.',
  rated_kw: 'Rated real-power output.\nUsed by: Load Flow.',
  rated_current_a: 'Rated continuous current (nameplate In) of the device.\nUsed by: Duty Check, Compliance.',
  rated_voltage_kv: 'Rated voltage of the device. The duty check compares it with the highest voltage of the system (Ur ≥ Um).\nUsed by: Duty Check.',
  standard_type: 'Pick an entry from the library (Settings) to fill in the rating and impedance fields. Choose "-- Custom --" to enter your own values.',
  state: 'Open or closed. An open device disconnects the circuit in every study.',
  power_factor: 'Operating power factor (cos φ), which sets the reactive power at a given real power.\nUsed by: Load Flow.',
  efficiency: 'Conversion efficiency, as a fraction. Input power = output power ÷ efficiency.\nUsed by: Load Flow.',
  x_r_ratio: 'Ratio of reactance to resistance of the impedance. A higher X/R gives a larger dc offset, which raises the peak current ip and the asymmetrical breaking duty.\nUsed by: Fault Analysis, Duty Check.',
  x2: 'Negative-sequence reactance, in per-unit on the machine rating. It sets the machine\'s contribution to unbalanced faults (line-to-line, earth faults).\nUsed by: Fault Analysis.',
  x0: 'Zero-sequence reactance, in per-unit on the machine rating. It only matters when the machine\'s neutral is earthed.\nUsed by: Fault Analysis.',
  essential: 'Whether this load stays connected on backup supply. The backup autonomy estimate assumes loads marked "no" are shed.\nUsed by: Backup Autonomy.',
  demand_factor: 'Fraction of the rated load that is actually drawn (0–1). Load flow scales the load by it.\nUsed by: Load Flow.',
  length_km: 'Route length of the run. Series impedance and voltage drop scale with it.\nUsed by: Load Flow, Fault Analysis, Cable Sizing.',
  num_parallel: 'Number of identical circuits run in parallel. Impedance is divided by it and current capacity multiplied by it.\nUsed by: Load Flow, Fault Analysis, Cable Sizing.',

  // ── Utility ──
  'utility.z2_z1_ratio': 'Ratio of the grid\'s negative-sequence to positive-sequence impedance. 1.0 is usual for a network infeed.\nUsed by: Fault Analysis.',
  'utility.z0_z1_ratio': 'Ratio of the grid\'s zero-sequence to positive-sequence impedance. It sets the earth-fault level at the point of supply. Use the value from the utility\'s fault-level letter if it has one.\nUsed by: Fault Analysis.',
  'utility.allow_export': 'Whether surplus local generation may flow back into the grid. "yes" lets the grid absorb it; "no" curtails the generation instead.\nUsed by: Load Flow.',
  'utility.supply_capacity_mva': 'Firm or contracted capacity of the supply. 0 means unlimited. Standby generators are dispatched only for demand beyond it.\nUsed by: Load Flow.',

  // ── Transformer ──
  'transformer.standard_type': 'Pick a transformer from the library (Settings) to fill in the rating, voltages, Z%, X/R and vector group. Those fields stay locked until you choose "-- Custom --".',
  'transformer.winding_config': 'Step down puts the HV winding on the top (primary) port. Step up puts it on the secondary port, e.g. for a generator transformer.\nUsed by: Load Flow, Fault Analysis.',
  'transformer.rated_mva': 'Nameplate rating (ONAN). Z% is on this base, and load flow reports the transformer\'s loading against it.\nUsed by: Load Flow, Fault Analysis, Contingency.',
  'transformer.grounding_hv': 'How the HV star point is earthed. Only an earthed neutral passes zero-sequence (earth-fault) current, so this setting, not the vector-group letters, decides the earth-fault path.\nUsed by: Fault Analysis.',
  'transformer.grounding_hv_resistance': 'Resistance of the HV neutral earthing resistor. In the zero-sequence path it counts three times (3R), which limits the earth-fault current.\nUsed by: Fault Analysis.',
  'transformer.grounding_hv_reactance': 'Reactance of the HV neutral earthing reactor. In the zero-sequence path it counts three times (3X).\nUsed by: Fault Analysis.',
  'transformer.grounding_lv_resistance': 'Resistance of the LV neutral earthing resistor. In the zero-sequence path it counts three times (3R), which limits the earth-fault current.\nUsed by: Fault Analysis.',
  'transformer.grounding_lv_reactance': 'Reactance of the LV neutral earthing reactor. In the zero-sequence path it counts three times (3X).\nUsed by: Fault Analysis.',

  // ── Cable / feeder ──
  'cable.standard_type': 'Pick a cable from the cable library to fill in its impedances and current rating. You can still edit a filled-in value; ↩ resets it to the library figure.',
  'cable.overhead_type': 'Pick a conductor from the overhead-line library to fill in its impedances and thermal rating.',
  'cable.voltage_kv': 'Nominal voltage of the feeder. Keep it the same as the buses at its ends; the cable picker lists cables for the voltage of those buses.',
  'cable.ampacity_standard': 'Which rating basis the cable-sizing check uses for current-carrying capacity: IEC 60364-5-52 or the NEC tables.\nUsed by: Cable Sizing.',
  'cable.r0_per_km': 'Zero-sequence resistance per km, including the earth or sheath return. It sets the earth-fault current along the run.\nUsed by: Fault Analysis.',
  'cable.x0_per_km': 'Zero-sequence reactance per km, including the earth or sheath return.\nUsed by: Fault Analysis.',

  // ── Circuit breaker ──
  'cb.cb_type': 'MCB: miniature breaker with a fixed B/C/D curve (IEC 60898-1).\nMCCB: moulded-case breaker with thermal-magnetic or electronic trip.\nACB: air circuit breaker with a short-time (ST) stage for selectivity.\nThe type sets which protection fields show.\nUsed by: TCC, Duty Check.',
  'cb.mounting': 'Fixed or withdrawable. It is recorded for schedules and reports; the studies don\'t use it.',
  'cb.mcb_curve': 'IEC 60898-1 instantaneous trip band: B trips at 3–5×In, C at 5–10×In and D at 10–20×In. Changing the curve sets Magnetic Pickup to the top of its band.\nUsed by: TCC, Compliance.',
  'cb.trip_rating_a': 'Trip unit rating In. Thermal and magnetic pickups are multiples of it.\nUsed by: TCC, Arc Flash.',
  'cb.short_time_pickup': 'Short-time (ST) pickup as a multiple of Ir. Between this and Instantaneous, the breaker waits for ST Delay, which lets a downstream device clear first.\nUsed by: TCC, Arc Flash.',
  'cb.short_time_delay': 'Short-time delay in seconds: the intentional wait before the breaker trips on the ST stage. It sets the grading margin to downstream devices.\nUsed by: TCC, Arc Flash.',
  'cb.instantaneous_pickup': 'Instantaneous pickup as a multiple of Ir. Above it the breaker trips with no intentional delay.\nUsed by: TCC, Arc Flash.',

  // ── Relay ──
  'relay.relay_type': 'Protection function (ANSI numbers):\n50/51: phase overcurrent (instantaneous / time-delayed)\n50N/51N: earth-fault overcurrent\n67: directional overcurrent\n87: differential\n21: distance\nThe type sets which setting fields show.\nUsed by: TCC, Arc Flash.',
  'relay.inst_delay_s': 'Intentional delay added to the instantaneous (50) element. 0 means trip as fast as the relay can.\nUsed by: TCC, Arc Flash.',
  'relay.z1_delay_s': 'Zone 1 time delay, usually 0 (instantaneous) for the underreaching zone.\nUsed by: TCC.',
  'relay.z2_delay_s': 'Zone 2 time delay. It must grade with Zone 1 of the next line section.\nUsed by: TCC.',
  'relay.z3_delay_s': 'Zone 3 (remote backup) time delay. It is the longest of the three zones.\nUsed by: TCC.',

  // ── Switch & changeover ──
  'switch.switch_type': 'Switch-disconnector: can make and break load current and gives isolation.\nLoad-break switch: can switch load current.\nDisconnector: off-load isolation only, and must not be operated under load.',
  'changeover.co_type': 'How the two supplies are selected:\nManual I–0–II: centre-off rotary changeover.\nManual I–II: no off position.\nATS: automatic transfer switch with transfer and retransfer delays.\nInterlocked breaker pair: two breakers, only one closed at a time.\nEvery study sees only the selected input.',
  'changeover.co_layout': 'How the symbol is drawn:\n2 inputs → 1 output: terminals I and II on top, the common terminal below (a supply changeover).\n1 input → 2 outputs: the common terminal on top, I and II below (one supply switched to either of two loads).\nDrawing only — every study treats both the same way: the selected terminal is connected to the common one. Use this instead of rotating the switch 180°, so the text stays upright.',
  'changeover.state': 'Which input feeds the output. Studies run with only this input connected; the other input is left open.\nUsed by: all studies.',
  'changeover.contact_duty': 'Switching duty of the changeover contacts: switch-disconnector, load-break, or off-load disconnector.',
  'changeover.transfer_delay_s': 'Time the ATS waits after the normal supply fails before it transfers to the standby input.',
  'changeover.cb_trip_rating_a': 'Trip unit rating In of this breaker. Thermal and magnetic pickups are multiples of it. Leave blank to use the changeover\'s Rated Current.\nUsed by: TCC, Arc Flash, Duty Check.',
  'changeover.retransfer_delay_s': 'Time the ATS waits after the normal supply returns before it transfers back.',

  // ── Loads ──
  'motor_induction.rated_kw': 'Rated shaft output. Input power = kW ÷ (efficiency × power factor) gives the running kVA and full-load current.\nUsed by: Load Flow, Motor Starting, Fault Analysis.',
  'motor_synchronous.rated_kva': 'Nameplate apparent-power rating, the base for the machine\'s per-unit reactances.\nUsed by: Load Flow, Fault Analysis.',
  'static_load.phase_connection': 'Which phases the load is connected across: a balanced three-phase load, or a single-phase load on one phase. A single-phase load unbalances the network.\nUsed by: Load Flow.',
  'distribution_board.board_diversity': 'Diversity factor applied to the board\'s connected circuit load (0.1–1) to get the demand the upstream network sees.\nUsed by: Load Flow, Load Diversity.',
  'distribution_board.ze_ohm': 'External earth-fault loop impedance Ze at the board\'s origin. The circuit check adds each circuit\'s own loop to it and compares Zs with the protective device\'s disconnection limit.\nUsed by: DB Circuit Check.',

  // ── Other ──
  'capacitor_bank.rated_kvar': 'Reactive-power rating at rated voltage. Output scales with V², so it falls off when the voltage sags.\nUsed by: Load Flow, Harmonics.',
  'capacitor_bank.steps': 'Number of equal switched steps the bank is split into.\nUsed by: Load Flow.',
  'surge_arrester.class': 'Arrester duty class (IEEE C62.11): station, intermediate or distribution. Station class has the highest energy capability.',
  'offpage_connector.linked_to': 'The matching connector on another sheet. Linked pairs join the two sheets into one network in every study; an unlinked connector ends the circuit.\nUsed by: all studies.',
};
