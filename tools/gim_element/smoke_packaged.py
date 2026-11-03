"""Exercise the actual frozen GUI, bundled catalog, Qt plugins and 7z import."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

import py7zr


def main():
    tool = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=tool.parents[1] / 'output/v020-stage2-fixes/packaged-smoke')
    args = parser.parse_args()
    out = args.out.resolve()
    source = out / 'source'
    wall_guid, port_guid = '0' + 'w' * 21, '0' + 'p' * 21
    files = {
        'CBM/project.cbm': 'ENTITYNAME=F1System\nSUBSYSTEM0=main.cbm\nSUBSYSTEM1=neutral.cbm\nSUBSYSTEM2=bus.cbm',
        'CBM/main.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=main.dev',
        'CBM/neutral.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=neutral.dev',
        'CBM/bus.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=bus.dev',
        'DEV/main.dev': 'SYMBOLNAME=主变压器\nTYPE=OilImmersedTransformer',
        'DEV/neutral.dev': 'SYMBOLNAME=220kV中性点成套装置\nTYPE=OpenGroundingEquipment/NeutralPointEquipment',
        'DEV/bus.dev': 'SYMBOLNAME=管母线\nTYPE=TubularBus',
        'IFC/test.ifc': f"ISO-10303-21;\nHEADER;ENDSEC;DATA;\n#1=IFCWALL('{wall_guid}',$,'墙体',$,$,$,$,$);\n#2=IFCDISTRIBUTIONPORT('{port_guid}',$,'端口',$,$,$,$,$);\nENDSEC;END-ISO-10303-21;",
    }
    for name, text in files.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
    payload = out / 'payload.7z'
    with py7zr.SevenZipFile(payload, 'w') as archive:
        for name in files:
            archive.write(source / name, name)
    gim = out / 'fixture.gim'
    gim.write_bytes(b'GIMPKGS' + b'\0' * 9 + payload.read_bytes())
    bundle = tool / 'dist/GIM实体盘点器'
    exe = bundle / 'GIM实体盘点器.exe'
    png = out / 'packaged.png'
    receipt = Path(str(png) + '.json')
    if receipt.exists():
        receipt.unlink()
    env = {**os.environ, 'QT_QPA_PLATFORM': 'offscreen',
           'QT_QPA_FONTDIR': str(Path(os.environ['WINDIR']) / 'Fonts')}
    result = subprocess.run([str(exe), '--smoke', str(gim), str(png)], cwd=out, env=env,
                            timeout=90, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode != 0 or not receipt.is_file() or not png.is_file():
        log = Path(str(png) + '.log')
        raise RuntimeError(f'Frozen application smoke failed: exit={result.returncode}\n{log.read_text(encoding="utf-8") if log.exists() else "No runtime log"}')
    evidence = json.loads(receipt.read_text(encoding='utf-8'))
    assert evidence['frozen'] is True
    assert evidence['groups'] == ['设备', '装置性材料', '构件', '其他'], evidence
    assert evidence['totals']['设备']['附件并入'] == 1, evidence
    assert evidence['totals']['设备']['台数'] == 1, evidence
    expected = tool.parents[1] / 'desktop/src/engineering/catalog.json'
    actual = bundle / '_internal/catalog.json'
    assert hashlib.sha256(actual.read_bytes()).digest() == hashlib.sha256(expected.read_bytes()).digest()
    print(json.dumps({'passed': True, 'exe': str(exe), 'screenshot': str(png), **evidence}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
