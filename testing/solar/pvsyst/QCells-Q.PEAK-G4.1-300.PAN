PVObject_=pvModule
  Version=6.78
  Flags=$00100043

  PVObject_Commercial=pvCommercial
    Comment=Hanwha Q CELLS GmbH (www.q-cells.com)
    Flags=$0041
    Manufacturer=Hanwha Q Cells
    Model=Q.PEAK-G4.1 300
    DataSource=CFV Solar Test Lab - Tested Class
    YearBeg=2016
    Width=1.000
    Height=1.670
    Depth=0.032
    Weight=18.800
    NPieces=100
    PriceDate=20/12/19 13:20
    Remarks, Count=5
      Str_1=Frame: Black anodised aluminium
      Str_2=Structure: 3.2 mm thermally pre-stressed glass w. anti-reflection
      Str_3=Connections: Multi-Contact, MC4, (IP65 and IP68)
      Str_4
      Str_5
    End of Remarks
  End of PVObject pvCommercial

  Technol=mtSiMono
  NCelS=60
  NCelP=1
  NDiode=3
  FrontSurface=fsNormalGlass
  GRef=1000
  TRef=25.0
  PNom=300.0
  PNomTolLow=0.00
  PNomTolUp=3.00
  Isc=9.756
  Voc=40.22
  Imp=9.235
  Vmp=32.48
  muISC=3.20
  muVocSpec=-110.9
  muPmpReq=-0.396
  RShunt=397
  Rp_0=1474
  Rp_Exp=5.50
  RSerie=0.325
  Gamma=0.995
  muGamma=-0.0005
  VMaxIEC=1000
  VMaxUL=1000
  Absorb=0.90
  ARev=3.200
  BRev=11.700
  RDiode=0.010
  VRevDiode=-0.70
  AirMassRef=1.500
  CellArea=244.3
  SandiaAMCorr=50.000

  PVObject_IAM=pvIAM
    Flags=$00
    IAMMode=UserProfile
    IAMProfile=TCubicProfile
      NPtsMax=9
      NPtsEff=9
      LastCompile=$B18D
      Mode=3
      Point_1=0.0,1.00000
      Point_2=20.0,1.00000
      Point_3=40.0,1.00000
      Point_4=60.0,0.97000
      Point_5=70.0,0.90000
      Point_6=75.0,0.83000
      Point_7=80.0,0.69000
      Point_8=85.0,0.44000
      Point_9=90.0,0.00000
    End of TCubicProfile
  End of PVObject pvIAM
End of PVObject pvModule
