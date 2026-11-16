"""Package the independent service alongside (not inside) the GUI executable."""
import argparse
from pathlib import Path
import shutil

def main():
    tool=Path(__file__).resolve().parent
    parser=argparse.ArgumentParser()
    parser.add_argument('--bundle',default=str(tool/'dist/gim_blender'))
    args=parser.parse_args();bundle=Path(args.bundle).resolve()
    if not (bundle/'gim_blender.exe').is_file():raise ValueError('GUI build missing')
    (bundle/'runtime').mkdir(exist_ok=True)
    shutil.copy2(tool/'assets/runtime/node.exe',bundle/'runtime/node.exe')
    shutil.copytree(tool/'assets/web',bundle/'demo',dirs_exist_ok=True)
    shutil.copytree(tool/'server',bundle/'server',dirs_exist_ok=True,ignore=shutil.ignore_patterns('*.test.cjs'))
    for name in ['start_demo.cmd','stop_demo.cmd','README.md','THIRD_PARTY.md','snapshot.json']:
        shutil.copy2(tool/name,bundle/name)

if __name__=='__main__':main()
