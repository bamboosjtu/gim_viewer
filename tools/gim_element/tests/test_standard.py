from pathlib import Path
import os,sys,json,unittest,tempfile,subprocess,shutil
TOOL=Path(__file__).resolve().parents[1];sys.path.insert(0,str(TOOL))
TEMP=TOOL.parents[1]/'tmp/tests/gim-element-standard';TEMP.mkdir(parents=True,exist_ok=True)
os.environ.update(TEMP=str(TEMP),TMP=str(TEMP),TMPDIR=str(TEMP));tempfile.tempdir=str(TEMP)
import standard_recognition as R
from standard_sources import Reader

def record(source):return {'id':source['id'],'name':source.get('name',source['id']),'source_type':source['type'],'parent':source.get('parent',''),'source':source['id']+'.dev','track':'dev','attributeOnly':source.get('attributeOnly',False),'relations':source.get('relations',[]),'declaredHosts':[r['targetSourceId'] for r in source.get('relations',[])],'declaredHostEvidence':{r['targetSourceId']:r['evidence'] for r in source.get('relations',[])},'properties':[{'keys':[k],'value':v,'path':'attributes.fam','line':i} for i,(k,v) in enumerate(source.get('props',{}).items(),1)]}
class MemoryFile:
    def __init__(self,text):self.text=text;self.reads=0
    def read_bytes(self):self.reads+=1;return self.text.encode('utf-8')

class StandardTests(unittest.TestCase):
    def test_all_verified_index_rows(self):
        for item in R.STANDARD['items']:
            for name in (item['term'],item['label']):
                with self.subTest(name=name):
                    result=R.interpret(record({'id':'x','type':name}))
                    self.assertTrue(result['category'].startswith({'equipment':'E','material':'M','construction':'C'}[item['kind']]))
        self.assertEqual(len(R.STANDARD['items']),121)
    def test_shared_behavior_cases(self):
        for case in json.loads((TOOL/'tests/recognition_cases.json').read_text(encoding='utf-8')):
            with self.subTest(case=case['name']):
                rows=[record(r) for r in case['records']];model=R.normalize(rows,'scope')
                self.assertEqual(sorted(sorted(e['sourceIds']) for e in model['entities']),sorted(case['groups']))
                self.assertEqual(len(model['pending']),case['pending'])
                self.assertEqual(R.normalize(list(reversed(rows)),'scope'),model)
                self.assertEqual(len(model['memberships']),len(rows))
    def test_algorithm_runs_outside_repository_with_only_its_own_modules_and_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name in ['standard_recognition.py','standard_sources.py','catalog.json','standardCatalog.json','sourceVocabulary.json','sourceTypeAliases.json','catalogRules.json','proxyCategories.json']:shutil.copyfile(TOOL/name,root/name)
            code='import sys;sys.path.insert(0,sys.argv[1]);import standard_recognition as r;assert len(r.STANDARD["items"])==121;assert r.category_value("TerminalBox")=="M10"'
            subprocess.run([sys.executable,'-I','-c',code,str(root)],cwd=root,check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))

if __name__=='__main__':unittest.main()
