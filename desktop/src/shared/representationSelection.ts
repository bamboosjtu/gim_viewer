/** Runtime addresses for rendering. No entity, source graph or projection types. */
export interface RepresentationSelectionScope {
  requestId: number;
  devRoots: ReadonlySet<string>;
  ifc: ReadonlyArray<{ modelId: string; expressId: number; globalId: string }>;
  /** Services own the snapshot/session checks; renderers only test validity. */
  isCurrent(): boolean;
}
