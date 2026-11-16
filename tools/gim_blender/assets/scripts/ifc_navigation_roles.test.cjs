const assert=require('node:assert/strict');
const {navigationRole}=require('./ifc_navigation_roles.cjs');
for(const name of ['双跑U型楼梯','双跑U型楼梯（含扶手）','直行单跑楼梯','混凝土台阶','钢梯踏步','室外楼梯-01','建筑楼梯']){
 assert.equal(navigationRole('IfcBuildingElementProxy',name).role,'stairs',name);
}
for(const name of ['建筑栏杆','楼梯栏杆','楼梯扶手','建筑楼梯扶手'])assert.equal(navigationRole('IfcBuildingElementProxy',name).role,'railing',name);
assert.notEqual(navigationRole('IfcBuildingElementProxy','楼梯间墙').role,'stairs');
assert.equal(navigationRole('IfcStairFlight','').role,'stairs');
assert.equal(navigationRole('IfcRampFlight','').role,'ramp');
assert.equal(navigationRole('IfcBuildingElementProxy','建筑楼板').role,'floor');
console.log(JSON.stringify({passed:true,cases:['generic proxy stair names','stair railing stays a body collider','stairwell wall is not a stair','typed IFC stair/ramp unchanged']}));
