"""Developer-local synthetic source assembly checks; excluded from CI."""
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from support import TEMP,MemoryFile
from standard_sources import Reader
import standard_recognition as R

class SourceAssemblyTests(unittest.TestCase):
    def test_matching_cbm_and_dev_assembly_confirm_membership_without_confirming_name_type(self):
        files={
            'project.cbm':MemoryFile('OBJECTMODELPOINTER=main.dev\nSUBDEVICE0=fuse.cbm'),
            'main.dev':MemoryFile('TYPE=GIS\nSUBDEVICE0=fuse.dev'),
            'fuse.cbm':MemoryFile('ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=fuse.dev\nBASEFAMILY=fuse.fam'),
            'fuse.dev':MemoryFile('TYPE=OTHERS'),
            'fuse.fam':MemoryFile('[设计]\n设备名称=NAME=熔断器'),
        }
        rows=Reader(TEMP,files).scan()
        model=R.normalize(rows,'scope')
        fuse=next(m for m in model['memberships'] if m['interpretation']['category']=='E13')
        self.assertEqual(len(model['entities']),1)
        self.assertEqual(fuse['interpretation']['standardClass']['status'],'candidate')
        self.assertEqual(fuse['interpretation']['membershipStatus'],'confirmed')
    def test_partindex_never_creates_a_physical_root(self):
        for copies in (0,1,2):
            files={'project.cbm':MemoryFile('OBJECTMODELPOINTER=main.dev\nSUBDEVICE0=part.cbm'),'main.dev':MemoryFile('TYPE=GIS\n'+'\n'.join('SUBDEVICE%d=body.dev'%i for i in range(copies))),'body.dev':MemoryFile('TYPE=Body'),'part.cbm':MemoryFile('ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=body.dev\nBASEFAMILY=part.fam'),'part.fam':MemoryFile('[设计]\n部件名称=PARTNAME=本体')}
            reader=Reader(TEMP,files);rows=reader.scan()
            self.assertEqual(len([r for r in rows if not r.get('attributeOnly')]),1+copies);self.assertEqual(reader.aliases[0]['status'],['unresolved','confirmed','ambiguous'][copies])
            self.assertEqual(sum(bool(r.get('attributeOnly')) for r in rows),int(copies==0))
            if copies==0:self.assertEqual(len(R.normalize(rows,'scope')['entities'][0]['sourceIds']),2)
            self.assertTrue(all(f.reads<=1 for f in files.values()))
