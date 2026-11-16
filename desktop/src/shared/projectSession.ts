/** 工程异步任务携带的不可变身份快照。 */
export interface ProjectSessionIdentity {
  readonly generation: number;
  readonly projectId: number | null;
  readonly sourceSha256: string | null;
  /** 创建快照时的几何批次 token；可在同一工程内递增。 */
  readonly geometryToken: number;
}
declare const projectLoadSession: unique symbol;
/** Only AppState mints this commit capability; Worker DTOs carry identity only. */
export interface ProjectLoadSession extends ProjectSessionIdentity { readonly [projectLoadSession]: true }

export interface SessionOwner {
  projectGeneration: number; currentProjectId: number | null; currentSourceSha256: string | null; geometryLoadToken: number;
}
export function isCurrentProject(owner: Pick<SessionOwner, 'projectGeneration' | 'currentProjectId' | 'currentSourceSha256'>, session: ProjectSessionIdentity): boolean {
  return owner.projectGeneration === session.generation && owner.currentProjectId === session.projectId
    && owner.currentSourceSha256 === session.sourceSha256;
}
export function isCurrentGeometry(owner: SessionOwner, session: ProjectSessionIdentity): boolean {
  return isCurrentProject(owner, session) && owner.geometryLoadToken === session.geometryToken;
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
