import type {EngineeringSnapshot} from '../engineering/types.js';

const ordered=(rows:unknown[])=>rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Canonical, format-neutral identity and ownership evidence for cold/warm comparison. */
export function engineeringSemanticEvidence(snapshot:EngineeringSnapshot){
  const memberships=new Map(snapshot.memberships.map(row=>[row.sourceId,row]));
  const sources=new Set(snapshot.memberships.map(row=>row.sourceId));
  const pendingIds=new Set(snapshot.pending.map(row=>row.id));
  const entityIds=new Set(snapshot.entities.map(row=>row.id));
  const pendingRows=ordered(snapshot.pending.map(row=>[row.id,row.reason,
    ordered(row.sourceIds.map(sourceId=>{
      const member=memberships.get(sourceId);
      return [sourceId,member?.disposition??null,member?.interpretation.category??null,
        member?.interpretation.meaning??null];
    }))]));
  const pendingSources=new Map(snapshot.pending.map(row=>[row.id,new Set(row.sourceIds)]));
  const checks=[
    {name:'pending-id-unique',passed:pendingIds.size===snapshot.pending.length},
    {name:'pending-owner-disjoint',passed:[...pendingIds].every(id=>!entityIds.has(id))},
    {name:'pending-source-valid',passed:snapshot.pending.every(row=>row.sourceIds.length>0&&row.sourceIds.every(id=>sources.has(id)))},
    {name:'pending-source-unique',passed:snapshot.pending.every(row=>new Set(row.sourceIds).size===row.sourceIds.length)},
    {name:'pending-membership-consistent',passed:snapshot.pending.every(row=>row.sourceIds.every(id=>{
      const member=memberships.get(id);return member?.ownerId===row.id&&member.disposition==='pending_whole_member';
    }))&&snapshot.memberships.every(row=>row.disposition!=='pending_whole_member'||
      row.ownerId!==null&&pendingSources.get(row.ownerId)?.has(row.sourceId)===true)},
  ];
  return {pendingRows,pendingCount:snapshot.pending.length,
    pendingSourceCount:snapshot.pending.reduce((total,row)=>total+row.sourceIds.length,0),checks,
    semanticRows:{
      entities:ordered(snapshot.entities.map(row=>[row.id,row.category,row.kind,row.classificationState,
        row.classificationStatus??null,ordered([...row.sourceIds])])),
      pending:pendingRows,
      memberships:ordered(snapshot.memberships.map(row=>[row.sourceId,row.ownerId,row.disposition,
        row.interpretation.category,row.interpretation.meaning,row.interpretation.classificationStatus??null])),
      relationships:ordered(snapshot.relationships.map(row=>[row.from,row.to,row.kind,row.evidence])),
    }};
}
