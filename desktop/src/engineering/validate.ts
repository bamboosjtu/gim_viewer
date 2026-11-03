import type { EngineeringSnapshot } from './types.js';

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const requireShape = (condition: unknown, field: string) => { if (!condition) throw Error(`Engineering snapshot shape is invalid: ${field}`); };

/** Shared invariant for cold builds and future persisted snapshot restoration. */
export function assertEngineeringPartition(snapshot: EngineeringSnapshot, sourceIds: readonly string[]): void {
  requireShape(object(snapshot) && typeof snapshot.scope === 'string' && typeof snapshot.rulesVersion === 'string' &&
    Array.isArray(snapshot.entities) && Array.isArray(snapshot.pending) && Array.isArray(snapshot.memberships) &&
    Array.isArray(snapshot.relationships) && Array.isArray(snapshot.aliases), 'root');
  for (const entity of snapshot.entities) {
    requireShape(object(entity) && typeof entity.id === 'string' && entity.id && typeof entity.name === 'string' && typeof entity.category === 'string' &&
      typeof entity.boundaryEvidence === 'string' && strings(entity.sourceIds) && ['whole', 'set', 'transformer_bank'].includes(entity.kind) &&
      ['identified', 'unknown'].includes(entity.classificationState) && Number.isSafeInteger(entity.classificationConflicts) && entity.classificationConflicts >= 0, 'entity');
  }
  for (const pending of snapshot.pending) requireShape(object(pending) && typeof pending.id === 'string' && pending.id && typeof pending.reason === 'string' && strings(pending.sourceIds), 'pending');
  const sources = new Set(sourceIds);
  if (sources.size !== sourceIds.length || sources.has('')) throw new Error('Source partition input identities are invalid');
  const targets = new Map([...snapshot.entities, ...snapshot.pending].map(target => [target.id, target]));
  if (targets.size !== snapshot.entities.length + snapshot.pending.length) throw new Error('Engineering owner identities overlap');
  const entities = new Set(snapshot.entities.map(entity => entity.id));
  const fromOwners = new Map<string, string>();
  for (const [id, target] of targets) for (const source of target.sourceIds) {
    if (!sources.has(source) || fromOwners.has(source)) throw new Error(`Duplicated or unknown source owner member: ${source}`);
    fromOwners.set(source, id);
  }
  const seen = new Set<string>();
  for (const member of snapshot.memberships) {
    requireShape(object(member) && typeof member.sourceId === 'string' && (member.ownerId === null || typeof member.ownerId === 'string') && object(member.interpretation), 'membership');
    const interpretation = member.interpretation;
    requireShape(typeof interpretation.category === 'string' && typeof interpretation.basis === 'string' && typeof interpretation.conflict === 'string' &&
      typeof interpretation.independent === 'boolean' && typeof interpretation.assemblyCategory === 'string' && typeof interpretation.assemblySignature === 'string' &&
      ['object', 'part', 'fragment', 'neutral_set', 'container', 'detail', 'source_only'].includes(interpretation.meaning) &&
      (interpretation.role === undefined || ['cover', 'sidewall', 'base'].includes(interpretation.role)), 'source interpretation');
    if (!sources.has(member.sourceId) || seen.has(member.sourceId)) throw new Error(`Duplicated or unknown source membership: ${member.sourceId}`);
    seen.add(member.sourceId);
    if ((fromOwners.get(member.sourceId) ?? null) !== member.ownerId) throw new Error(`Source ownership is inconsistent: ${member.sourceId}`);
    const disposition = member.ownerId ? entities.has(member.ownerId) ? 'whole_member' : 'pending_whole_member' : 'source_only';
    if (member.disposition !== disposition) throw new Error(`Source disposition is inconsistent: ${member.sourceId}`);
    if (member.interpretation.independent && (!member.ownerId || !entities.has(member.ownerId))) {
      throw new Error(`Independent object lost its engineering identity: ${member.sourceId}`);
    }
  }
  if (seen.size !== sources.size) throw new Error('Source membership partition is incomplete');
  for (const relation of snapshot.relationships) {
    requireShape(object(relation) && relation.kind === 'associated_with' && typeof relation.from === 'string' && typeof relation.to === 'string' && typeof relation.evidence === 'string', 'relationship');
    if (!entities.has(relation.from) || !targets.has(relation.to)) throw new Error('Engineering relationship target is missing');
  }
  for (const alias of snapshot.aliases) {
    requireShape(object(alias) && typeof alias.sourceId === 'string' && strings(alias.componentCandidates) &&
      (alias.ownerId === null || typeof alias.ownerId === 'string') && ['whole_resolved_component_ambiguous', 'pending_bundle_resolved', 'whole_unresolved'].includes(alias.status), 'alias');
    if (alias.ownerId && !targets.has(alias.ownerId)) throw new Error('Engineering alias target is missing');
  }
}
