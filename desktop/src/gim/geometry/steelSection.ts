import type { XmlModPrimitive } from './ir.js';

type Member = Extract<XmlModPrimitive, { type: 'BeamChannelLike' | 'ChannelSteel' }>;
const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

/** Millimetres. Model designations without a declared section series are browser estimates. */
export function steelSection(p: Member) {
  const length = p.type === 'ChannelSteel' ? p.l : p.length;
  if (!positive(length)) return null;
  const hBeam = p.type === 'BeamChannelLike' && p.family === 'H';
  const numberTen = !hBeam && /^(?:\[10|C10|10#)$/i.test(p.model.trim());
  const raw = p.type === 'ChannelSteel' ? p : undefined;
  const width = positive(raw?.b) ? raw.b : numberTen ? 48 : hBeam ? 100 : 50;
  const height = positive(raw?.h) ? raw.h : 100;
  const d = raw?.d,
    t = raw?.t;
  const validWeb = positive(d) && d < width;
  const validFlange = positive(t) && 2 * t < height;
  const web = validWeb ? d : Math.min(numberTen ? 5.3 : 5, width / 4);
  const flange = validFlange ? t : Math.min(numberTen ? 8.5 : 8, height / 4);
  return {
    length,
    width,
    height,
    web,
    flange,
    hBeam,
    estimated: !(positive(raw?.b) && positive(raw?.h) && validWeb && validFlange),
  };
}

export function steelSectionContour(
  s: NonNullable<ReturnType<typeof steelSection>>,
): [number, number][] {
  const x = s.width / 2,
    z = s.height / 2,
    inside = z - s.flange,
    web = s.web;
  return s.hBeam
    ? [
        [-x, -z],
        [x, -z],
        [x, -inside],
        [web / 2, -inside],
        [web / 2, inside],
        [x, inside],
        [x, z],
        [-x, z],
        [-x, inside],
        [-web / 2, inside],
        [-web / 2, -inside],
        [-x, -inside],
      ]
    : [
        [-x, -z],
        [x, -z],
        [x, -inside],
        [-x + web, -inside],
        [-x + web, inside],
        [x, inside],
        [x, z],
        [-x, z],
      ];
}
