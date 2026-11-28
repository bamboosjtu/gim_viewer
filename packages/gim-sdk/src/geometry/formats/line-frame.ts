import type { Point3 } from "../analysisGeometry.js";
export interface SurveyPoint {
  latitudeDeg: number;
  longitudeDeg: number;
  heightM: number;
}
export interface SurveyFrame {
  origin: SurveyPoint;
  ellipsoid: "WGS84" | "CGCS2000";
}
const radians = Math.PI / 180;
function earth(point: SurveyPoint, e2: number): Point3 {
  const lat = point.latitudeDeg * radians,
    lon = point.longitudeDeg * radians;
  const n = 6378137 / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [
    (n + point.heightM) * Math.cos(lat) * Math.cos(lon),
    (n + point.heightM) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - e2) + point.heightM) * Math.sin(lat),
  ];
}
/** Supply an engineering anchor and heights expressed in the same ellipsoidal datum. Returns east/north/up mm. */
export function localSurveyPoint(
  frame: SurveyFrame,
  point: SurveyPoint,
): Point3 {
  const f = 1 / (frame.ellipsoid === "WGS84" ? 298.257223563 : 298.257222101),
    e2 = f * (2 - f);
  const origin = earth(frame.origin, e2),
    value = earth(point, e2),
    [x, y, z] = value.map((v, i) => v - origin[i]);
  const lat = frame.origin.latitudeDeg * radians,
    lon = frame.origin.longitudeDeg * radians;
  const east = -Math.sin(lon) * x + Math.cos(lon) * y,
    radial = Math.cos(lon) * x + Math.sin(lon) * y;
  return [
    1000 * east,
    1000 * (-Math.sin(lat) * radial + Math.cos(lat) * z),
    1000 * (Math.cos(lat) * radial + Math.sin(lat) * z),
  ];
}
