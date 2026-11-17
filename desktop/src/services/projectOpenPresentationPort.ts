export type ProjectInputKind = 'gim' | 'ifc';
export interface ProjectOpenPresentation {
  chooseGim(): Promise<File | null>;
  chooseIfc(): Promise<File[]>;
  setBusy(kind: ProjectInputKind, busy: boolean): void;
  resetInput(kind: ProjectInputKind): void;
}
let port: ProjectOpenPresentation;
export function bindProjectOpenPresentation(value: ProjectOpenPresentation): void {
  port = value;
}
export function projectOpenPresentation(): ProjectOpenPresentation {
  if (!port) throw Error('Project open presentation missing');
  return port;
}
