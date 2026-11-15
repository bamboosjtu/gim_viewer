"""Build the Blender project and web GLB for substation01.

Run headless:
  blender -b --factory-startup --python research/blender/scripts/build_scene.py

Reads build/ifc_scene.{bin,json}, build/gim_scene.{bin,json}, build/nav.json.
Writes build/substation01.blend, build/substation01.glb and renders/*.png.
"""
from __future__ import annotations

import json
import math
import os
import time
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from site_steps import entrance_steps
ROOT = os.path.dirname(HERE)
BUILD = os.environ.get('GIM_BLENDER_BUILD', os.path.join(ROOT, 'build'))
RENDERS = os.environ.get('GIM_BLENDER_RENDERS', os.path.join(ROOT, 'renders'))
os.makedirs(RENDERS, exist_ok=True)

T0 = time.time()


def log(msg):
    print(f'[build {time.time()-T0:7.1f}s] {msg}', flush=True)


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def load_json(name):
    with open(os.path.join(BUILD, name), encoding='utf-8') as f:
        return json.load(f)


PROFILE_PATH = os.environ.get('GIM_BLENDER_PROFILE', os.path.join(BUILD, 'profile.json'))
if not os.path.exists(PROFILE_PATH):
    raise RuntimeError('Site profile missing: run derive_profile.py before Blender')
PROFILE = json.load(open(PROFILE_PATH, encoding='utf-8'))
if PROFILE.get('coordinateSystem') != 'source-z-up-metres-v2':
    raise RuntimeError('Site profile has an incompatible coordinate frame')
NAV = load_json('nav.json') if os.path.exists(os.path.join(BUILD, 'nav.json')) else None
SLUG = (PROFILE or {}).get('slug') or 'substation01'
SOURCE_NAME = (PROFILE or {}).get('source') or 'substation01.gim'


def profile_or(default, *keys):
    cur = PROFILE or {}
    for key in keys:
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur if cur is not None else default


def site_bounds():
    if NAV and NAV.get('bounds'):
        b = NAV['bounds']
        return [float(b['x0']), float(b['y0']), float(b['x1']), float(b['y1'])]
    return [-80.0, -140.0, 300.0, 160.0]


def site_center():
    b = site_bounds()
    return [(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0]


MATS = {}


def material(name, rgba, metallic=0.0, roughness=0.7, double_sided=True):
    key = (name, tuple(rgba), metallic, roughness, double_sided)
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    r, g, b, a = rgba
    lin = (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), 1.0)
    bsdf.inputs['Base Color'].default_value = lin
    bsdf.inputs['Metallic'].default_value = float(metallic)
    bsdf.inputs['Roughness'].default_value = float(roughness)
    if a < 0.999:
        bsdf.inputs['Alpha'].default_value = max(0.02, float(a))
        try:
            m.blend_method = 'BLEND'
        except Exception:
            pass
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
    m.use_backface_culling = not double_sided
    m.diffuse_color = (lin[0], lin[1], lin[2], a)
    MATS[key] = m
    return m


GROUND_TEX_MAT = None


def ground_material():
    global GROUND_TEX_MAT
    if GROUND_TEX_MAT:
        return GROUND_TEX_MAT
    m = bpy.data.materials.new('Ground_Dirt')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (0.12, 0.11, 0.075, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.95
    GROUND_TEX_MAT = m
    return m


def asphalt_material():
    return material('Asphalt', (58, 61, 64, 1.0), 0.0, 0.92)


def concrete_material():
    return material('Concrete', (145, 145, 140, 1.0), 0.0, 0.9)


def steel_material():
    return material('Steel_Dark', (60, 74, 66, 1.0), 0.55, 0.42)


def wood_material():
    return material('Door_Wood', (92, 55, 30, 1.0), 0.0, 0.55)


def door_metal_material():
    return material('Door_Metal', (118, 124, 128, 1.0), 0.55, 0.45)


def door_paint_material():
    return material('Door_Paint', (198, 198, 190, 1.0), 0.0, 0.6)


# ---------------------------------------------------------------------------
# collection helpers


def new_collection(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(c)
    return c


COLLECTIONS = {}


def coll(name):
    if name not in COLLECTIONS:
        COLLECTIONS[name] = new_collection(name, ROOT_COLL)
    return COLLECTIONS[name]


ROOT_COLL = None


# ---------------------------------------------------------------------------
# mesh creation


def create_mesh(name, pos, nor, idx, mat, collection, extras=None):
    nv = len(pos)
    idx = np.asarray(idx, dtype=np.int32).ravel()
    nt = len(idx) // 3
    if len(idx) != nt * 3:
        idx = idx[:nt * 3]
    me = bpy.data.meshes.new(name)
    me.vertices.add(nv)
    me.vertices.foreach_set('co', np.ascontiguousarray(pos, dtype=np.float32).ravel())
    me.loops.add(len(idx))
    me.loops.foreach_set('vertex_index', np.ascontiguousarray(idx, dtype=np.int32).ravel())
    me.polygons.add(nt)
    me.polygons.foreach_set('loop_start', np.arange(0, len(idx), 3, dtype=np.int32))
    me.polygons.foreach_set('loop_total', np.full(nt, 3, dtype=np.int32))
    me.update(calc_edges=False)
    try:
        me.validate(verbose=False, clean_customdata=False)
    except Exception:
        pass
    try:
        me.polygons.foreach_set('use_smooth', np.ones(nt, dtype=bool))
        me.normals_split_custom_set_from_vertices(np.ascontiguousarray(nor, dtype=np.float32))
    except Exception as e:
        log(f'custom normals failed for {name}: {e}')
    me.update()
    if mat is not None:
        me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    collection.objects.link(obj)
    if extras:
        for k, v in extras.items():
            try:
                obj[k] = v
            except Exception:
                pass
    return obj


def load_bin(path):
    return np.memmap(path, dtype=np.uint8, mode='r')


def read_chunk(mm, meta, dtype):
    off = meta['positionOffset'] if dtype == 'pos' else meta['normalOffset'] if dtype == 'nor' else meta['indexOffset']
    count = meta['vertexCount'] if dtype in ('pos', 'nor') else meta['indexCount']
    if dtype == 'idx':
        arr = np.frombuffer(mm[off:off + count * 4], dtype='<u4').copy()
        return arr.reshape(-1, 3)
    arr = np.frombuffer(mm[off:off + count * 12], dtype='<f4').copy()
    return arr.reshape(-1, 3)


def override_ifc_color(ch, base):
    cat = ch.get('category', '')
    typ = ch.get('type', '')
    r, g, b, a = base
    if cat == '建筑':
        if 'Window' in typ:
            return (112, 158, 188, 0.42)
        if 'Roof' in typ:
            return (78, 82, 84, 1.0)
        if 'Slab' in typ:
            return (154, 152, 146, 1.0)
        if 'Wall' in typ:
            return (198, 194, 184, 1.0)
        if 'Column' in typ or 'Beam' in typ:
            return (176, 172, 164, 1.0)
        if 'Stair' in typ:
            return (128, 126, 120, 1.0)
        if 'Railing' in typ:
            return (86, 90, 90, 1.0)
        if 'Covering' in typ:
            return (164, 160, 152, 1.0)
        if 'Door' in typ:
            return (92, 58, 34, 1.0)
        if 'Proxy' in typ:
            if g > r + 25 and g > b + 18:
                return (92, 112, 96, 1.0)
            return (max(70, int(r * 0.82 + 24)), max(70, int(g * 0.82 + 24)),
                    max(70, int(b * 0.82 + 24)), 1.0)
    if cat in ('结构', '基础'):
        return (136, 133, 126, 1.0)
    if cat == '总图':
        if r > 245 and g > 245 and b > 245:
            return (118, 118, 112, 1.0)
        return (max(40, min(170, int(r * 0.72))), max(40, min(170, int(g * 0.72))),
                max(40, min(170, int(b * 0.72))), 1.0)
    if cat == '一次设备':
        if r > 248 and g > 248 and b > 248:
            return (154, 158, 160, 1.0)
        return base
    if cat in ('暖通', '给排水', '动力照明', '电气二次', '接地'):
        if r > 245 and g > 245 and b > 245:
            return (168, 170, 168, 1.0)
        return (max(50, min(220, r)), max(50, min(220, g)), max(50, min(220, b)), a)
    return base


def build_chunks(bin_name, meta_name, collection_for):
    meta = load_json(meta_name)
    if not meta.get('chunks'):
        log(f'no chunks in {meta_name}; skipping {bin_name}')
        return meta
    mm = load_bin(os.path.join(BUILD, bin_name))
    log(f'loading {len(meta["chunks"])} chunks from {bin_name} ({os.path.getsize(os.path.join(BUILD, bin_name))/1e6:.0f} MB)')
    n = 0
    for ch in meta['chunks']:
        pos = read_chunk(mm, ch, 'pos')
        nor = read_chunk(mm, ch, 'nor')
        idx = read_chunk(mm, ch, 'idx')
        color = tuple(ch['color'])
        alpha = color[3] / 255.0 if color[3] > 1.0 else color[3]
        rgba = (color[0], color[1], color[2], alpha)
        cat = ch.get('category', '')
        if meta_name.startswith('ifc'):
            rgba = override_ifc_color(ch, rgba)
            cat = ch.get('category', '')
            if rgba[3] < 0.999:
                metallic = 0.0
                roughness = 0.18
            elif cat == '建筑':
                metallic = 0.0
                roughness = 0.85
            elif cat in ('一次设备', '交流电气系统'):
                metallic = 0.35
                roughness = 0.55
            else:
                metallic = 0.0
                roughness = 0.82
        else:
            metallic = 0.35 if abs(color[0] - color[1]) < 12 and abs(color[1] - color[2]) < 12 else 0.0
            roughness = 0.68
        mat = material(f'MAT_{cat}_{rgba[0]}_{rgba[1]}_{rgba[2]}_{int(rgba[3]*255)}', rgba, metallic, roughness)
        c = collection_for(ch)
        create_mesh(ch['name'][:58], pos, nor, idx, mat, c, {
            'source_kind': 'GIM' if meta_name.startswith('gim') else 'IFC',
            'category': cat,
            'source_file': ch.get('file', ''),
            'tile': str(ch.get('tile', '')),
        })
        n += 1
        if n % 50 == 0:
            log(f'  {n}/{len(meta["chunks"])} chunks')
    log(f'built {n} chunk objects')
    return meta


# ---------------------------------------------------------------------------
# box accumulation for doors, frames, steps


class BoxAcc:
    def __init__(self):
        self.pos = []
        self.nor = []
        self.idx = []

    def add_aabb(self, x0, x1, y0, y1, z0, z1):
        p = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
             (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        faces = [
            ((0, 3, 2, 1), (0, 0, -1)), ((4, 5, 6, 7), (0, 0, 1)),
            ((0, 1, 5, 4), (0, -1, 0)), ((1, 2, 6, 5), (1, 0, 0)),
            ((2, 3, 7, 6), (0, 1, 0)), ((3, 0, 4, 7), (-1, 0, 0)),
        ]
        for quad, n in faces:
            b = len(self.pos)
            for vi in quad:
                self.pos.append(p[vi])
                self.nor.append(n)
            self.idx.extend(((b, b + 1, b + 2), (b, b + 2, b + 3)))

    def add_oriented(self, origin, u, v, w, su, sv, sw):
        origin = np.asarray(origin, dtype=np.float64)
        u = np.asarray(u, dtype=np.float64)
        v = np.asarray(v, dtype=np.float64)
        w = np.asarray(w, dtype=np.float64)
        p = [origin, origin + u * su, origin + u * su + v * sv, origin + v * sv,
             origin + w * sw, origin + u * su + w * sw, origin + u * su + v * sv + w * sw,
             origin + v * sv + w * sw]
        faces = [
            ((0, 3, 2, 1), -w),
            ((4, 5, 6, 7), w),
            ((0, 1, 5, 4), -v),
            ((1, 2, 6, 5), u),
            ((2, 3, 7, 6), v),
            ((3, 0, 4, 7), -u),
        ]
        for quad, n in faces:
            b = len(self.pos)
            for vi in quad:
                self.pos.append(tuple(p[vi]))
                self.nor.append(tuple(n))
            self.idx.extend(((b, b + 1, b + 2), (b, b + 2, b + 3)))

    def arrays(self, origin=(0, 0, 0)):
        if not self.pos:
            return None
        pos = np.asarray(self.pos, dtype=np.float32) - np.asarray(origin, dtype=np.float32)
        nor = np.asarray(self.nor, dtype=np.float32)
        idx = np.asarray(self.idx, dtype=np.uint32)
        return pos, nor, idx


# ---------------------------------------------------------------------------
# doors / gate / steps


def door_material(d):
    kind = d.get('material')
    if kind == 'wood':
        return wood_material()
    if kind == 'metal':
        return door_metal_material()
    return door_paint_material()


def add_frame(d, door_coll):
    if d.get('sourceGeometryDoor'):
        return  # Its original fixed frame remains in the static source mesh.
    b = d['bbox']
    axis = d['axis']
    x0, y0, z0, x1, y1, z1 = b
    acc = BoxAcc()
    j = 0.09
    h = 0.10
    depth = 0.11
    if axis == 'x':
        # wall normal along x; opening spans y
        cx = (x0 + x1) / 2
        acc.add_aabb(cx - depth, cx + depth, y0 - j, y0, z0, z1)
        acc.add_aabb(cx - depth, cx + depth, y1, y1 + j, z0, z1)
        acc.add_aabb(cx - depth, cx + depth, y0 - j, y1 + j, z1, z1 + h)
    else:
        cy = (y0 + y1) / 2
        acc.add_aabb(x0 - j, x0, cy - depth, cy + depth, z0, z1)
        acc.add_aabb(x1, x1 + j, cy - depth, cy + depth, z0, z1)
        acc.add_aabb(x0 - j, x1 + j, cy - depth, cy + depth, z1, z1 + h)
    arr = acc.arrays()
    if arr:
        create_mesh(f'FRAME_{d["id"]}', arr[0], arr[1], arr[2], door_paint_material(), door_coll,
                    {'kind': 'door_frame', 'door_id': str(d['id'])})


def add_leaf(leaf, door, door_coll):
    if leaf.get('geometry'):
        g = leaf['geometry']; hinge = np.asarray(leaf['hinge'], dtype=np.float64)
        pos = np.asarray(g['pos'], dtype=np.float32).reshape(-1, 3) - hinge
        nor = np.asarray(g['nor'], dtype=np.float32).reshape(-1, 3)
        idx = np.asarray(g['idx'], dtype=np.uint32).reshape(-1, 3)
        color = leaf.get('color', [120,120,120,255]); alpha = color[3]/255 if color[3]>1 else color[3]
        obj = create_mesh(leaf['name'],pos,nor,idx,material('Source_Door',(*color[:3],alpha),.2,.6),door_coll,
            {'kind':'swing','door_id':str(door['id']),'source_id':door.get('sourceId',''),'source_part':leaf.get('sourceGeometryId','')})
        obj.location = hinge.tolist()
        return

    hinge = np.array(leaf['hinge'], dtype=np.float64)
    closed = np.array(leaf.get('closedDir', [1, 0]), dtype=np.float64)
    ln = np.linalg.norm(closed)
    if ln < 1e-9:
        closed = np.array([1.0, 0.0])
    else:
        closed /= ln
    # choose the panel normal as the horizontal perpendicular
    normal = np.array([-closed[1], closed[0], 0.0])
    u = np.array([closed[0], closed[1], 0.0])
    w = np.array([0.0, 0.0, 1.0])
    kind = leaf.get('kind', 'swing')
    acc = BoxAcc()
    if kind == 'rollup':
        width = door['width'] - 0.04
        height = door['height'] - 0.06
        thickness = max(0.04, door.get('thickness', 0.05))
        origin = np.array([door['center'][0], door['center'][1], door['bottom']]) - u * (width / 2) - normal * (thickness / 2) + np.array([0, 0, 0.03])
        acc.add_oriented(origin, u, normal, w, width, thickness, height)
        obj_origin = [door['center'][0], door['center'][1], door['bottom']]
        extras = {'kind': 'rollup', 'door_id': str(door['id']), 'move_z': float(height * 0.92)}
        mat = door_metal_material()
    else:
        width = max(0.4, float(leaf.get('width', door['width'])))
        height = max(0.4, float(leaf.get('height', door['height'])))
        thickness = max(0.035, float(leaf.get('thickness', 0.05)))
        origin = hinge - normal * (thickness / 2) + np.array([0, 0, 0.01])
        acc.add_oriented(origin, u, normal, w, width, thickness, height - 0.02)
        # A simple raised handle / push bar near the free edge.
        hx = width * 0.82
        if width > 1.0:
            bar_origin = origin + u * hx + normal * thickness
            acc.add_oriented(bar_origin, u, normal, w, 0.035, 0.035, min(0.28, height * 0.18))
        obj_origin = hinge.tolist()
        extras = {
            'kind': 'swing',
            'door_id': str(door['id']),
            'open_angle': float(leaf.get('angle', 0.0)),
            'leaf_side': int(leaf.get('side', 1)),
        }
        mat = door_material(door)
    arr = acc.arrays(origin=obj_origin)
    if arr is None:
        return
    obj = create_mesh(leaf['name'], arr[0], arr[1], arr[2], mat, door_coll, extras)
    obj.location = obj_origin


def add_gate_leaf(leaf, door_coll):
    hinge = np.array(leaf['hinge'], dtype=np.float64)
    closed = np.array(leaf.get('closedDir', [1, 0]), dtype=np.float64)
    closed /= np.linalg.norm(closed)
    normal = np.array([-closed[1], closed[0], 0.0])
    u = np.array([closed[0], closed[1], 0.0])
    w = np.array([0.0, 0.0, 1.0])
    width = float(leaf['width'])
    height = float(leaf['height'])
    thickness = float(leaf.get('thickness', 0.08))
    acc = BoxAcc()
    # Outer frame: bottom, top, free vertical, hinge vertical
    acc.add_oriented(hinge, u, normal, w, width, thickness, 0.10)
    acc.add_oriented(hinge + w * (height - 0.10), u, normal, w, width, thickness, 0.10)
    acc.add_oriented(hinge + u * (width - 0.08), u, normal, w, 0.08, thickness, height)
    acc.add_oriented(hinge, u, normal, w, 0.08, thickness, height)
    # Mid rails and vertical bars.
    for zf in (0.30, 0.62):
        acc.add_oriented(hinge + w * (height * zf), u, normal, w, width, thickness * 0.8, 0.06)
    for i in range(1, 7):
        x = width * i / 7.0
        acc.add_oriented(hinge + u * x, u, normal, w, 0.045, thickness * 0.75, height)
    arr = acc.arrays(origin=hinge.tolist())
    if arr is None:
        return
    obj = create_mesh(leaf['name'], arr[0], arr[1], arr[2], steel_material(), door_coll, {
        'kind': 'gate',
        'door_id': 'GATE',
        'open_angle': float(leaf.get('angle', 0.0)),
        'leaf_side': int(leaf.get('side', 1)),
    })
    obj.location = hinge.tolist()


def add_entrance_steps(site_coll):
    mat = concrete_material()
    acc = BoxAcc()
    steps = [s for s in (NAV or {}).get('entrySteps', []) if s.get('generated') == 'door-access']
    if not steps:
        steps = entrance_steps(PROFILE.get('mainEntrance'))
    for step in steps:
        r = step['rect']
        base = step.get('base', min(float(PROFILE.get('groundZ', step['top'] - .2)), step['top'] - .2))
        acc.add_aabb(r[0], r[2], r[1], r[3], base, step['top'])
    arr = acc.arrays()
    if arr:
        create_mesh('ENTRANCE_STEPS', arr[0], arr[1], arr[2], mat, site_coll, {'kind': 'entrance_steps'})


def add_ground(site_coll):
    b = site_bounds()
    margin = 60.0
    z = profile_or(-0.33,'groundZ')
    pos = np.array([
        [b[0] - margin, b[1] - margin, z], [b[2] + margin, b[1] - margin, z],
        [b[2] + margin, b[3] + margin, z], [b[0] - margin, b[3] + margin, z],
    ], dtype=np.float32)
    nor = np.tile(np.array([0, 0, 1], dtype=np.float32), (4, 1))
    idx = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
    terrain=profile_or(None,'terrainRect')
    if terrain:
        x0,y0,x1,y1=b[0]-margin,b[1]-margin,b[2]+margin,b[3]+margin
        hx0,hy0,hx1,hy1=max(x0,terrain[0]),max(y0,terrain[1]),min(x1,terrain[2]),min(y1,terrain[3])
        rectangles=[(x0,y0,x1,hy0),(x0,hy1,x1,y1),(x0,hy0,hx0,hy1),(hx1,hy0,x1,hy1)]
        positions=[];indices=[]
        for a,c,d,e in rectangles:
            if d<=a or e<=c:continue
            off=len(positions);positions.extend([(a,c,z),(d,c,z),(d,e,z),(a,e,z)])
            indices.extend([(off,off+1,off+2),(off,off+2,off+3)])
        pos=np.asarray(positions,dtype=np.float32);idx=np.asarray(indices,dtype=np.uint32)
        nor=np.tile([0,0,1],(len(pos),1)).astype(np.float32)
    create_mesh('Ground', pos, nor, idx, ground_material(), site_coll, {'kind': 'ground'})
    approach=profile_or(None,'entryApproach')
    if approach:
        r=approach['rect'];top=approach['top']-.01
        points=np.array([(r[0],r[1],top),(r[2],r[1],top),(r[2],r[3],top),(r[0],r[3],top)],dtype=np.float32)
        create_mesh('Gate_Approach',points,np.tile([0,0,1],(4,1)),np.array([[0,1,2],[0,2,3]],dtype=np.uint32),asphalt_material(),site_coll,{'kind':'entrance_approach'})


# ---------------------------------------------------------------------------
# scene setup


def setup_scene():
    global ROOT_COLL
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    try:
        scene.view_settings.view_transform = 'AgX'
        scene.view_settings.look = 'AgX - Medium High Contrast'
    except Exception:
        pass
    scene.view_settings.exposure = -0.25
    try:
        scene.eevee.taa_render_samples = 48
    except Exception:
        pass
    ROOT_COLL = bpy.data.collections.new(SLUG)
    scene.collection.children.link(ROOT_COLL)
    COLLECTIONS.clear()
    for name in ('01_Site', '02_Buildings', '03_Structure', '04_Equipment_IFC',
                 '05_Equipment_GIM', '06_MEP', '07_Doors_Gates', '08_Lights_Cameras'):
        coll(name)
    return scene


def collection_for_ifc(ch):
    cat = ch.get('category', '')
    if cat == '总图':
        return COLLECTIONS['01_Site']
    if cat == '建筑':
        return COLLECTIONS['02_Buildings']
    if cat in ('结构', '基础'):
        return COLLECTIONS['03_Structure']
    if cat == '一次设备':
        return COLLECTIONS['04_Equipment_IFC']
    return COLLECTIONS['06_MEP']


def collection_for_gim(ch):
    return COLLECTIONS['05_Equipment_GIM']


def setup_lights(scene):
    world = bpy.data.worlds.new('SkyWorld')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (0.42, 0.58, 0.78, 1.0)
    bg.inputs[1].default_value = 0.45

    sun_data = bpy.data.lights.new('Sun', type='SUN')
    sun_data.energy = 2.4
    sun_data.angle = math.radians(1.5)
    sun = bpy.data.objects.new('Sun', sun_data)
    sun.rotation_euler = (math.radians(52), 0, math.radians(35))
    COLLECTIONS['08_Lights_Cameras'].objects.link(sun)

    # Interior fill lights for preview renders (not exported to the web GLB).
    fills = []
    if NAV and NAV.get('bounds'):
        b = NAV['bounds']
        cx = (b['x0'] + b['x1']) / 2.0
        cy = (b['y0'] + b['y1']) / 2.0
        # A small 2x2 grid around the site, plus two central fills.
        for dx in (-0.25, 0.25):
            for dy in (-0.25, 0.25):
                fills.append((cx + (b['x1'] - b['x0']) * dx,
                              cy + (b['y1'] - b['y0']) * dy, 3.4))
        fills.extend([(cx, cy - 8.0, 3.0), (cx, cy + 8.0, 3.0)])
    else:
        fills = [(50, 6, 3.4), (30, 6, 3.4), (10, 6, 3.4),
                 (48, -37, 3.4), (25, -37, 3.4), (5, -37, 3.4),
                 (0, -20, 3.0), (35, -20, 3.0)]
    for i, (x, y, z) in enumerate(fills):
        ld = bpy.data.lights.new(f'Fill_{i}', type='POINT')
        ld.energy = 180
        ld.shadow_soft_size = 3.0
        lo = bpy.data.objects.new(f'Fill_{i}', ld)
        lo.location = (x, y, z)
        COLLECTIONS['08_Lights_Cameras'].objects.link(lo)


def look_at(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def setup_cameras(scene):
    cams = {}
    if PROFILE:
        b = site_bounds()
        cx = (b[0] + b[2]) / 2.0
        cy = (b[1] + b[3]) / 2.0
        if PROFILE.get('gate') and PROFILE.get('mainEntrance'):
            gate = PROFILE['gate']
            main = PROFILE['mainEntrance']
            gc = gate.get('center') or [(gate['bbox'][0] + gate['bbox'][3]) / 2,
                                        (gate['bbox'][1] + gate['bbox'][4]) / 2]
            mc = main.get('center') or [(main['bbox'][0] + main['bbox'][3]) / 2,
                                        (main['bbox'][1] + main['bbox'][4]) / 2]
            gout = gate.get('outward') or [1, 0]
            mout = main.get('outward') or [1, 0]
            cams_def = [
                ('CAM_Overview', (b[2] + 25, b[3] + 25, 72), (cx, cy, 2)),
                ('CAM_Gate', (gc[0] + gout[0] * 12, gc[1] + gout[1] * 12, 1.7),
                 (gc[0], gc[1], 1.4)),
                ('CAM_Entrance', (mc[0] + mout[0] * 12, mc[1] + mout[1] * 12, 2.0),
                 (mc[0], mc[1], 1.6)),
                ('CAM_Aerial', (cx, cy, 120), (cx, cy, 0)),
                ('CAM_Alignment', (b[0] - 60, b[1] - 60, 100), (cx, cy, 6)),
            ]
        else:
            # GIM-only / free-roam: still create the full camera set used by
            # preview renders, but point the entrance views at the spawn.
            sp = (PROFILE.get('start') or {}).get('pos') or [cx, cy]
            cams_def = [
                ('CAM_Overview', (b[2] + 25, b[3] + 25, 72), (cx, cy, 2)),
                ('CAM_Gate', (sp[0], sp[1], 1.7), (cx, cy, 1.4)),
                ('CAM_Entrance', (sp[0], sp[1], 2.0), (cx, cy, 1.6)),
                ('CAM_Aerial', (cx, cy, 120), (cx, cy, 0)),
                ('CAM_Alignment', (b[0] - 60, b[1] - 60, 100), (cx, cy, 6)),
            ]
    else:
        cams_def = [
            ('CAM_Overview', (125, 85, 72), (30, -6, 2)),
            ('CAM_Gate', (99, -20.5, 1.7), (82, -20.5, 1.4)),
            ('CAM_Entrance', (66, 7, 2.0), (54, 6.5, 1.6)),
            ('CAM_Aerial', (30, -8, 120), (30, -8, 0)),
            ('CAM_Alignment', (-142, -152, 100), (28, -9, 6)),
        ]
    for name, loc, target in cams_def:
        cd = bpy.data.cameras.new(name)
        cd.lens = 42
        if name == 'CAM_Alignment':
            cd.lens = 48
        co = bpy.data.objects.new(name, cd)
        co.location = loc
        look_at(co, target)
        COLLECTIONS['08_Lights_Cameras'].objects.link(co)
        cams[name] = co
    scene.camera = cams['CAM_Overview']
    return cams


def add_signs():
    # Simple gate sign posts with a text-free colored panel.
    site = COLLECTIONS['01_Site']
    acc = BoxAcc()
    acc.add_aabb(90.5, 90.7, -15.2, -15.0, -0.3, 2.4)
    acc.add_aabb(90.5, 90.7, -26.0, -25.8, -0.3, 2.4)
    acc.add_aabb(90.45, 90.75, -26.2, -14.8, 2.4, 3.2)
    arr = acc.arrays()
    if arr:
        create_mesh('Gate_Sign', arr[0], arr[1], arr[2], material('Sign_Blue', (28, 78, 138, 1.0), 0.1, 0.5), site, {'kind': 'sign'})


# ---------------------------------------------------------------------------


def add_gim_root_markers():
    """Create a hidden, inspectable empty for every gim_viewer occurrence root.

    These markers are not exported to glTF; they let a Blender user enable the
    collection and compare the 285 source placements with the merged GIM chunks.
    """
    coll = bpy.data.collections.new('09_GIM_Root_Markers')
    ROOT_COLL.children.link(coll)
    coll.hide_render = True
    placements = load_json('gim_placements.json').get('placements', [])
    for i, p in enumerate(placements):
        m = p.get('matrix') or []
        if len(m) != 16:
            continue
        name = f"GIM_Root_{i + 1:03d}_{os.path.splitext(os.path.basename(p.get('dev', '')))[0][:8]}"
        empty = bpy.data.objects.new(name, None)
        coll.objects.link(empty)
        empty.empty_display_type = 'PLAIN_AXES'
        empty.empty_display_size = 0.6
        empty.location = (m[12] / 1000.0, m[13] / 1000.0, m[14] / 1000.0)
        empty['gim_dev'] = p.get('dev', '')
        empty['gim_label'] = p.get('label', '')
        empty['gim_matrix'] = ','.join(f'{v:.6f}' for v in m)
    coll.hide_viewport = True
    log(f'added {len(placements)} hidden GIM root markers')
    return coll


def main():
    # Never combine old reflected IFC artifacts with source-frame equipment.
    for name in ('ifc_scene.json', 'gim_scene.json'):
        if load_json(name).get('coordinateSystem') != 'source-z-up-metres-v2':
            raise RuntimeError(f'{name}: regenerate both geometry extracts before building')
    scene = setup_scene()
    log('scene reset')

    ifc_meta = build_chunks('ifc_scene.bin', 'ifc_scene.json', collection_for_ifc)
    gim_meta = build_chunks('gim_scene.bin', 'gim_scene.json', collection_for_gim)

    site = COLLECTIONS['01_Site']
    add_ground(site)
    # Source roads are already in IFC; do not invent a cross-site asphalt strip.
    add_entrance_steps(site)

    door_coll = COLLECTIONS['07_Doors_Gates']
    for d in ifc_meta['doors']:
        add_frame(d, door_coll)
        for leaf in d['leaves']:
            add_leaf(leaf, d, door_coll)

    gate = ifc_meta.get('gate')
    if gate and gate.get('leaves'):
        for leaf in gate['leaves']:
            add_gate_leaf(leaf, door_coll)
    log('doors and gate built')

    setup_lights(scene)
    cams = setup_cameras(scene)
    add_gim_root_markers()

    # Metadata for the viewer and for Blender inspection.
    root = ROOT_COLL
    root['source'] = SOURCE_NAME
    root['crs'] = 'local site metres, Z-up'
    root['build_version'] = '2026-11-11-pipeline-v2'
    root['ifc_triangles'] = ifc_meta['counts']['triangles']
    root['gim_triangles'] = gim_meta['stats']['tris']
    root['door_count'] = len(ifc_meta['doors'])
    root['gim_roots'] = gim_meta.get('placements', 0)
    root['gim_dev_instances'] = gim_meta.get('dev_instances', 0)
    root['gim_placements'] = gim_meta.get('dev_instances', gim_meta.get('placements', 0))

    scene.frame_start = 1
    scene.frame_end = 1

    blend_path = os.path.join(BUILD, f'{SLUG}.blend')
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    log(f'saved {blend_path} ({os.path.getsize(blend_path)/1e6:.0f} MB)')

    # Export static meshes + doors/gates for the web.
    export_objs = []
    for cname in ('01_Site', '02_Buildings', '03_Structure', '04_Equipment_IFC',
                  '05_Equipment_GIM', '06_MEP', '07_Doors_Gates'):
        export_objs.extend(list(COLLECTIONS[cname].objects))
    bpy.ops.object.select_all(action='DESELECT')
    for obj in export_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = export_objs[0]
    glb_path = os.path.join(BUILD, f'{SLUG}.glb')
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        export_texcoords=False,
        export_normals=True,
        export_materials='EXPORT',
        export_animations=False,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_generic_quantization=8,
    )
    log(f'exported {glb_path} ({os.path.getsize(glb_path)/1e6:.0f} MB)')

    # Render preview images from the same scene.
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    renders = [
        ('CAM_Overview', 'overview.png'),
        ('CAM_Gate', 'gate.png'),
        ('CAM_Entrance', 'entrance.png'),
        ('CAM_Aerial', 'aerial.png'),
        ('CAM_Alignment', 'alignment.png'),
    ]
    if os.environ.get('GIM_BLENDER_SKIP_RENDERS') == '1':
        log('preview renders skipped (GIM_BLENDER_SKIP_RENDERS=1)')
    else:
        for cam_name, filename in renders:
            scene.camera = cams[cam_name]
            # Brighter comparison preview; it does not change exported materials.
            scene.view_settings.exposure = 0.7 if cam_name == 'CAM_Alignment' else -0.25
            scene.render.filepath = os.path.join(RENDERS, filename)
            log(f'rendering {filename}')
            bpy.ops.render.render(write_still=True)
    log('done')


if __name__ == '__main__':
    main()
