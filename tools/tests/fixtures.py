"""Small synthetic inputs shared by tool unit tests and frozen smoke tests."""
from pathlib import Path
import zipfile


def matrix(x=0):
    return f'1,0,0,0,0,1,0,0,0,0,1,0,{x},0,0,1'


def write_sources(root, files):
    root = Path(root)
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode('utf-8'))
    return root


def device_sources():
    return {
        'CBM/project.cbm': 'ENTITYNAME=Device\nOBJECTMODELPOINTER=root.dev',
        'DEV/root.dev': 'SYMBOLNAME=CI device\nSOLIDMODELS.NUM=1\nSOLIDMODEL0=assembly.phm\nTRANSFORMMATRIX0=' + matrix(100),
        'PHM/assembly.phm': ('SOLIDMODELS.NUM=2\nSOLIDMODEL0=body.mod\nTRANSFORMMATRIX0=' + matrix()
                             + '\nSOLIDMODEL1=body.mod\nTRANSFORMMATRIX1=' + matrix(1000)),
        'MOD/body.mod': ('<Device><Entities><Entity ID="1"><TransformMatrix Value="' + matrix(50)
                         + '"/><Cuboid L="1000" W="500" H="700"/></Entity></Entities></Device>'),
    }


def information_sources():
    files = device_sources()
    files.update({
        'CBM/project.cbm': 'ENTITYNAME=F1System\nSUBSYSTEM0=child.cbm\nSUBSYSTEM1=child.cbm',
        'CBM/child.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=root.dev\nBASEFAMILY0=shared.fam\nIFCFILE=test.ifc',
        'DEV/root.dev': 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=assembly.phm',
        'PHM/assembly.phm': ('SOLIDMODELS.NUM=3\nSOLIDMODEL0=body.mod\nTRANSFORMMATRIX0=' + matrix()
                            + '\nSOLIDMODEL1=body.mod\nTRANSFORMMATRIX1=' + matrix(1000)
                            + '\nSOLIDMODEL2=missing.mod\nBASEFAMILY0=shared.fam'),
        'DEV/shared.fam': 'NAME=first candidate',
        'MOD/shared.fam': 'NAME=second candidate',
        'DEV/test.ifc': "ISO-10303-21;\nHEADER;ENDSEC;DATA;\nENDSEC;END-ISO-10303-21;",
    })
    return files


def element_sources():
    return {
        'CBM/project.cbm': 'ENTITYNAME=F1System\nSUBSYSTEM0=main.cbm\nSUBSYSTEM1=neutral.cbm',
        'CBM/main.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=main.dev',
        'CBM/neutral.cbm': 'ENTITYNAME=F4System\nOBJECTMODELPOINTER=neutral.dev',
        'DEV/main.dev': 'SYMBOLNAME=主变压器\nTYPE=OilImmersedTransformer',
        'DEV/neutral.dev': 'SYMBOLNAME=220kV中性点成套装置\nTYPE=OpenGroundingEquipment/NeutralPointEquipment',
        'IFC/test.ifc': ("ISO-10303-21;\nHEADER;ENDSEC;DATA;\n"
                         "#1=IFCWALL('0wwwwwwwwwwwwwwwwwwwww',$,'墙体',$,$,$,$,$);\n"
                         "#2=IFCDISTRIBUTIONPORT('0ppppppppppppppppppppp',$,'端口',$,$,$,$,$);\n"
                         'ENDSEC;END-ISO-10303-21;'),
    }


def write_zip(path, files):
    with zipfile.ZipFile(path, 'w') as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return Path(path)


def write_gim7z(path, files, source):
    import py7zr
    source = write_sources(source, files)
    payload = Path(path).with_suffix('.7z')
    with py7zr.SevenZipFile(payload, 'w') as archive:
        for name in files:
            archive.write(source / name, name)
    Path(path).write_bytes(b'GIMPKGS' + b'\0' * 25 + payload.read_bytes())
    return Path(path)
