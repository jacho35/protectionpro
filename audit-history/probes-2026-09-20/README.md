# Probes for `CALC_AUDIT_REVIEW_2026-09-20.md`

Reproduction scripts for the findings in `../CALC_AUDIT_REVIEW_2026-09-20.md` (the review of
`../CALC_AUDIT_2026-09-20.md`). Read-only — they build synthetic networks in memory and call the
engines directly. Nothing is written, and no project or customer data is involved.

## Running

From the repo root, in the backend image (the host Python is 3.9 and cannot import the package):

```bash
docker run --rm -v "$PWD":/work -w /work protectionpro-backend \
  python audit-history/probes-2026-09-20/<probe>.py
```

## Files

| File | Finding | What it shows |
|---|---|---|
| `_net.py` | — | Shared fixtures: `lv_cable_only()` and `xfmr_chain()` |
| `probe_f1_cable_base.py` | **F-1** (confirms the audit) | Cable-only chains take the pu base from the cable's own `voltage_kv` prop, not the bus zone — `loadflow.py:2343` → `_get_impedance` `loadflow.py:1654-1660` |
| `probe_r1_blast_radius.py` | **R-1** (corrects the audit) | The same defect in `network_reduction.py:210` and `unbalanced_loadflow.py:365-375`, reaching transient stability and dynamic motor starting |
| `probe_n1_num_parallel.py` | **N-1** (new defect) | `/ num_parallel` dropped at `loadflow.py:2338` and `network_reduction.py:206`; V is bit-identical across 1/2/4 parallel circuits on the legacy path |

## Expected output

Recorded 2026-09-20 against `protectionpro-backend:latest`, with the full suite green
(859 passed). A probe printing something else means the code has moved since.

```
probe_f1_cable_base    cable voltage_kv=11  -> V(bus-2)=0.999994,  2.62 A
                       cable voltage_kv=0.4 -> V(bus-2)=0.995213, 72.52 A     (798x drop error)

probe_r1_blast_radius  build_branch_ybus  chain Z  0.01240+0.00331j  vs  9.37500+2.50000j pu
                       build_port_zbus    Zth      0.03230+0.20231j  vs  9.39490+2.69901j pu
                       unbalanced_loadflow  Va     0.999994          vs  0.995214 pu

probe_n1_num_parallel  legacy path (t==1):  V(bus-2)=0.977838 for num_parallel 1, 2 AND 4
                       exact path (t!=1):   1.028939 / 1.038304 / 1.042922   (correct)
                       network_reduction:   Zth identical for 1, 2 and 4
```
