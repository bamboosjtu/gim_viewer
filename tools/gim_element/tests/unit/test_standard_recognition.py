from pathlib import Path
import os,sys,json,unittest,tempfile,subprocess,shutil
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from support import TOOL,record
import standard_recognition as R

class StandardTests(unittest.TestCase):
    def test_keyword_review_requires_verification_and_original_locator(self):
        entry=R.VOCAB['keywordDictionary']['entries']['gis']['evidence'];original=dict(entry)
        row=record({'id':'x','type':'OTHERS','props':{'SYSCLASSIFYNAME':'GIS'}})
        self.assertEqual(R.interpret(row)['categoryStatus'],'confirmed')
        try:
            for verification in ('unverified','ambiguous','verified'):
                entry.update(original);entry['verification']=verification
                if verification=='verified':entry['sourceLocation']=''
                self.assertEqual(R.interpret(row)['categoryStatus'],'candidate')
        finally:entry.clear();entry.update(original)
    def test_all_verified_index_rows(self):
        for item in R.STANDARD['items']:
            for name in (item['term'],item['label']):
                with self.subTest(name=name):
                    result=R.interpret(record({'id':'x','type':'OTHERS','props':{'EQUIPMENTTYPE' if item['kind']=='equipment' else 'MATERIALTYPE' if item['kind']=='material' else '构件类型':name}}))
                    if len({i['category'] for i in R.resolved_terms(name)})>1:self.assertEqual(result['category'],'U-OBJECT')
                    else:self.assertTrue(result['category'].startswith({'equipment':'E','material':'M','construction':'C'}[item['kind']]))
                    if len(R.resolved_terms(name))==1:
                        R.publish_category(result);self.assertEqual(result['category'],R.resolved_terms(name)[0]['category'])
        self.assertEqual(len(R.STANDARD['items']),141)
    def test_all_component_rows_and_namespace_collisions(self):
        for part in R.CATALOG['components']:
            for word in (part['label'],part['term']):
                with self.subTest(word=word):
                    result=R.interpret(record({'id':'x','type':word,'props':{'OBJECTROLE':'part'}}))
                    self.assertEqual(result['componentType']['id'],'protective_device' if word=='ProtectionEquipment' else part['id']);self.assertNotIn('standardClass',result)
        for word,category in [('TerminalBox','M04'),('GroundResistance','E09')]:
            result=R.interpret(record({'id':'x','type':word}));R.publish_category(result);self.assertEqual(result['category'],category);self.assertNotIn('componentType',result)
    def test_ambiguous_keyword_retains_both_locations(self):
        result=R.interpret(record({'id':'x','type':'OTHERS','props':{'SYSCLASSIFYNAME':'均压屏蔽装置'}}))
        observation=result['vocabularyObservations'][0]
        self.assertEqual(observation['status'],'mapped');self.assertEqual(len(json.loads(observation['dictionaryEvidence'])),2)
    def test_structured_facts_precede_component_names(self):
        result=R.interpret(record({'id':'x','type':'OTHERS','name':'散热器','props':{'TYPE':'CircuitBreaker'}}))
        self.assertEqual(result['category'],'E06');self.assertNotIn('componentType',result)
    def test_shared_behavior_cases(self):
        for case in json.loads((TOOL/'tests/contracts/recognition_cases.json').read_text(encoding='utf-8')):
            with self.subTest(case=case['name']):
                rows=[record(r) for r in case['records']];model=R.normalize(rows,'scope')
                self.assertEqual(sorted(sorted(e['sourceIds']) for e in model['entities']),sorted(case['groups']))
                self.assertEqual(len(model['pending']),case['pending'])
                self.assertEqual(R.normalize(list(reversed(rows)),'scope'),model)
                self.assertEqual(len(model['memberships']),len(rows))
    def test_algorithm_runs_outside_repository_with_only_its_own_modules_and_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name in ['standard_recognition.py','standard_sources.py','catalog.json','standardCatalog.json','sourceVocabulary.json','sourceCompatibilityPolicy.json','compositionPolicy.json','recognitionPolicy.json','proxyCategories.json']:shutil.copyfile(TOOL/name,root/name)
            code='import sys;sys.path.insert(0,sys.argv[1]);import standard_recognition as r;assert len(r.STANDARD["items"])==141;assert r.category_value("TerminalBox")=="M10"'
            subprocess.run([sys.executable,'-I','-c',code,str(root)],cwd=root,check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))

if __name__=='__main__':unittest.main()
