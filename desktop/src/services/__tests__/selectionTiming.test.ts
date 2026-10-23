import {expect,it} from 'vitest';
import {AppState} from '../../app/state.js';
import {perfReset,perfSnapshot} from '../../utils/perfTimings.js';
import {beginSelectionStage} from '../selectionTiming.js';

it('correlates stage wall times with selection identity and settles each observation once',()=>{
  const state=new AppState();state.activateProject(1,'source');perfReset();
  const request=state.beginSelection({kind:'cbm',key:'A'});
  const end=beginSelectionStage(state,request,'collectGroups');end();end();
  const spans=perfSnapshot().spans.filter(span=>span.label==='selection.collectGroups');
  expect(spans).toHaveLength(1);expect(spans[0].meta).toMatchObject({selectionId:request.id,sourcePath:'A',current:true,cancelled:false});
});
it('records stale same-project work as cancelled, and drops late stages from a reset project',()=>{
  const state=new AppState();state.activateProject(1,'source');perfReset();
  const request=state.beginSelection({kind:'cbm',key:'A'});
  const old=beginSelectionStage(state,request,'propertySummary');state.beginSelection({kind:'cbm',key:'B'});old();
  expect(perfSnapshot().spans[0].meta).toMatchObject({selectionId:request.id,current:false,cancelled:true});
  const previous=beginSelectionStage(state,state.selectionRequest!,'propertyParams');
  state.activateProject(2,'next');perfReset();previous();expect(perfSnapshot().spans).toHaveLength(0);
});
