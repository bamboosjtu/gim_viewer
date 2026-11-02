"""Rebuild a verified research reference in output/, without replacing research assets."""
import argparse
import csv
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / 'research/scripts'
sys.path.insert(0, str(SCRIPTS))
from engineering_units import load_sources, run, write_json, SAMPLES


def csv_rows(path):
    with gzip.open(path, 'rt', encoding='utf-8') as stream:
        return list(csv.DictReader(stream))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=ROOT / 'output/refactor-baseline')
    args = parser.parse_args()
    scan = ROOT / 'research/data/nine-projects'
    wholes = args.out / 'engineering-wholes'
    summaries = [run(sid, argparse.Namespace(input=scan, out=wholes)) for sid, _ in SAMPLES]
    write_json(wholes / 'summary.json', summaries)
    subprocess.run([sys.executable, str(SCRIPTS / 'verify_engineering_units.py'), '--data', str(wholes), '--scan', str(scan)], check=True)
    for sid, _ in SAMPLES:
        folder = wholes / sid
        source_links = json.loads((scan / sid / 'source-links.json').read_text(encoding='utf-8'))
        entities = csv_rows(folder / 'engineering-entities.csv.gz')
        for entity in entities:
            entity['source_members'] = json.loads(entity['source_members'])
        value = dict(
            sources=load_sources(scan / sid),
            sourceAliases=source_links['dev_aliases'],
            entities=entities,
            memberships=csv_rows(folder / 'source-memberships.csv.gz'),
            pending=json.loads((folder / 'pending-wholes.json').read_text(encoding='utf-8')),
            aliases=json.loads((folder / 'source-aliases.json').read_text(encoding='utf-8')),
            relations=json.loads((folder / 'relations.json').read_text(encoding='utf-8')),
        )
        dest = args.out / 'nine-projects' / (sid + '.json.gz')
        dest.parent.mkdir(parents=True, exist_ok=True)
        with gzip.GzipFile(filename=str(dest), mode='wb', mtime=0) as stream:
            stream.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    write_json(args.out / 'manifest.json', dict(
        scope='raw-source-to-engineering-whole reference, not rendering acceptance',
        rules_sha256=hashlib.sha256((SCRIPTS / 'engineering_units.py').read_bytes()).hexdigest(),
        packages=[dict(sample=s['sample'], source=s['source'], scan_sha256=s['input_scan_sha256']) for s in summaries],
    ))


if __name__ == '__main__':
    main()
