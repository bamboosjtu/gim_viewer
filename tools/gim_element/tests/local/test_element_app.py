"""Local Qt interaction checks using source DTOs; no engineering archive needed."""
from pathlib import Path
import json,os,sys,unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from support import TEMP,record
os.environ.setdefault('QT_QPA_PLATFORM','offscreen')
from PySide6.QtCore import Qt,QSettings
from PySide6.QtWidgets import QApplication
import element_app as GUI
from standard_recognition import normalize,ledger_from_standard

def result():
    sources=[record(r) for r in [
        {'id':'host','type':'GIS','name':'组合电器'},
        {'id':'radiator','type':'Radiator','parent':'host','name':'内部散热器'},
        {'id':'cabinet','type':'SecondaryCabinet','name':'1号主变压器保护B柜'},
        {'id':'protection','type':'OTHERS','parent':'cabinet','name':'内部保护模块','props':{'装置名称':'变压器保护装置'}},
        {'id':'gateway','type':'SecondaryCabinet','name':'I区网关机柜'},
        {'id':'resistor','type':'GroundResistance','name':'接地电阻成套装置'},
        {'id':'pending','type':'OpenGroundingEquipment/NeutralPointEquipment','name':'未确定宿主的中性点装置'},
    ]]
    data={'snapshot':normalize(sources,'scope'),'sources':sources,'inventory':dict.fromkeys(['cbm','dev','fam','ifc'],0)}
    ledger=ledger_from_standard(data);ledger['meta']={'elapsed':0.0};return ledger

def walk(item):
    yield item
    for index in range(item.childCount()):yield from walk(item.child(index))

class EntityTreeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.app=QApplication.instance() or QApplication([])

    def setUp(self):
        with patch.object(GUI,'QSettings',lambda *_:QSettings(str(TEMP/'element-gui.ini'),QSettings.IniFormat)):
            self.window=GUI.MainWindow()
        self.window.setAttribute(Qt.WA_DontShowOnScreen,True)
        self.window.result=result();self.window._populate()
        self.addCleanup(self.window.close)

    def nodes(self):return [node for i in range(self.window.tree.topLevelItemCount()) for node in walk(self.window.tree.topLevelItem(i))]

    def entity(self,source_id):
        id=next(e['id'] for e in self.window.result['recognition']['snapshot']['entities'] if source_id in e['sourceIds'])
        return next(n for n in self.nodes() if (n.data(0,Qt.UserRole) or {}).get('nodeKind')=='entity' and n.data(0,Qt.UserRole)['entityId']==id)

    def test_only_entities_are_leaves_and_export_keeps_parts_and_pending_sources(self):
        before=json.dumps(self.window.result,ensure_ascii=False,sort_keys=True)
        snapshot=self.window.result['recognition']['snapshot']
        nodes=self.nodes();instances=[n for n in nodes if (n.data(0,Qt.UserRole) or {}).get('nodeKind')=='entity']
        self.assertEqual({n.data(0,Qt.UserRole)['entityId'] for n in instances},{e['id'] for e in snapshot['entities']})
        self.assertTrue(all(n.childCount()==0 for n in instances))
        self.assertFalse(any((n.data(0,Qt.UserRole) or {}).get('nodeKind')=='source' for n in nodes))
        self.assertNotIn('（本体）',[n.text(0) for n in nodes])
        self.assertEqual(len(snapshot['pending']),1)
        self.assertIn('1 个整体归属待确认',self.window.lb_status.text())
        self.assertEqual(sum(int(self.window.tree.topLevelItem(i).text(1)) for i in range(self.window.tree.topLevelItemCount())),len(instances))
        self.window.tree.expandAll()
        self.assertEqual(json.dumps(self.window.result,ensure_ascii=False,sort_keys=True),before)

    def test_cabinet_templates_are_peers_under_secondary_cabinets(self):
        cabinet=self.entity('cabinet');gateway=self.entity('gateway')
        self.assertEqual(cabinet.parent().parent().text(0),'二次屏柜')
        self.assertIs(cabinet.parent().parent(),gateway.parent().parent())
        self.assertEqual(cabinet.parent().text(0),'主变压器保护B柜')
        self.assertEqual(gateway.parent().text(0),'I区网关机柜')
        neutral=next(n for n in self.nodes() if n.text(0)=='中性点成套设备')
        self.assertEqual(neutral.text(1),'1')
        self.assertFalse(any(n.text(1)=='0' for n in walk(neutral)))

    def test_parts_show_only_after_selecting_an_entity_or_table_instance(self):
        self.assertNotIn('散热器',self.window.prop.toPlainText())
        self.window.tree.setCurrentItem(self.entity('host'))
        self.assertIn('散热器',self.window.prop.toPlainText())
        self.window.tree.setCurrentItem(self.entity('cabinet'))
        self.assertIn('变压器保护装置',self.window.prop.toPlainText())
        self.assertNotIn('散热器',self.window.prop.toPlainText())
        self.window.tree.setCurrentItem(self.entity('cabinet').parent())
        self.assertNotIn('变压器保护装置',self.window.prop.toPlainText())
        self.assertFalse(self.window.table.selectionModel().selectedRows())
        self.window.table.selectRow(0)
        self.assertIn('变压器保护装置',self.window.prop.toPlainText())
        self.window.tree.setCurrentItem(self.entity('host'))
        self.assertIn('散热器',self.window.prop.toPlainText())

    def test_selection_works_when_template_equals_category(self):
        ledger=self.window.result
        row=next(r for r in ledger['rows'] if 'host' in r['entityId'])
        row['template']=row['cat'];self.window._fill_tree(ledger['rows'])
        node=self.entity('host')
        self.assertEqual(node.parent().text(0),'组合电器 GIS')
        self.window.tree.setCurrentItem(node)
        self.assertIn('散热器',self.window.prop.toPlainText())

    def test_cabinet_template_is_kept_when_it_equals_an_omitted_functional_subtype(self):
        ledger=self.window.result
        row=next(r for r in ledger['rows'] if 'cabinet' in r['entityId'])
        row['template']=row['sub'];self.window._fill_tree(ledger['rows'])
        node=self.entity('cabinet')
        self.assertEqual(node.parent().text(0),'主变压器保护柜')
        self.assertEqual(node.parent().parent().text(0),'二次屏柜')

    def test_filter_and_clear_preserve_entity_identity_and_reset_stale_properties(self):
        ids={n.data(0,Qt.UserRole)['entityId'] for n in self.nodes() if (n.data(0,Qt.UserRole) or {}).get('nodeKind')=='entity'}
        self.window.tree.setCurrentItem(self.entity('host'))
        self.window.search.setText('网关');self.window._apply_filter()
        self.assertNotIn('散热器',self.window.prop.toPlainText())
        instances=[n for n in self.nodes() if (n.data(0,Qt.UserRole) or {}).get('nodeKind')=='entity']
        self.assertEqual(len(instances),1)
        self.assertEqual(instances[0].text(0),'I区网关机柜')
        self.assertEqual(self.window.tree.topLevelItem(0).text(1),'1')
        self.window.search.clear();self.window._apply_filter()
        self.assertEqual({n.data(0,Qt.UserRole)['entityId'] for n in self.nodes() if (n.data(0,Qt.UserRole) or {}).get('nodeKind')=='entity'},ids)

    def test_double_click_keeps_all_entity_source_files(self):
        node=self.entity('cabinet');data=node.data(0,Qt.UserRole)
        self.assertEqual(self.window._source_files(data['samples'][0],data),['cabinet.dev','protection.dev'])
        with patch.object(self.window,'_show_source_files') as show:
            self.window._on_tree_double_clicked(node,0)
            show.assert_called_once_with(data['samples'][0],data)

if __name__=='__main__':unittest.main()
