/** 工程异步任务携带的不可变身份快照。 */
export interface ProjectLoadSession {
  generation: number;
  projectId: number | null;
  sourceSha256: string | null;
  /** 创建快照时的几何批次 token；可在同一工程内递增。 */
  geometryToken: number;
}

export interface SessionOwner {
  projectGeneration: number; currentProjectId: number | null; currentSourceSha256: string | null; geometryLoadToken: number;
}
export function isCurrentGeometry(owner: SessionOwner, session: ProjectLoadSession): boolean {
  return owner.projectGeneration === session.generation && owner.currentProjectId === session.projectId
    && owner.currentSourceSha256 === session.sourceSha256 && owner.geometryLoadToken === session.geometryToken;
}

export function createIfcRuntimeModelId(
  sourceIdentity: string,
  logicalModelId: string,
  generation?: number,
): string {
  const generationSalt = generation == null ? '' : `\u0000generation:${generation}`;
  const input = `${sourceIdentity.trim().toLowerCase()}\u0000${logicalModelId.trim().toLowerCase()}${generationSalt}`;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `ifc_rt_${hash.toString(16).padStart(16, '0')}`;
}
