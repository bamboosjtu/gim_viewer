"""Bake exact, source-space DEV mesh collision with an offline triangle BVH.

The input is the same placed mesh consumed by Blender. No device/root bounds
are substituted for geometry: openings and spaces under overhead parts survive.
"""
from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
import struct

import numpy as np

MAGIC = 0x31435644  # DVC1, little endian
LEAF = 0x80000000


def encode_mesh(positions, triangles):
    positions = np.asarray(positions, dtype='<f4').reshape(-1, 3)
    triangles = np.asarray(triangles, dtype='<u4').reshape(-1, 3)
    if not np.isfinite(positions).all():
        raise ValueError('non-finite equipment position')
    if len(triangles) and int(triangles.max()) >= len(positions):
        raise ValueError('equipment index outside vertex buffer')
    points = positions[triangles]
    cross = np.cross(points[:, 1]-points[:, 0], points[:, 2]-points[:, 0])
    valid = np.sum(cross.astype(np.float64)**2, axis=1) > 1e-20
    triangles = triangles[valid]
    points = points[valid]
    lo, hi = points.min(axis=1), points.max(axis=1)
    del points
    centers = (lo + hi) * .5
    order = np.arange(len(triangles), dtype=np.uint32)
    bounds, links = [], []
    if len(order):
        bounds.append(None); links.append(None)
        stack = [(0, len(order), 0)]
        while stack:
            start, end, node = stack.pop()
            ids = order[start:end]
            low, high = lo[ids].min(axis=0), hi[ids].max(axis=0)
            bounds[node] = np.concatenate((low, high))
            if end-start <= 16:
                links[node] = (LEAF | start, end-start)
                continue
            axis = int(np.argmax(high-low))
            middle = len(ids)//2
            order[start:end] = ids[np.argpartition(centers[ids, axis], middle)]
            left = len(bounds); right = left+1
            bounds.extend((None, None)); links.extend((None, None))
            links[node] = (left, right)
            stack.extend(((start, start+middle, left), (start+middle, end, right)))
    header = struct.pack('<8I', MAGIC, 1, len(positions), len(triangles), len(bounds), 0, 0, 0)
    return b''.join((header, positions.tobytes(), triangles[order].tobytes(),
                     np.asarray(bounds, dtype='<f4').tobytes(), np.asarray(links, dtype='<u4').tobytes())), len(bounds), len(triangles)


def bake_equipment(build, assets):
    build, assets = Path(build), Path(assets)
    meta = json.loads((build/'gim_scene.json').read_text(encoding='utf-8'))
    if meta.get('coordinateSystem') != 'source-z-up-metres-v2':
        raise ValueError('equipment collision requires the placed source metre frame')
    source = build/'gim_scene.bin'
    raw = np.memmap(source, dtype='u1', mode='r') if source.stat().st_size else b''
    positions, triangles, count = [], [], 0
    for chunk in meta['chunks']:
        p = np.frombuffer(raw, dtype='<f4', count=chunk['vertexCount']*3, offset=chunk['positionOffset']).reshape(-1, 3)
        idx = np.frombuffer(raw, dtype='<u4', count=chunk['indexCount'], offset=chunk['indexOffset']).reshape(-1, 3)
        # Exact deduplication only; no quantization, hull, or whole-device box.
        unique, inverse = np.unique(p, axis=0, return_inverse=True)
        if len(idx) and int(idx.max()) >= len(p):
            raise ValueError('bad source equipment index')
        positions.append(unique); triangles.append((inverse[idx]+count).astype('<u4'))
        count += len(unique)
    p = np.concatenate(positions) if positions else np.empty((0, 3), dtype='<f4')
    idx = np.concatenate(triangles) if triangles else np.empty((0, 3), dtype='<u4')
    binary, nodes, triangle_count = encode_mesh(p, idx)
    packed = gzip.compress(binary, compresslevel=6, mtime=0)
    name = 'equipment-collision.bin.gz'
    (assets/name).write_bytes(packed)
    with source.open('rb') as f:
        source_hash = hashlib.file_digest(f, 'sha256').hexdigest()
    return {'type': 'bvh-f32-u32-v1', 'url': name, 'sha256': hashlib.sha256(packed).hexdigest(),
            'sourceMeshSha256': source_hash, 'vertices': count, 'triangles': triangle_count,
            'nodes': nodes, 'bytes': len(packed), 'decodedBytes': len(binary)}
