import {COMPOSITION_POLICY,componentHostCompatibility,separateInstallation,isEquipmentHost,unclassifiedAssemblyCandidate,COMPOSITION_SUBTYPE_COMPONENTS,compositionSubtypeHost,compositionSubtype} from './compositionPolicy.js';
import { ENGINEERING_RULES_VERSION, explicitMain, interpretRecognitionObject as interpretObject, categoryFromName } from './classify.js';
import { assertEngineeringPartition } from './validate.js';
import { categoryDefinition,publishDirectoryClassification } from './catalogLabels.js';
import { classificationDetails } from './classificationDetails.js';
import {recoverComponentMembership} from './recoverMembership.js';
import type { EngineeringEntity, EngineeringSnapshot, ObjectEvidence, ObjectInterpretation, PendingWhole, SourceAlias } from './types.js';

/** Lossless package-local identity. No class version, tree parent or traversal counter. */
const identity = (scope: string, kind: string, seed: string) => `${kind}:${JSON.stringify([scope, seed])}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const transformer = (category: string | undefined) => !!category && ['E01','E-T','E03'].includes(category);
const reserve = (row: ObjectEvidence) => row.designations.some(p=>/备用|预留/.test(p.value));
const explicitIndependent = (row: ObjectEvidence) => row.objectRoles?.some(p=>p.value==='independent') ?? false;
function wholeName(row:ObjectEvidence,category:string):string {
  const number=explicitMain(row);
  if(category==='E01'&&number)return `${number}号${reserve(row)?'备用':''}主变`;
  return row.identityNames.find(p=>{const c=categoryFromName(p.value);return c===category||category.startsWith('E16')&&c.startsWith('E16');})?.value??row.name;
}

export function normalizeEngineeringModel(scope: string, input: readonly ObjectEvidence[], aliases: readonly SourceAlias[] = []): EngineeringSnapshot {
  if (!scope) throw new Error('Engineering scope is required');
  const ordered = [...input].sort((a, b) => compare(a.sourceId, b.sourceId));
  const raw = new Map(ordered.map(row => [row.sourceId, row]));
  if (raw.size !== input.length || raw.has('')) throw new Error('Source occurrence IDs must be unique and nonempty');
  // Validate the whole graph before grouping. Preassigned set members must not
  // hide cycles that recursive ownership lookup would otherwise skip.
  const checked = new Set<string>();
  for (const row of ordered) {
    const branch = new Set<string>();
    let cursor: string | undefined = row.sourceId;
    while (cursor && raw.has(cursor) && !checked.has(cursor)) {
      if (branch.has(cursor)) throw new Error(`Source assembly cycle: ${cursor}`);
      branch.add(cursor); cursor = raw.get(cursor)!.assemblyParentId;
    }
    branch.forEach(id => checked.add(id));
  }
  const parents = new Set(ordered.filter(row => !row.traits.nonphysical).map(row => row.assemblyParentId).filter(Boolean));
  const meaning = new Map(ordered.map(row => [row.sourceId, interpretObject(row, parents.has(row.sourceId))]));
  const entities = new Map<string, EngineeringEntity>();
  const pending = new Map<string, PendingWhole>();
  const owners = new Map<string, string | null>();
  const relationships: EngineeringSnapshot['relationships'] = [];
  const diagnostics: EngineeringSnapshot['diagnostics'] = [];

  function addEntity(seed: string, category: string, name: string, proof: string, sourceIds: string[], kind: EngineeringEntity['kind'] = 'whole') {
    const id = identity(scope, 'entity', seed);
    if (entities.has(id)) throw new Error(`Engineering identity collision: ${id}`);
    entities.set(id, { id, category, name, kind, boundaryEvidence: proof,
      classificationState: category === 'U-OBJECT' ? 'unknown' : 'identified', sourceIds: [], classificationConflicts: 0,
      classificationStatus:meaning.get(sourceIds.find(id=>meaning.get(id)?.category===category)??'')?.classificationStatus??(category==='U-OBJECT'?'unresolved':'confirmed'),
      boundaryStatus:proof==='outward_object_boundary_unconfirmed'||kind!=='whole'
        ||sourceIds.some(id=>meaning.get(id)?.equipmentType||meaning.get(id)?.componentType||meaning.get(id)?.classificationStatus!=='confirmed')&&!sourceIds.some(id=>raw.get(id)?.identityCodes.length||raw.get(id)?.designations.length||explicitIndependent(raw.get(id)!))
        ||COMPOSITION_POLICY.boundaryRequiresIdentity.includes(category)&&!sourceIds.some(id=>raw.get(id)?.identityCodes.length)?'candidate':'confirmed',
      grain:categoryDefinition(category)?.grain as 'item'|'segment'|undefined,
      ...classificationDetails(category),
    });
    const interpreted=sourceIds.map(id=>meaning.get(id)!).find(m=>m.category===category);
    if(interpreted)Object.assign(entities.get(id)!,{standardClass:interpreted.standardClass,subtype:interpreted.subtype,subtypeLabel:interpreted.subtypeLabel,unknownReason:interpreted.unknownReason});
    sourceIds.forEach(sourceId => owners.set(sourceId, id));
    return entities.get(id)!;
  }
  function bundle(seed: string, reason: string, sourceIds: string[]) {
    const id = identity(scope, 'pending', seed);
    if (pending.has(id)) throw new Error(`Pending identity collision: ${id}`);
    pending.set(id, { id, reason, sourceIds: [] });
    sourceIds.forEach(sourceId => owners.set(sourceId, id));
    return id;
  }

  const banks = new Map<string, ObjectEvidence[]>();
  for (const row of ordered) {
    const m = meaning.get(row.sourceId)!;
    const number = explicitMain(row);
    if (owners.has(row.sourceId) || explicitIndependent(row) || m.meaning !== 'object' || m.category !== 'E01' || !number || !row.phases.some(p => p.value === '单相')) continue;
    let parent=row.assemblyParentId,contained=false;
    while(parent&&raw.has(parent)){const ancestor=meaning.get(parent)!;if(ancestor.meaning==='object'&&transformer(ancestor.category)){contained=true;break;}parent=raw.get(parent)?.assemblyParentId;}
    if(contained)continue;
    const unit=`${number}${reserve(row)?':reserve':''}`;
    const members = banks.get(unit) ?? [];
    members.push(row); banks.set(unit, members);
  }
  for (const [number, members] of [...banks].sort(([a], [b]) => compare(a, b))) {
    if (members.length < 2) continue;
    const codes=new Set(members.flatMap(row=>row.identityCodes.map(p=>p.value)));
    const phases=members.flatMap(row=>row.phaseLabels?.map(p=>p.value.trim().toUpperCase())??[]);
    const parents=new Set(members.map(row=>row.assemblyParentId).filter(id=>id&&meaning.get(id)?.meaning!=='container'));
    if(members.length>COMPOSITION_POLICY.mainBank.maximumBodies||codes.size>1||parents.size>1||new Set(phases).size!==phases.length){
      diagnostics.push({kind:'whole_identity_conflict',identity:number,name:'主变成组证据冲突'});
      members.forEach(row=>bundle(`main-conflict:${row.sourceId}`,'transformer_bank_identity_conflict',[row.sourceId]));continue;
    }
    const entity = addEntity(`main-bank:${number}`, 'E01', wholeName(members[0],'E01'), 'explicit_main_designation+single_phase_bodies', members.map(row => row.sourceId), 'transformer_bank');
    entity.phaseBodyCount = members.length;
    entity.compositionState = 'phase_completeness_unverified';
  }

  const visiting = new Set<string>();
  const equipmentContexts=new Map<string,boolean>();
  const declaredEquipment=(value:ObjectInterpretation)=>isEquipmentHost(value)&&!['object_name','standard_name_candidate','family_identity_candidate','unknown'].includes(value.basis);
  function assign(sourceId: string): string | null {
    if (owners.has(sourceId)) return owners.get(sourceId)!;
    if (visiting.has(sourceId)) throw new Error(`Source assembly cycle: ${sourceId}`);
    visiting.add(sourceId);
    const row = raw.get(sourceId)!;
    let m = meaning.get(sourceId)!;
    const above = row.assemblyParentId && raw.has(row.assemblyParentId) ? assign(row.assemblyParentId) : null;
    const parentMeaning=row.assemblyParentId?meaning.get(row.assemblyParentId):undefined;
    const parentEquipment=!!(row.assemblyParentId&&(equipmentContexts.get(row.assemblyParentId)||parentMeaning&&declaredEquipment(parentMeaning)));
    if(row.equipmentMemberVariant&&parentEquipment){
      m=interpretObject(row.equipmentMemberVariant,parents.has(sourceId));meaning.set(sourceId,m);
    }
    const aboveCategory = above ? entities.get(above)?.category : undefined;
    const associate = (proof: string, evidence: string) => {
      const entity = addEntity(sourceId, m.category, wholeName(row,m.category), proof, [sourceId]);
      if (above) relationships.push({ from: entity.id, to: above, kind: 'associated_with', evidence });
    };
    if (m.basis === 'attribute_conflict') {
      bundle(sourceId,'object_attributes_conflict',[sourceId]);
    } else if (m.meaning === 'neutral_set') {
      if (transformer(aboveCategory)&&!explicitIndependent(row)) owners.set(sourceId, above);
      else bundle(sourceId, 'neutral_set_main_unresolved', [sourceId]);
    } else if (above && entities.has(above) && m.componentType?.status==='confirmed' && !explicitIndependent(row)) {
      const compatibility=componentHostCompatibility(m,entities.get(above)!);
      m.membershipEvidence=[...(m.componentType.evidence??[]),`assembly:${row.assemblyParentId}->${sourceId}`,`policy:${COMPOSITION_POLICY.version}:${m.componentType.id}`];
      if(compatibility==='compatible'){
        m.meaning='part';m.independent=false;m.basis='configured_component_assembly';m.membershipStatus='confirmed';owners.set(sourceId,above);
      }else{
        const reason=compatibility==='unconfigured'?'component_host_unconfigured':'component_host_incompatible';
        bundle(sourceId,reason,[sourceId]);m.membershipStatus='unresolved';diagnostics.push({kind:reason,identity:sourceId,name:row.name});
      }
    } else if (['source_only', 'container', 'detail'].includes(m.meaning)) {
      owners.set(sourceId, above);
    } else if (m.meaning === 'part') {
      if(m.componentType&&m.componentType.status!=='confirmed'&&!row.objectRoles?.some(p=>p.value==='part')){bundle(sourceId,'component_type_unresolved',[sourceId]);m.membershipStatus='unresolved';}
      else if (above) {owners.set(sourceId, above);m.membershipStatus='confirmed';m.membershipEvidence=[...(row.objectRoles?.map(p=>p.evidenceId)??[]),`assembly:${row.assemblyParentId}->${sourceId}`];}
      else bundle(sourceId, 'component_whole_unresolved', [sourceId]);
    } else if (above&&parentEquipment&&unclassifiedAssemblyCandidate(row,m)) {
      m.meaning='part';m.independent=false;m.basis='unclassified_equipment_assembly_member';m.membershipStatus='candidate';
      m.membershipEvidence=[`assembly:${row.assemblyParentId}->${sourceId}`,`policy:${COMPOSITION_POLICY.version}:unclassified-assembly-member`];
      if(m.objectRole)m.objectRole={id:'part',status:'candidate',evidence:m.membershipEvidence};
      owners.set(sourceId,above);
    } else if (m.independent) {
      associate('independent_function_identity', 'source_assembly_only');
    } else if (aboveCategory === 'U-OBJECT' && m.category !== 'U-OBJECT') {
      associate('object_identity_parent_boundary_unknown', 'unknown_parent_does_not_define_whole_boundary');
    } else if (aboveCategory) {
      associate(separateInstallation(m.category,aboveCategory)?'independent_installation_object':'object_identity_in_assembly', 'source_assembly_only');
    } else if (above && pending.has(above)) {
      addEntity(sourceId,m.category,wholeName(row,m.category),'object_identity',[sourceId]);
    } else {
      addEntity(sourceId, m.category, wholeName(row,m.category), m.category === 'U-OBJECT' ? 'outward_object_boundary_unconfirmed' : 'object_identity', [sourceId]);
    }
    equipmentContexts.set(sourceId,declaredEquipment(m)||parentEquipment&&['part','container','detail','source_only'].includes(m.meaning));
    visiting.delete(sourceId);
    return owners.get(sourceId)!;
  }
  for (const row of ordered) if (meaning.get(row.sourceId)!.meaning !== 'neutral_set') assign(row.sourceId);
  for (const row of ordered) assign(row.sourceId);

  // Index explicit host designations after traversal, so source order cannot
  // choose a host. A candidate spanning multiple main entities stays unresolved.
  const mainEntities = new Map<string, Set<string>>();
  for (const row of ordered) {
    const owner = owners.get(row.sourceId);
    const number = explicitMain(row);
    if (owner && number && entities.get(owner)?.category === 'E01' && meaning.get(row.sourceId)!.meaning === 'object' && transformer(meaning.get(row.sourceId)!.category)) {
      const unit=`${number}${reserve(row)?':reserve':''}`,ids = mainEntities.get(unit) ?? new Set<string>();
      ids.add(owner); mainEntities.set(unit, ids);
    }
  }
  const redirects = new Map<string, string>();
  for (const row of ordered) {
    if (meaning.get(row.sourceId)!.meaning !== 'neutral_set') continue;
    const previous = owners.get(row.sourceId);
    if (!previous || !pending.has(previous)) continue;
    const candidates = mainEntities.get(`${explicitMain(row)}${reserve(row)?':reserve':''}`);
    if (candidates?.size === 1) { redirects.set(previous, [...candidates][0]); pending.delete(previous); }
  }
  for (const [sourceId, owner] of owners) if (owner && redirects.has(owner)) owners.set(sourceId, redirects.get(owner)!);
  for (const relation of relationships) relation.to = redirects.get(relation.to) ?? relation.to;

  recoverComponentMembership(ordered,meaning,owners,entities,
    (source,reason)=>{bundle(`component-host:${source}`,reason,[source]);},
    (seed,category,name,source)=>addEntity(seed,category,name,'declared_component_host_boundary',[source]),diagnostics);
  const usedOwners=new Set(owners.values());
  for(const id of entities.keys())if(!usedOwners.has(id))entities.delete(id);
  for(const id of pending.keys())if(!usedOwners.has(id))pending.delete(id);
  for(let i=relationships.length-1;i>=0;i--)if(!entities.has(relationships[i].from)||!entities.has(relationships[i].to))relationships.splice(i,1);

  const subtypeWitnesses=new Map<string,Map<string,readonly string[]>>();
  const memberships = ordered.map(row => {
    const ownerId = owners.get(row.sourceId) ?? null;
    const interpretation = meaning.get(row.sourceId)!;
    if(interpretation.objectRole)interpretation.objectRole={...interpretation.objectRole,id:interpretation.meaning};
    const entity = ownerId ? entities.get(ownerId) : undefined;
    if (entity) {
      entity.sourceIds.push(row.sourceId);
      if (interpretation.conflict) entity.classificationConflicts++;
      const component=interpretation.componentType;
      if(interpretation.meaning==='part'&&component?.status==='confirmed'&&component.id&&COMPOSITION_SUBTYPE_COMPONENTS.has(component.id)&&compositionSubtypeHost(entity.category)){
        let witnesses=subtypeWitnesses.get(entity.id);if(!witnesses){witnesses=new Map();subtypeWitnesses.set(entity.id,witnesses);}
        if(!witnesses.has(component.id))witnesses.set(component.id,component.evidence);
      }
    } else if (ownerId) {
      const target = pending.get(ownerId);
      if (!target) throw new Error(`Dangling source owner: ${row.sourceId}`);
      target.sourceIds.push(row.sourceId);
    }
    return { sourceId: row.sourceId, ownerId, interpretation,
      disposition: entity ? 'whole_member' as const : ownerId ? 'pending_whole_member' as const : 'source_only' as const };
  });
  const wholeAliases: EngineeringSnapshot['aliases'] = aliases.filter(a => a.status !== 'confirmed').map(alias => {
    const targets = new Set(alias.candidates.map(sourceId => owners.get(sourceId) ?? null));
    const ownerId = targets.size === 1 ? [...targets][0] : null;
    return { sourceId: alias.sourceId, ownerId,
      status: ownerId && entities.has(ownerId) ? 'whole_resolved_component_ambiguous' : ownerId && pending.has(ownerId) ? 'pending_bundle_resolved' : 'whole_unresolved',
      componentCandidates: [...alias.candidates] };
  });
  const snapshot: EngineeringSnapshot = {
    recognitionCoverage:{inputSourceIds:ordered.map(r=>r.sourceId),processed:ordered.length,confirmed:0,complete:true},
    scope, evidenceBinding:{scope,sourceRevision:0},rulesVersion: ENGINEERING_RULES_VERSION,
    entities: [...entities.values()].sort((a, b) => compare(a.id, b.id)),
    memberships, pending: [...pending.values()].sort((a, b) => compare(a.id, b.id)),
    relationships: relationships.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))), aliases: wholeAliases, diagnostics,
  };
  for(const entity of snapshot.entities){
    const subtype=compositionSubtype(entity,subtypeWitnesses.get(entity.id));
    if(subtype){Object.assign(entity,subtype);if(entity.unknownReason==='equipment_subtype_evidence_insufficient')delete entity.unknownReason;}
    Object.assign(entity,publishDirectoryClassification(entity));entity.classificationState=entity.category==='U-OBJECT'?'unknown':'identified';
  }
  for(const member of snapshot.memberships){
    Object.assign(member.interpretation,publishDirectoryClassification(member.interpretation));
    if(member.interpretation.categoryStatus==='confirmed')snapshot.recognitionCoverage!.confirmed++;
  }
  assertEngineeringPartition(snapshot, ordered.map(row => row.sourceId));
  return snapshot;
}
