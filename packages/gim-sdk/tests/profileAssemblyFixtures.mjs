export const profiles = [
  '<Table LL1="8" LL2="6" TL1="4" TL2="3" H="6"/>',
  '<BendingCylindrical R="2" L="15" Rad="1.5"/>',
  '<Ring R="20" DR="2"/>',
  '<RectangularRing L="40" W="20" R="5" DR="1"/>',
  '<EllipticRing L="20" W="12" DR="1"/>',
  '<CircularGasket OR="20" IR="10" H="2"/>',
  '<TableGasket OR="20" TR="30" IR="10" H="2"/>',
  '<SquareGasket L1="40" W1="30" L2="20" W2="10" H="2" CT="3" CL="2"/>',
  ...["AngleSteel", "I-shapedsteel", "ChannelSteel", "T-Steels"].map(
    (t) => `<${t} B="40" H="60" D="3" T="5" L="100"/>`,
  ),
];

export const bodies = [
  '<RotationalEllipsoid LR="600" WR="300" H="700"/>',
  '<PorcelainBushing R="8" R1="15" R2="12" H="60" N="3"/>',
  '<ConePorcelainBushing BR="10" TR="8" BR1="24" TR1="16" BR2="22" TR2="14" H="60" N="3"/>',
  ...['Insulator N="2" D="16"', 'VTypeInsulator X="20" AD="8"'].map(
    (s) => `<${s} R="3" R1="5" R2="4" N1="4" H1="10" FL="3" AL="7" LN="2"/>`,
  ),
  '<Wire D="2" Sag="3" StartCoord="0,0,0" EndCoord="10,0,0" StartVector="1,-1,0" EndVector="1,1,0" FitCoordArray="0,0,0;5,-2,0;10,0,0"/>',
  '<CurveCable D="2" CurveTypeArray="0,2" CurveControlCoordArray="0,0,0;10,0,0|1,0,0;0,1,0;10,0,0;12,4,0;15,8,0|"/>',
];
