import { ENGINEERING_RULES_VERSION, explicitMain, interpretObject, isNumberedDesignation, categoryFromName } from './classify.js';
import { assertEngineeringPartition } from './validate.js';
import { categoryDefinition } from './catalogLabels.js';
import { classificationDetails } from './classificationDetails.js';
import type { EngineeringEntity, EngineeringSnapshot, ObjectEvidence, PendingWhole, SourceAlias } from './types.js';

/** Lossless package-local identity. No class version, tree parent or traversal counter. */
const identity = (scope: string, kind: string, seed: string) => `${kind}:${JSON.stringify([scope, seed])}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const transformer = (category: string | undefined) => !!category && ['E01','E-T','E03'].includes(category);
const reserve = (row: ObjectEvidence) => row.designations.some(p=>/备用|预留/.test(p.value));
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
        ||['E04','E10'].includes(category)&&!/(?:成套|装置|组)/.test(name)&&!sourceIds.some(id=>raw.get(id)?.identityCodes.length)?'candidate':'confirmed',
      grain:categoryDefinition(category)?.grain as 'item'|'segment'|undefined,
      ...classificationDetails(category,name),
    });
    const interpreted=sourceIds.map(id=>meaning.get(id)!).find(m=>m.category===category);
    if(interpreted)Object.assign(entities.get(id)!,{subtype:interpreted.subtype,subtypeLabel:interpreted.subtypeLabel,unknownReason:interpreted.unknownReason});
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

  // Peer fragments require declared engineering identity and a compatible set
  // signature. Common source parent, template, location and name alone do not merge.
  interface PeerGroup { category: string; code: string; name: string; signature: string; members: ObjectEvidence[] }
  const groups = new Map<string, PeerGroup>();
  const signatures = new Map<string, Set<string>>();
  const roots = new Map<string, ObjectEvidence[]>();
  for (const row of ordered) {
    const m = meaning.get(row.sourceId)!;
    const code = row.identityCodes[0]?.value;
    const name = row.designations[0]?.value;
    if (!code || !name) continue;
    const rootKey = JSON.stringify([code, name, row.name]);
    const rootMembers = roots.get(rootKey) ?? [];
    rootMembers.push(row); roots.set(rootKey, rootMembers);
    if (m.meaning !== 'fragment' || m.independent) continue;
    const base = JSON.stringify([m.assemblyCategory, code, name]);
    const key = JSON.stringify([m.assemblyCategory, code, name, m.assemblySignature]);
    const group = groups.get(key) ?? { category: m.assemblyCategory, code, name, signature: m.assemblySignature, members: [] };
    group.members.push(row); groups.set(key, group);
    const values = signatures.get(base) ?? new Set<string>();
    values.add(m.assemblySignature); signatures.set(base, values);
  }
  for (const [, group] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const members = [...new Set([...group.members, ...roots.get(JSON.stringify([group.code, group.name, group.signature])) ?? []])];
    if (members.length < 2) continue;
    const parents=new Set(members.map(row=>row.assemblyParentId).filter(id=>id&&meaning.get(id)?.meaning!=='container'));
    if (signatures.get(JSON.stringify([group.category, group.code, group.name]))!.size !== 1 || parents.size>1
      || members.some(row=>new Set(row.identityCodes.map(p=>p.value)).size>1||new Set(row.designations.map(p=>p.value)).size>1)) {
      diagnostics.push({ kind: 'whole_identity_conflict', identity: group.code, name: group.name });
      for(const row of members)if(!owners.has(row.sourceId))bundle(`conflict:${row.sourceId}`,'assembly_identity_conflict',[row.sourceId]);
      continue;
    }
    const seed = `set:${JSON.stringify([group.code, group.name])}`;
    if (!isNumberedDesignation(group.name)) {
      bundle(seed, 'unnumbered_set_identity_requires_confirmation', members.map(row => row.sourceId));
      diagnostics.push({ kind: 'unnumbered_assembly_identity', identity: group.code, name: group.name }); continue;
    }
    const entity = addEntity(seed, group.category, group.name, 'engineering_code+designation+assembly_signature', members.map(row => row.sourceId), 'set');
    entity.compositionState = 'declared_identity_physical_completeness_unverified';
  }

  const banks = new Map<string, ObjectEvidence[]>();
  for (const row of ordered) {
    const m = meaning.get(row.sourceId)!;
    const number = explicitMain(row);
    if (owners.has(row.sourceId) || m.meaning !== 'object' || m.category !== 'E01' || !number || !row.phases.some(p => p.value === '单相')) continue;
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
    if(members.length>3||codes.size>1||parents.size>1||new Set(phases).size!==phases.length){
      diagnostics.push({kind:'whole_identity_conflict',identity:number,name:'主变成组证据冲突'});
      members.forEach(row=>bundle(`main-conflict:${row.sourceId}`,'transformer_bank_identity_conflict',[row.sourceId]));continue;
    }
    const entity = addEntity(`main-bank:${number}`, 'E01', wholeName(members[0],'E01'), 'explicit_main_designation+single_phase_bodies', members.map(row => row.sourceId), 'transformer_bank');
    entity.phaseBodyCount = members.length;
    entity.compositionState = 'phase_completeness_unverified';
  }

  const visiting = new Set<string>();
  function assign(sourceId: string): string | null {
    if (owners.has(sourceId)) return owners.get(sourceId)!;
    if (visiting.has(sourceId)) throw new Error(`Source assembly cycle: ${sourceId}`);
    visiting.add(sourceId);
    const row = raw.get(sourceId)!;
    const m = meaning.get(sourceId)!;
    const above = row.assemblyParentId && raw.has(row.assemblyParentId) ? assign(row.assemblyParentId) : null;
    const aboveCategory = above ? entities.get(above)?.category : undefined;
    const associate = (proof: string, evidence: string) => {
      const entity = addEntity(sourceId, m.category, wholeName(row,m.category), proof, [sourceId]);
      if (above) relationships.push({ from: entity.id, to: above, kind: 'associated_with', evidence });
    };
    if (m.basis === 'attribute_conflict') {
      bundle(sourceId,'object_attributes_conflict',[sourceId]);
    } else if (m.meaning === 'neutral_set') {
      // Resolve external attachments after all bodies and their identities exist.
      if (transformer(aboveCategory)) owners.set(sourceId, above);
      else bundle(sourceId, 'neutral_set_main_unresolved', [sourceId]);
    } else if (m.category==='E16.terminal_box' && above && (
      transformer(aboveCategory)||pending.get(above)?.reason==='neutral_set_main_unresolved'
      ||aboveCategory?.startsWith('E')&&aboveCategory!=='E18'&&!row.objectRoles?.some(p=>p.value==='independent'))) {
      m.meaning='part';m.independent=false;m.basis=transformer(aboveCategory)||pending.get(above)?.reason==='neutral_set_main_unresolved'?'transformer_terminal_composition':'equipment_terminal_composition';
      owners.set(sourceId,above);
    } else if (m.category==='E17'&&m.subtype==='机构箱'&&above&&aboveCategory?.startsWith('E')&&aboveCategory!=='E18'
      &&!row.objectRoles?.some(p=>p.value==='independent')) {
      m.meaning='part';m.independent=false;m.basis='equipment_actuator_composition';
      owners.set(sourceId,above);
    } else if (['source_only', 'container', 'detail'].includes(m.meaning)) {
      owners.set(sourceId, above);
    } else if (m.meaning === 'part') {
      if (above) owners.set(sourceId, above);
      else bundle(sourceId, 'component_whole_unresolved', [sourceId]);
    } else if (m.meaning === 'fragment') {
      if (above && (aboveCategory === m.assemblyCategory || pending.has(above))) owners.set(sourceId, above);
      else bundle(sourceId, 'peer_fragment_engineering_identity_insufficient', [sourceId]);
    } else if (aboveCategory && (aboveCategory===m.category||aboveCategory.startsWith('E16')&&m.category.startsWith('E16'))
      && /端子板|端子排|柜体|门扇|门框/.test(row.name) && !row.objectRoles?.some(p=>p.value==='independent')) {
      m.meaning='part';m.independent=false;m.basis='same_category_assembly_component';owners.set(sourceId,above);
    } else if (m.independent) {
      associate('independent_function_identity', 'source_assembly_only');
    } else if (aboveCategory === 'U-OBJECT' && m.category !== 'U-OBJECT') {
      associate('object_identity_parent_boundary_unknown', 'unknown_parent_does_not_define_whole_boundary');
    } else if (aboveCategory) {
      const separateInstallation = ['C-B1','C-B2','C-B3','C-B4'].includes(m.category) && aboveCategory.startsWith('E');
      const cabinetInCabin = m.category === 'E09' && aboveCategory === 'E18';
      const distinctCivil=aboveCategory.startsWith('C')&&(m.category.startsWith('C')&&m.category!==aboveCategory||m.category.startsWith('E'));
      if (separateInstallation || cabinetInCabin || distinctCivil) associate('independent_installation_object', 'source_assembly_only');
      else owners.set(sourceId, above);
    } else if (above && pending.has(above)) {
      owners.set(sourceId, above);
    } else {
      addEntity(sourceId, m.category, wholeName(row,m.category), m.category === 'U-OBJECT' ? 'outward_object_boundary_unconfirmed' : 'object_identity', [sourceId]);
    }
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

  const memberships = ordered.map(row => {
    const ownerId = owners.get(row.sourceId) ?? null;
    const interpretation = meaning.get(row.sourceId)!;
    const entity = ownerId ? entities.get(ownerId) : undefined;
    if (entity) {
      entity.sourceIds.push(row.sourceId);
      if (interpretation.conflict) entity.classificationConflicts++;
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
    scope, rulesVersion: ENGINEERING_RULES_VERSION,
    entities: [...entities.values()].sort((a, b) => compare(a.id, b.id)),
    memberships, pending: [...pending.values()].sort((a, b) => compare(a.id, b.id)),
    relationships: relationships.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))), aliases: wholeAliases, diagnostics,
  };
  assertEngineeringPartition(snapshot, ordered.map(row => row.sourceId));
  return snapshot;
}
