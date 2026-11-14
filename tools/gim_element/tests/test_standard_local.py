"""Developer-local synthetic source assembly checks; excluded from CI."""
from test_standard import unittest,Reader,TEMP,MemoryFile
import standard_recognition as R

class SourceAssemblyTests(unittest.TestCase):
    def test_partindex_never_creates_a_physical_root(self):
        for copies in (0,1,2):
            files={'project.cbm':MemoryFile('OBJECTMODELPOINTER=main.dev\nSUBDEVICE0=part.cbm'),'main.dev':MemoryFile('TYPE=GIS\n'+'\n'.join('SUBDEVICE%d=body.dev'%i for i in range(copies))),'body.dev':MemoryFile('TYPE=Body'),'part.cbm':MemoryFile('ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=body.dev\nBASEFAMILY=part.fam'),'part.fam':MemoryFile('[设计]\n部件名称=PARTNAME=本体')}
            reader=Reader(TEMP,files);rows=reader.scan()
            self.assertEqual(len([r for r in rows if not r.get('attributeOnly')]),1+copies);self.assertEqual(reader.aliases[0]['status'],['unresolved','confirmed','ambiguous'][copies])
            self.assertEqual(sum(bool(r.get('attributeOnly')) for r in rows),int(copies==0))
            if copies==0:self.assertEqual(len(R.normalize(rows,'scope')['entities'][0]['sourceIds']),2)
            self.assertTrue(all(f.reads<=1 for f in files.values()))
