import ts from 'typescript';

// Composition roots and remaining session fields. New root fields must name
// their owner here, including how that owner releases the current project.
const ownership = {
  'session identity and release': 'projectSession',
  'source state reset on project close':
    'currentFiles currentIfcEntries currentCbmTree substationSpatialIndex projectName currentProjectType lineCachePersistence currentGimGraph ifcGuidIndex cbmNodeIndex ifcGuidToName substationCapabilities substationEntryPaths substationEntrySizes fileDevRelations deviceToIfcFile currentStdDoc currentSldDoc currentStdSldIndex',
  'owners released or reset on project close':
    'ifc selection properties sourceGeometry ifcLoading engineering viewState deviceRuntimeSlot',
  'substation session resource release':
    'substationFineQueue substationConnectionPreview substationConnectionPorts substationResourceMonitor substationMemoryPressure',
  'geometry release and viewer cleanup':
    'deviceUnknownBounds engineeringGeometryFilter engineeringRepresentationChanged engineeringGeometryEvidenceChanged loadedXmlModGroups loadedStlGroups geometryDiagnosticsByDevPath modRootGroup stlRootGroup projectSourceToViewerMatrix',
  'viewer readiness across project sessions': 'initialized eventsRegistered',
};

export function appStateFieldErrors(text) {
  const ast = ts.createSourceFile('state.ts', text, ts.ScriptTarget.Latest, true);
  const state = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'AppState',
  );
  if (!state) return ['app/state.ts: AppState declaration is missing'];
  const fields = new Set(
    state.members.filter(ts.isPropertyDeclaration).map((node) => node.name.getText(ast)),
  );
  const allowed = new Set(Object.values(ownership).flatMap((names) => names.split(' ')));
  return [
    ...[...fields]
      .filter((name) => !allowed.has(name))
      .map((name) => `app/state.ts: ${name} has no AppState owner and release entry`),
    ...[...allowed]
      .filter((name) => !fields.has(name))
      .map((name) => `app/state.ts: remove stale AppState ownership entry ${name}`),
  ];
}
