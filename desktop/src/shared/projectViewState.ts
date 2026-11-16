export class ProjectViewState {
  mode:'composition'|'source'|'inventory'='inventory';
  expanded={composition:new Set<string>(),source:new Set<string>(),inventory:new Set<string>()};
  reset():void {
    this.mode='inventory';
    this.expanded={composition:new Set(),source:new Set(),inventory:new Set()};
  }
}
