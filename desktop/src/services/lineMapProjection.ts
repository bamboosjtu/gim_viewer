import {extractLineMapData,isLineMapDataValid} from '../gim/lineMapData.js';
/** Domain extraction and renderability are computed once, outside DOM views. */
export function buildLineMapProjection(...input:Parameters<typeof extractLineMapData>) {
 const mapData=extractLineMapData(...input);
 return {mapData,renderable:isLineMapDataValid(mapData)};
}
