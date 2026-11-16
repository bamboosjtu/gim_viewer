const assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
async function main(){
 const root=path.resolve(__dirname,'../..'),THREE=await import(pathToFileURL(path.join(root,'node_modules/three/build/three.module.js')));
 const {prepareStaticModel}=await import(pathToFileURL(path.join(root,'assets/web/js/static_scene.js')));
 const {DoorManager}=await import(pathToFileURL(path.join(root,'assets/web/js/doors.js')));
 const {advancePlayer}=await import(pathToFileURL(path.join(root,'assets/web/js/frame_time.js')));
 for(const fps of [60,30,10,8]){let distance=0,maxStep=0;for(let frame=0;frame<fps*5;frame++)advancePlayer(1/fps,dt=>{distance+=3.35*dt;maxStep=Math.max(maxStep,dt)});assert(Math.abs(distance-16.75)<1e-7);assert(maxStep<=.02500001)}
 let bounded=0;advancePlayer(8,dt=>bounded+=dt);assert(Math.abs(bounded-.25)<1e-9,'background stalls do not cause a long teleport');
 const scene=new THREE.Scene(),model=new THREE.Group(),fixed=new THREE.Mesh(new THREE.BoxGeometry()),panel=new THREE.Mesh(new THREE.BoxGeometry(2,2,.1));
 panel.name='test-panel';panel.geometry.translate(1,1,0);fixed.position.set(3,4,5);model.add(fixed,panel);scene.add(model);
 const manager=new DoorManager(model,{doors:[{id:'source-door',name:'test',axis:'y',center:[1,0,1],bbox:[0,-.05,0,2,.05,2],bottom:0,top:2,leaves:[{name:panel.name,kind:'swing',angle:Math.PI/2}]}]});
 const nodes=[];model.traverse(o=>nodes.push(o));let staticUpdates=0,worldChanges=0;const original=fixed.updateMatrixWorld;fixed.updateMatrixWorld=function(...args){staticUpdates++;return original.apply(this,args)};
 const pose=prepareStaticModel(model,nodes,[panel],()=>{worldChanges++;manager.refreshAllTargets()});staticUpdates=0;
 for(let i=0;i<100;i++)scene.updateMatrixWorld(true);
 assert.equal(staticUpdates,0,'unchanged static model must not be walked each frame');
 const closed=panel.matrixWorld.clone();manager.toggle(manager.entries[0]);
 for(let i=0;i<30;i++){manager.update(1/30);scene.updateMatrixWorld(true)}
 assert(!panel.matrixWorld.equals(closed),'door still animates under static model');
 assert.equal(manager.entries[0].t,1);assert(manager.nearest(0,-1,0,0,1,3.4));
 const point=manager.entries[0].targets[1];assert(Math.abs(point[0])<1e-5&&Math.abs(point[1]-1)<1e-5,'nearest uses the actual opened panel pose');
 assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(fixed.matrixWorld).toArray(),[3,4,5]);
 model.position.x=10;scene.updateMatrixWorld(true);assert.equal(worldChanges,1);assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(fixed.matrixWorld).toArray(),[13,4,5]);
 const other=new THREE.Group();other.position.y=7;scene.add(other);other.add(model);scene.updateMatrixWorld(true);assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(fixed.matrixWorld).toArray(),[13,11,5]);
 manager.toggle(manager.entries[0]);for(let i=0;i<30;i++){manager.update(1/30);scene.updateMatrixWorld(true)}assert.equal(manager.entries[0].t,0);
 pose.dispose();assert(fixed.matrixAutoUpdate&&model.matrixAutoUpdate&&panel.matrixAutoUpdate);
 console.log(JSON.stringify({passed:true,cases:['no repeated static traversal','dynamic door and current interaction pose','model transform changes','parent migration','close/reopen','restore update ownership']}));
}
main().catch(e=>{console.error(e);process.exitCode=1});
