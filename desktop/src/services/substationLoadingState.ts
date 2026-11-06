/** Shared loading presentation state; project opening resets it before IFC work. */
let viewerInteractive = false;

export function isSubstationViewerInteractive(): boolean {
  return viewerInteractive;
}

export function setSubstationViewerInteractive(value: boolean): void {
  viewerInteractive = value;
}
