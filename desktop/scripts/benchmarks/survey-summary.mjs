import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {workspacePath} from './samples.mjs';

const metrics=[['firstResponseMs','首次响应'],['firstGeometryMs','首次几何'],
  ['allGeometryReadyMs','基础几何齐备'],['settledMs','完全结算']];
const statuses=['PASS','PARTIAL','INPUT_ERROR','FAIL','INCONCLUSIVE','SKIPPED','ERROR','DUPLICATE','CANCELLED'];
// Table cells contain CJK labels and ASCII values. CJK/full-width glyphs
// occupy two terminal cells, so String.padEnd() alone cannot align them.
const wideCharacter=/[\p{Script=Han}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;
const displayWidth=value=>[...String(value)].reduce((width,char)=>width+(wideCharacter.test(char)?2:1),0);
function terminalTable(headers,rows,rightAligned=[]){
  const widths=headers.map((header,index)=>Math.max(displayWidth(header),...rows.map(row=>displayWidth(row[index]))));
  const border='+'+widths.map(width=>'-'.repeat(width+2)).join('+')+'+';
  const format=row=>'| '+row.map((value,index)=>{
    const text=String(value),padding=' '.repeat(widths[index]-displayWidth(text));
    return rightAligned.includes(index)?padding+text:text+padding;
  }).join(' | ')+' |';
  return [border,format(headers),border,...rows.map(format),border].join('\n');
}
function voltageKv(row){
  if(Number.isFinite(row.voltageKv)&&row.voltageKv>0)return row.voltageKv;
  const name=String(row.sourcePath??row.sampleLabel??'').replaceAll('\\','/').split('/').at(-1);
  const match=name.match(/^(\d+(?:\.\d+)?)\s*(?:kv|千伏|(?=[-_\s]))/i);
  return match&&Number(match[1])>0?Number(match[1]):null;
}

/** Descriptive ranges only; failed and incomplete runs never become fast timings. */
export function summarizeSurvey(batches){
  const counts=Object.fromEntries(statuses.map(status=>[status,0])),groups=new Map();
  const builds=new Set(batches.map(batch=>batch.report.buildFingerprint).filter(Boolean));
  if(builds.size>1)throw Error('Survey reports must belong to the same build');
  for(const {projectType:plannedType,report} of batches){
    if(report.version!=='gim-batch-results-v1'||report.status!=='COMPLETE'||!Array.isArray(report.rows))
      throw Error('Survey requires completed batch reports');
    for(const row of report.rows){
      if(!statuses.includes(row.status))throw Error(`Unfinished or unknown survey status: ${row.status}`);
      counts[row.status]++;
      const projectType=row.projectType??plannedType;
      const voltage=projectType==='substation'?voltageKv(row):null;
      const key=JSON.stringify([projectType,voltage,row.cacheState]);
      if(!groups.has(key))groups.set(key,{projectType,voltageKv:voltage,cacheState:row.cacheState,total:0,valid:0,
        metrics:Object.fromEntries(metrics.map(([name])=>[name,{min:null,max:null,count:0}]))});
      const group=groups.get(key);group.total++;
      if(!['PASS','PARTIAL'].includes(row.status))continue;
      group.valid++;
      for(const [name] of metrics){
        const value=row[name],range=group.metrics[name];
        if(!Number.isFinite(value)||value<0)continue;
        range.min=range.min===null?value:Math.min(range.min,value);
        range.max=range.max===null?value:Math.max(range.max,value);range.count++;
      }
    }
  }
  const order={substation:0,transmission_line:1,equipment:2};
  return {counts,groups:[...groups.values()].sort((a,b)=>(order[a.projectType]??3)-(order[b.projectType]??3)||
    (a.voltageKv??Infinity)-(b.voltageKv??Infinity)||String(a.cacheState??'').localeCompare(String(b.cacheState??'')))};
}
export function formatSurveySummary(summary){
  const countRows=statuses.filter((status,index)=>index<6||summary.counts[status]).map(status=>[status,summary.counts[status]]);
  const lines=['总体测试情况','',terminalTable(['状态','数量'],countRows,[1]),'',
    '时间范围：秒；各项均为 最短 - 最长。'];
  const tables=new Map();
  const rangeText=range=>range.count?`${(range.min/1000).toFixed(3)} - ${(range.max/1000).toFixed(3)}`:'-';
  for(const group of summary.groups){
    const type=({substation:'变电',transmission_line:'线路',equipment:'设备'})[group.projectType]??'未标注';
    const cache=({cold:'冷启动',warm:'暖启动'})[group.cacheState]??'未标注';
    if(!tables.has(type))tables.set(type,{substation:group.projectType==='substation',rows:[]});
    const row=[cache,`${group.valid}/${group.total}`,...metrics.map(([name])=>rangeText(group.metrics[name]))];
    if(group.projectType==='substation')row.unshift(group.voltageKv===null?'未标注':`${group.voltageKv} kV`);
    tables.get(type).rows.push(row);
  }
  for(const [type,table] of tables){
    const headers=[...(table.substation?['电压等级']:[]),'启动','有效/总数',...metrics.map(([,label])=>label)];
    const firstNumberColumn=table.substation?2:1;
    lines.push('',type,'',terminalTable(headers,table.rows,headers.map((_,index)=>index).filter(index=>index>=firstNumberColumn)));
  }
  lines.push('','时间范围仅使用 PASS/PARTIAL 项的已有观测；缺失值显示 -，不填零。',
    '电压等级取报告元数据或文件名中的电压前缀，无法识别时单列未标注；本汇总不执行性能回退判定。');
  return lines.join('\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),batches=[],root=fileURLToPath(new URL('../../../',import.meta.url));
    if(!args.length||args.length%2)throw Error('Use --substation <results.json> or --line <results.json>');
    for(let i=0;i<args.length;i+=2){
      const projectType=({'--substation':'substation','--line':'transmission_line'})[args[i]];
      if(!projectType)throw Error(`Unknown survey group: ${args[i]}`);
      const report=JSON.parse(readFileSync(workspacePath(root,resolve(args[i+1])),'utf8').replace(/^\uFEFF/,''));
      batches.push({projectType,report});
    }
    console.log(formatSurveySummary(summarizeSurvey(batches)));
  }catch(error){console.error(`[survey-summary] ${error.message}`);process.exitCode=1;}
}
