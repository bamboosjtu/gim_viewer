import type { AppState } from '../../../app/state.js';
import type { GimGraph } from '@gim/powerline-core/gimGraphTypes.js';
import { buildLineAttributeIndex } from './lineAttributeIndex.js';
import { perfBegin, type PerfSession } from '../../../utils/perfTimings.js';
import { buildLineMapProjection } from './lineMapProjection.js';
import {
  buildLineNavigationIndex,
  buildLineNavigationSearchIndex,
} from './lineNavigationProjection.js';

/** Produce the display inputs from one committed source and attribute snapshot. */
export function buildLineProjectProjection(
  state: AppState,
  graph: GimGraph,
  perfSession: PerfSession,
) {
  const attrs = buildLineAttributeIndex(state);
  const endMap = perfBegin('线路地图数据提取', undefined, perfSession);
  const map = buildLineMapProjection(graph, attrs);
  endMap(undefined, {
    towers: map.mapData.stats.towerTotal,
    wires: map.mapData.stats.wireTotal,
    crosses: map.mapData.stats.crossTotal,
  });
  const endNavigation = perfBegin('线路导航索引构建', undefined, perfSession);
  const navigation = graph.root
    ? buildLineNavigationIndex(graph, map.mapData, { projectName: state.projectName, attrs })
    : null;
  endNavigation(
    undefined,
    navigation
      ? {
          nodes: navigation.nodesByKey.size,
          sections: navigation.stats.sectionCount,
          strains: navigation.stats.strainSectionCount,
          spans: navigation.stats.spanCount,
        }
      : { nodes: 0 },
  );
  const searchItems = navigation ? buildLineNavigationSearchIndex(navigation) : [];
  return { graph, map, navigation, searchItems };
}

export type LineProjectProjection = ReturnType<typeof buildLineProjectProjection>;
