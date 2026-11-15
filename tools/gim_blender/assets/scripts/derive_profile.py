#!/usr/bin/env python3
"""Derive a walkthrough profile from the extracted IFC/GIM metadata.

The pipeline intentionally separates *geometry conversion* from *site layout*.
Geometry is generic; the entrance, gate, spawn, interior hints and landmarks
are site-specific.  This script provides heuristic defaults and accepts a
manual profile override for production use.

Inputs (all under GIM_BLENDER_BUILD):
  ifc_scene.json
  gim_placements.json
  gim_scene.json
  nav.json

Output:
  profile.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict
from site_steps import entrance_steps, door_access_steps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_BUILD = os.path.join(ROOT, 'build')


def load(path: str):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def slugify(text: str) -> str:
    text = re.sub(r'\.gim$', '', text, flags=re.I)
    text = re.sub(r'[^A-Za-z0-9._-]+', '-', text).strip('-._')
    return text.lower() or 'gim-world'


def bbox_center(b):
    return [(b[0] + b[3]) / 2.0, (b[1] + b[4]) / 2.0, (b[2] + b[5]) / 2.0]


def bbox_size(b):
    return [b[3] - b[0], b[4] - b[1], b[5] - b[2]]


def overlaps_or_near(a, b, margin=1.0):
    return not (a[3] + margin < b[0] or b[3] + margin < a[0]
                or a[4] + margin < b[1] or b[4] + margin < a[1])


def union_rects(rects):
    return [min(r[0] for r in rects), min(r[1] for r in rects),
            max(r[2] for r in rects), max(r[3] for r in rects)]


def choose_gate(ifc):
    gate = ifc.get('gate')
    if not gate or not gate.get('bbox'):
        # Some exporters use IfcDoor (two adjacent leaves) instead of a proxy.
        candidates=[d for d in ifc.get('doors',[]) if os.environ.get('GIM_BLENDER_GATE_NAME','平开大门') in d.get('name','')]
        if candidates:
            b=[min(d['bbox'][i] for d in candidates) for i in range(3)]+[max(d['bbox'][i+3] for d in candidates) for i in range(3)]
            axis='x' if b[3]-b[0]<=b[4]-b[1] else 'y'
            if max(b[3]-b[0],b[4]-b[1])>30: raise SystemExit('multiple remote station gates require a manual profile')
            center=bbox_center(b);bounds=ifc['bounds'];site=[(bounds['x0']+bounds['x1'])/2,(bounds['y0']+bounds['y1'])/2]
            leaves=[]
            for i,side in enumerate((-1,1)):
                hinge=[b[0]+.025,b[1]+.1 if side<0 else b[4]-.1,b[2]] if axis=='x' else [b[0]+.1 if side<0 else b[3]-.1,b[1]+.025,b[2]]
                closed=[0,-side] if axis=='x' else [-side,0]
                inward=[1 if site[0]>=center[0] else -1,0] if axis=='x' else [0,1 if site[1]>=center[1] else -1]
                angle=math.atan2(closed[0]*inward[1]-closed[1]*inward[0],closed[0]*inward[0]+closed[1]*inward[1])
                leaves.append({'name':'GATE_L' if i==0 else 'GATE_R','hinge':hinge,'closedDir':closed,'angle':angle,'side':side,
                    'kind':'swing','width':max(b[3]-b[0],b[4]-b[1])/2-.1,'height':b[5]-b[2],'thickness':.05})
            gate={'id':'GATE','name':'整站大门','bbox':b,'leaves':leaves,'sourceIds':[d.get('sourceId',d['id']) for d in candidates]}
            ifc['gate']=gate
            removed={d['id'] for d in candidates};ifc['doors']=[d for d in ifc['doors'] if d['id'] not in removed]
            ifc['counts']['doors']=len(ifc['doors'])
    if not gate or not gate.get('bbox'):
        return None
    b = gate['bbox']
    c = bbox_center(b)
    size = bbox_size(b)
    # The gate is a thin vertical panel: its plan-thin axis is the entry axis.
    axis = 'x' if size[0] <= size[1] else 'y'
    return {
        'id': 'GATE',
        'name': gate.get('name', '大门'),
        'bbox': b,
        'center': c,
        'axis': axis,
        'leaves': gate.get('leaves', []),
        'gate': True,
    }


def choose_main_door(ifc, gate_center, site_center, manual_id=None):
    doors = ifc.get('doors', [])
    if manual_id is not None:
        for d in doors:
            if str(d.get('id')) == str(manual_id):
                return d
        raise SystemExit(f'manual main entrance {manual_id} not found in ifc_scene.json')

    def gate_distance(d):
        c = d.get('center') or bbox_center(d['bbox'])
        return math.hypot(c[0] - gate_center[0], c[1] - gate_center[1]) if gate_center else 1e9

    usable = [d for d in doors if d.get('sourceType') != 'IfcBuildingElementProxy' and d.get('width', 0) >= 1.0 and d.get('height', 0) >= 1.8]
    buildings=[d for d in usable if re.search(r'建筑|配电楼|building',d.get('sourceFile',''),re.I) and not re.search(r'警卫|警传|门卫',d.get('sourceFile',''))]
    usable=buildings or usable
    # Prefer raised entrance doors (steps), then the one facing the gate.
    raised = [d for d in usable if 0.4 <= float(d.get('bottom', 0.0)) <= 1.5]
    pool = raised or usable
    if not pool:
        return None
    pool.sort(key=lambda d: (gate_distance(d), -(d.get('width', 0) * d.get('height', 0))))
    return pool[0]


def outward_axis(door, site_center):
    axis = door.get('axis') or 'x'
    c = door.get('center') or bbox_center(door['bbox'])
    if axis == 'x':
        return [1 if c[0] >= site_center[0] else -1, 0]
    return [0, 1 if c[1] >= site_center[1] else -1]


def make_start(gate, main_door, site_center):
    if gate:
        b = gate['bbox']
        c = gate.get('passagePosition') or gate['center']
        size = bbox_size(b)
        axis = 'x' if size[0] <= size[1] else 'y'
        if axis == 'x':
            sign = 1 if c[0] >= site_center[0] else -1
        else:
            sign = 1 if c[1] >= site_center[1] else -1
        outward = [sign, 0] if axis == 'x' else [0, sign]
        # Stand outside the gate, facing the compound.
        pos = [c[0] + outward[0] * 9.0, c[1] + outward[1] * 9.0]
        # Snap to a half-metre grid so small exporter/gate-matrix differences
        # do not produce a visibly different spawn point.
        pos = [round(pos[0] * 2.0) / 2.0, round(pos[1] * 2.0) / 2.0]
        inward = [-outward[0], -outward[1]]
        yaw = math.degrees(math.atan2(-inward[0], inward[1]))
        floor = float(b[2]) if len(b) >= 6 else -0.28
        return {'pos': [round(pos[0], 3), round(pos[1], 3)], 'floor': round(floor, 3),
                'yawDeg': round(yaw, 3)}, outward

    if main_door:
        c = main_door.get('center') or bbox_center(main_door['bbox'])
        out = outward_axis(main_door, site_center)
        pos = [c[0] + out[0] * 4.0, c[1] + out[1] * 4.0]
        yaw = math.degrees(math.atan2(out[0], -out[1]))
        return {'pos': [round(pos[0], 3), round(pos[1], 3)],
                'floor': round(float(main_door.get('bottom', 0.0)), 3),
                'yawDeg': round(yaw, 3)}, out
    return {'pos': [0.0, 0.0], 'floor': -0.28, 'yawDeg': 0.0}, [1, 0]


def normalize_area_label(label: str) -> str:
    label = (label or '').strip()
    if '警卫' in label or '门卫' in label:
        return '警卫室'
    if '主控' in label or '室内' in label:
        return '主控楼'
    return label or '建筑'


def start_from_placements(placements):
    xs, ys = [], []
    for p in placements:
        m = p.get('matrix') or []
        if len(m) == 16:
            xs.append(m[12] / 1000.0)
            ys.append(m[13] / 1000.0)
    if not xs or not ys:
        return {'pos': [0.0, 0.0], 'floor': 0.0, 'yawDeg': 0.0}
    maxx = max(xs); cy = (min(ys) + max(ys)) / 2.0
    return {'pos': [round(maxx + 9.0, 1), round(cy, 1)], 'floor': 0.0, 'yawDeg': 90.0}


def derive_interiors(ifc, main_door, main_outward):
    areas = []
    for i, a in enumerate(ifc.get('interiorAreas', [])):
        rect = a.get('rect')
        if not rect or len(rect) != 4:
            continue
        w = abs(rect[2] - rect[0]); h = abs(rect[3] - rect[1])
        if w * h < 4.0:
            continue
        areas.append({
            'id': f"area_{i}",
            'label': a.get('label') or '室内',
            'rect': [round(v, 3) for v in rect],
            'floor': round(float(a.get('floor', 0.0)), 3),
            'sourceId': a.get('sourceId'),
        })
    if main_door:
        c = main_door.get('center') or bbox_center(main_door['bbox'])
        axis = main_door.get('axis') or 'x'
        out = main_door.get('outward') or ([1, 0] if axis == 'x' else [0, 1])
        # Put the mission's entrance zone *inside* the threshold, not around
        # the outside approach.  This keeps step 2 alive until the player has
        # actually crossed the door.
        if axis == 'x':
            x_in = c[0] - out[0] * 8.0
            x_edge = c[0] - out[0] * 0.1
            rect = [min(x_in, x_edge), c[1] - 6.0, max(x_in, x_edge), c[1] + 6.0]
        else:
            y_in = c[1] - out[1] * 8.0
            y_edge = c[1] - out[1] * 0.1
            rect = [c[0] - 6.0, min(y_in, y_edge), c[0] + 6.0, max(y_in, y_edge)]
        areas.insert(0, {
            'id': 'entrance_wing',
            'label': '入口区域',
            'rect': [round(v, 3) for v in rect],
            'floor': round(float(main_door.get('bottom', 0.0)), 3),
        })
    return areas


def derive_buildings(interiors):
    groups = defaultdict(list)
    for a in interiors:
        if a['id'] == 'entrance_wing':
            continue
        groups[normalize_area_label(a['label'])].append(a['rect'])
    out = []
    for label, rects in groups.items():
        rect = union_rects(rects)
        if rect[2] - rect[0] >= 2.0 and rect[3] - rect[1] >= 2.0:
            out.append({'label': label, 'rect': [round(v, 3) for v in rect]})
    return out


def derive_landmarks(ifc, gate, main_door, placements, site_center, nav_bounds):
    landmarks = []
    if gate:
        c = gate['center']
        landmarks.append({'id': 'gate', 'label': '大门', 'pos': [round(c[0], 3), round(c[1], 3)], 'kind': 'gate'})
    if main_door:
        c = main_door.get('center') or bbox_center(main_door['bbox'])
        landmarks.append({'id': 'main_entrance', 'label': '主控楼入口',
                          'pos': [round(c[0], 3), round(c[1], 3)], 'kind': 'entrance'})

    transformers = []
    yard = []
    for p in placements:
        label = p.get('label') or ''
        m = p.get('matrix') or []
        if len(m) != 16:
            continue
        pos = [m[12] / 1000.0, m[13] / 1000.0]
        if ('主变本体' in label or ('变压器' in label and '保护' not in label
                                    and '测控' not in label and '中性点' not in label
                                    and '进线' not in label and '消防' not in label
                                    and '录波' not in label and '电能表' not in label)):
            transformers.append((pos, label))
        if '220kV' in label and '主变' not in label:
            yard.append(pos)
    seen = set()
    for pos, label in transformers:
        name = '主变'
        mm = re.search(r'(\d+)号.*?主变', label)
        if mm:
            name = f'{mm.group(1)}号主变'
        key = (round(pos[0], 1), round(pos[1], 1))
        if key in seen:
            continue
        seen.add(key)
        landmarks.append({'id': f'transformer_{len(seen)}', 'label': name,
                          'pos': [round(pos[0], 3), round(pos[1], 3)], 'kind': 'equipment'})
        if len(seen) >= 3:
            break
    if yard:
        cx = sum(p[0] for p in yard) / len(yard)
        cy = sum(p[1] for p in yard) / len(yard)
        landmarks.append({'id': 'yard_220', 'label': '220kV 设备区',
                          'pos': [round(cx, 3), round(cy, 3)], 'kind': 'yard'})

    # Keep landmarks inside a readable map range; out-of-bounds entries are
    # still useful as world sprites, so only filter impossible coordinates.
    b = nav_bounds
    cleaned = []
    for l in landmarks:
        x, y = l['pos']
        if b and (x < b['x0'] - 40 or x > b['x1'] + 40 or y < b['y0'] - 40 or y > b['y1'] + 40):
            continue
        cleaned.append(l)
    return cleaned


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--build', default=os.environ.get('GIM_BLENDER_BUILD', DEFAULT_BUILD))
    ap.add_argument('--source', default=os.environ.get('GIM_BLENDER_SOURCE_NAME', 'input.gim'))
    ap.add_argument('--slug', default='')
    ap.add_argument('--title', default='')
    ap.add_argument('--main-entrance', default=os.environ.get('GIM_BLENDER_MAIN_ENTRANCE_ID', ''))
    ap.add_argument('--profile', default='', help='manual profile JSON to merge/override')
    ap.add_argument('--out', default='')
    args = ap.parse_args()

    build = os.path.abspath(args.build)
    ifc = load(os.path.join(build, 'ifc_scene.json'))
    nav = load(os.path.join(build, 'nav.json'))
    gim = load(os.path.join(build, 'gim_scene.json'))
    placements_path = os.path.join(build, 'gim_placements.json')
    placements = load(placements_path).get('placements', []) if os.path.exists(placements_path) else []
    if ifc.get('coordinateSystem') != 'source-z-up-metres-v2' or nav.get('coordinateSystem') != 'source-z-up-metres-v2':
        raise SystemExit('IFC/nav artifacts are not in source-z-up-metres-v2; regenerate them first')

    manual = load(args.profile) if args.profile else None
    if manual:
        # A manual profile is authoritative; still fill missing derived fields.
        profile = dict(manual)
        profile.setdefault('source', args.source)
        profile.setdefault('slug', args.slug or slugify(args.source))
        profile.setdefault('title', args.title or '变电站 · 第一人称漫游')
        profile.setdefault('coordinateSystem', 'source-z-up-metres-v2')
        profile.setdefault('home', make_start(profile.get('gate'), profile.get('mainEntrance'),
            [(nav['bounds']['x0']+nav['bounds']['x1'])/2,(nav['bounds']['y0']+nav['bounds']['y1'])/2])[0])
        nav['entrySteps'] = entrance_steps(profile.get('mainEntrance'))
        with open(os.path.join(build, 'nav.json'), 'w', encoding='utf-8') as f: json.dump(nav,f,separators=(',',':'))
        with open(os.path.join(build, 'profile.json'), 'w', encoding='utf-8') as f:
            json.dump(profile, f, ensure_ascii=False, indent=2)
        print('wrote manual profile', len(json.dumps(profile)))
        return

    bounds = nav.get('bounds') or ifc.get('bounds')
    site_center = [(bounds['x0'] + bounds['x1']) / 2.0, (bounds['y0'] + bounds['y1']) / 2.0]
    gate = choose_gate(ifc)
    with open(os.path.join(build,'ifc_scene.json'),'w',encoding='utf-8') as f: json.dump(ifc,f,ensure_ascii=False,separators=(',',':'))
    if gate:
        gb = gate['bbox']
        gsz = bbox_size(gb)
        gaxis = 'x' if gsz[0] <= gsz[1] else 'y'
        if gaxis == 'x':
            gsign = 1 if gate['center'][0] >= site_center[0] else -1
            gate['outward'] = [gsign, 0]
        else:
            gsign = 1 if gate['center'][1] >= site_center[1] else -1
            gate['outward'] = [0, gsign]
        # Choose a clear lane through the gate. A separately represented wicket
        # door may occupy the midpoint; it keeps its own source identity/action.
        tangent = 1 if gaxis == 'x' else 0
        for fraction in (.5,.25,.75):
            lane=gate['center'][:2]
            lane[tangent]=gb[tangent]+(gb[tangent+3]-gb[tangent])*fraction
            obstructed=False
            for d in ifc.get('doors',[]):
                b=d['bbox']
                if b[2]>gb[2]+1.7 or b[5]<gb[2]+.06:continue
                if b[0]-.3<=lane[0]<=b[3]+.3 and b[1]-.3<=lane[1]<=b[4]+.3:obstructed=True;break
            if not obstructed:
                gate['passagePosition']=lane
                break
    access_steps = door_access_steps(nav, ifc.get('doors', []))
    main_door = choose_main_door(ifc, gate['center'] if gate else None, site_center,
                                 args.main_entrance or None)
    if main_door is None and gate is None:
        out = [1, 0]
        start = start_from_placements(placements)
        start_out = out
    else:
        out = outward_axis(main_door, site_center) if main_door else gate['outward']
        if main_door:
            main_door = dict(main_door)
            main_door['outward'] = out
        start, start_out = make_start(gate, main_door, site_center)
    if gate is None and ifc.get('siteAreas'):
        datum = max(ifc['siteAreas'], key=lambda a: (a['rect'][2]-a['rect'][0])*(a['rect'][3]-a['rect'][1]))
        start['floor'] = datum['top']
    interiors = derive_interiors(ifc, main_door, out)
    buildings = derive_buildings(interiors)
    landmarks = derive_landmarks(ifc, gate, main_door, placements, site_center, bounds)

    slug = args.slug or slugify(args.source)
    title = args.title or '变电站 · 第一人称漫游'
    warnings = []
    if gate is None:
        warnings.append('no gate record; spawn uses the GIM placement edge')
    if main_door is None:
        warnings.append('no authoritative main entrance; level runs in free-roam mode' if ifc.get('doors') else 'no IFC door track; level runs in free-roam mode')
    if not ifc.get('interiorAreas'):
        warnings.append('no IFC interior areas; indoor zone hints are limited')
    if main_door is not None and main_door.get('bottom', 0) > 1.5:
        warnings.append('main entrance is high above ground; add a manual profile for steps')

    profile = {
        'version': 1,
        'source': args.source,
        'slug': slug,
        'title': title,
        'coordinateSystem': 'source-z-up-metres-v2',
        'gate': gate,
        'mainEntrance': main_door,
        'freeRoam': main_door is None,
        'start': start,
        'home': start,
        'groundZ': start['floor'] - 0.05,
        'terrainRect': union_rects([a['rect'] for a in ifc.get('siteAreas',[])]) if ifc.get('siteAreas') else None,
        'accessSteps': access_steps,
        'startOutward': start_out,
        'interiors': interiors,
        'buildings': buildings,
        'landmarks': landmarks,
        'map': {
            'bounds': bounds,
            'gate': gate['center'][:2] if gate else None,
            'mainEntrance': ((main_door.get('center') or bbox_center(main_door['bbox']))[:2]
                             if main_door else None),
        },
        'counts': {
            'doors': len(ifc.get('doors', [])),
            'ifcTriangles': ifc.get('counts', {}).get('triangles', 0),
            'gimTriangles': gim.get('stats', {}).get('tris', 0),
            'gimRoots': gim.get('placements', 0),
            'gimDevInstances': gim.get('dev_instances', 0),
            'gimSolids': gim.get('solids', 0),
        },
        'warnings': warnings,
    }
    out_path = args.out or os.path.join(build, 'profile.json')
    nav['entrySteps'] = access_steps
    main_source = (main_door or {}).get('sourceId', (main_door or {}).get('id'))
    if main_door and not any(s.get('sourceDoorId') == main_source for s in access_steps):
        nav['entrySteps'] += entrance_steps(main_door)
    nav['worldGround']={'z':profile['groundZ'],'excludedRect':profile.get('terrainRect')}
    if gate:
        b=gate['bbox'];out=gate['outward'];a=gate['center'];home=start['pos']
        rect=[min(b[0],home[0]-.5),b[1],max(b[3],home[0]+.5),b[4]] if gate['axis']=='x' else [b[0],min(b[1],home[1]-.5),b[3],max(b[4],home[1]+.5)]
        profile['entryApproach']={'rect':rect,'top':gate['bbox'][2]}
        nav['entrySteps'].append(profile['entryApproach'])
    with open(os.path.join(build,'ifc_scene.json'),'w',encoding='utf-8') as f: json.dump(ifc,f,ensure_ascii=False,separators=(',',':'))
    with open(os.path.join(build,'nav.json'),'w',encoding='utf-8') as f: json.dump(nav,f,separators=(',',':'))
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(profile, f, ensure_ascii=False, indent=2)
    print(f'wrote {out_path}')
    print(json.dumps({
        'source': args.source,
        'gate': gate['center'][:2] if gate else None,
        'mainEntrance': main_door.get('id') if main_door else None,
        'start': start,
        'interiors': len(interiors),
        'buildings': len(buildings),
        'landmarks': len(landmarks),
        'warnings': warnings,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
