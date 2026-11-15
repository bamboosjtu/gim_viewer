// Adapt explicit proxy object roles without changing their IFC source identity.
// A name is evidence about this object, never a way to bind different objects.
function navigationRole(type, name = '', objectType = '', box = null) {
  const typed={IfcDoor:'door',IfcDoorStandardCase:'door',IfcWall:'wall',IfcWallStandardCase:'wall',
    IfcWallElementedCase:'wall',IfcCurtainWall:'wall',IfcColumn:'column',IfcColumnStandardCase:'column',IfcRailing:'railing',IfcWindow:'window',
    IfcSlab:'floor',IfcStair:'stairs',IfcStairFlight:'stairs',IfcRamp:'ramp',IfcRampFlight:'ramp',IfcLanding:'floor',IfcCovering:'floor',IfcRoof:'roof'};
  if(typed[type])return {role:typed[type],evidence:'ifc-type'};
  if(type!=='IfcBuildingElementProxy')return {role:null};
  const text=(name+' '+objectType).trim();
  if(/门洞|门框|柜门|箱门|\b(?:cabinet|opening|frame)\b/i.test(text))return {role:null};
  if(/建筑门定位|^(?:建筑)?(?:木门|防火门|钢门|卷帘门|平开门|门)(?:定位)?$|\b(?:door|PBArchDoor)\b/i.test(text.trim())){
    if(!box)return {role:null};
    const dx=box[3]-box[0],dy=box[4]-box[1],h=box[5]-box[2],w=Math.max(dx,dy),t=Math.min(dx,dy);
    if(w>=.55&&w<=8&&h>=1.6&&h<=6&&t<=.5&&t/w<.35)return {role:'door',evidence:'proxy-label-and-panel-shape'};
    return {role:null,rejected:'proxy-door-shape'};
  }
  const patterns=[
    ['roof',/建筑屋面|建筑屋顶|PBStructRoof|\broof\b/i],
    ['floor',/建筑楼板|建筑地板|建筑地坪|PBStructSlab|\bfloor(?:ing)?\b|\bslab\b/i],
    ['stairs',/建筑楼梯|建筑台阶|PBStructStair|\bstair/i],
    ['ramp',/建筑坡道|斜坡道|\bramp\b/i],
    ['wall',/建筑墙|防爆墙|防火墙|百叶墙|围护墙|幕墙|PBStructWall|\bwall\b/i],
    ['column',/建筑柱|PBStructColumn|\bcolumn\b/i],
    ['beam',/PBStructBeam|建筑梁|\bbeam\b/i],
    ['window',/建筑窗定位|建筑窗|PBArchWindow|\bwindow\b/i],
    ['railing',/建筑栏杆|PBStructRailing|\brailing\b/i],
    ['ground',/^(?:广场|道路|场坪|站区地面|地面)(?:\s|$)|\b(?:pavement|site ground)\b/i],
  ];
  for(const [role,re] of patterns)if(re.test(text))return {role,evidence:'proxy-object-label'};
  return {role:null};
}
module.exports={navigationRole};
