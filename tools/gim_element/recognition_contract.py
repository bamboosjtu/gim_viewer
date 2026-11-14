"""JSON source-record contract runner; uses only the standalone tool."""
import json,sys
from standard_recognition import normalize

def recognize(records,scope):
    rows=[]
    for record in records:
        row=dict(record)
        row['properties']=[dict(p,keys=p.get('keys',[]),path=p.get('path',p.get('source')),line=p.get('line',i)) for i,p in enumerate(row['properties'])]
        if row.get('attributeOnly'):
            hosts=[r for r in row.get('relations',[]) if r['kind']=='host']
            row['declaredHosts']=[r['targetSourceId'] for r in hosts]
            row['declaredHostEvidence']={r['targetSourceId']:r['evidence'] for r in hosts}
        rows.append(row)
    return normalize(rows,scope)

if __name__=='__main__':
    sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
    request=json.load(sys.stdin)
    json.dump(recognize(request['records'],request['scope']),sys.stdout,ensure_ascii=False)
