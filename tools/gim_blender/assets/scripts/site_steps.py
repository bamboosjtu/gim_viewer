"""The same entry step rectangles feed Blender and runtime floor navigation."""
import math
import base64
from array import array


def door_access_steps(nav, doors):
    """Explicit navigation assistance for a source threshold above its exterior.

    Sample source floors on both sides, outside the threshold padding. Only an
    unambiguous floor-height transition creates visible, source-addressed steps.
    """
    if nav.get('floor', {}).get('type') != 'layers-i16':
        return []
    offsets = array('I'); offsets.frombytes(base64.b64decode(nav['floor']['offsets']))
    heights = array('h'); heights.frombytes(base64.b64decode(nav['floor']['values']))
    b = nav['bounds']; result = []

    def floor_at(x, y, maximum):
        ix = math.floor((x-b['x0'])/b['res']); iy = math.floor((y-b['y0'])/b['res'])
        if ix < 0 or iy < 0 or ix >= b['w'] or iy >= b['h']:
            return None
        cell = iy*b['w']+ix
        values = [heights[k]/100 for k in range(offsets[cell], offsets[cell+1]) if heights[k]/100 <= maximum]
        return max(values) if values else None

    for door in doors:
        box=door['bbox']; center=door['center']; normal=[1,0] if door['axis']=='x' else [0,1]
        levels=[floor_at(center[0]+side*normal[0]*.8,center[1]+side*normal[1]*.8,door['bottom']+.3) for side in (-1,1)]
        if any(v is None for v in levels):continue
        inside=[i for i,v in enumerate(levels) if abs(v-door['bottom'])<.15]
        if len(inside)!=1:continue
        exterior=1-inside[0];ground=levels[exterior];top=levels[inside[0]];rise=top-ground
        if rise<=.3 or rise>2.5:continue
        sign=-1 if exterior==0 else 1
        outward=[sign*normal[0],sign*normal[1]];door['outward']=outward
        axis=0 if door['axis']=='x' else 1
        face=box[axis+3] if sign>0 else box[axis]
        count=math.ceil(rise/.22)
        for i in range(count):
            a=face+sign*(-.2 if i==0 else i*.36);c=face+sign*((i+1)*.36)
            rect=[min(a,c),box[1]-.08,max(a,c),box[4]+.08] if axis==0 else [box[0]-.08,min(a,c),box[3]+.08,max(a,c)]
            result.append({'rect':rect,'top':top-rise*i/count,'base':ground-.05,
                'generated':'door-access','sourceDoorId':door.get('sourceId',door['id']),
                'sourceFloorLevels':levels})
    return result
def entrance_steps(main):
    if not main or not main.get('bbox') or main.get('bottom', 0) < .05:
        return []
    b = main['bbox']; axis = main['axis']; out = main['outward']
    sign = out[0] if axis == 'x' else out[1]
    face = (b[3] if sign > 0 else b[0]) if axis == 'x' else (b[4] if sign > 0 else b[1])
    distances = [-.1, .7, 1.3, 1.9, 2.5]
    result = []
    for i in range(4):
        a = face + sign * distances[i]; c = face + sign * distances[i+1]
        rect = [min(a,c), b[1]-.7, max(a,c), b[4]+.7] if axis == 'x' else [b[0]-.7,min(a,c),b[3]+.7,max(a,c)]
        result.append({'rect':rect,'top':max(.02,main['bottom']*(1-i/4))})
    return result
