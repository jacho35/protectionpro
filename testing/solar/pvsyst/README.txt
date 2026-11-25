Real PVsyst files used by testing/unit/solar-import.test.js (public manufacturer data, copied unchanged from the test data of
pvlib-python, BSD-3-Clause): a module (.PAN, ET Solar ET-M772BH550GL) and an inverter (.OND, Chint Power CPS SCH275KTL-DO/US-800).
They show the real key names: the inverter's nominal power is PNomConv in kW, its phases are MonoTri, and files may start with a BOM.

Four more real modules from other vendors, in the older PVsyst 6.78 format, copied unchanged from the Sandia PV Performance Modeling
Collaborative's public downloads (CFV Solar Test Lab "tested class" data): LG 320 N1K-A5, Mission Solar MSE300SQ5T, Canadian Solar
CS6K-275M, Hanwha Q Cells Q.PEAK-G4.1 300. The LG file as downloaded ends where its incidence-angle table starts (no points), which
is a useful case: the importer must fall back to the generic table.
