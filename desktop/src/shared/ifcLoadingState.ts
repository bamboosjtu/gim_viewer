/** Session-owned IFC tail status; no semantic or geometry completion is inferred. */
export class IfcLoadingState {
  pending = false;
  skippedLargeIfc: string[] = [];

  reset(): void {
    this.pending = false;
    this.skippedLargeIfc = [];
  }
}
