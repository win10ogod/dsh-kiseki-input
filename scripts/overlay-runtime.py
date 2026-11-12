"""Overlay a tested local build while retaining the originating Actions manifest."""
import argparse, hashlib, json, shutil, subprocess
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--source',type=Path,required=True)
p.add_argument('--executable',type=Path,required=True)
p.add_argument('--platform',required=True)
a=p.parse_args()
root=Path(__file__).resolve().parents[1]
manifest_path=root/'runtime/manifest.json'
m=json.loads(manifest_path.read_text())
entry=m['platforms'][a.platform]
patch=subprocess.check_output(['git','-C',str(a.source),'diff','--binary','HEAD'])
(root/'runtime/kiseki-cua-update.patch').write_bytes(patch)
shutil.copy2(a.executable,root/entry['executable'])
entry['localBuild']={'baseCommit':subprocess.check_output(['git','-C',str(a.source),'rev-parse','HEAD'],text=True).strip(),'patch':'runtime/kiseki-cua-update.patch','patchSha256':hashlib.sha256(patch).hexdigest(),'executableSha256':hashlib.sha256(a.executable.read_bytes()).hexdigest(),'configuration':'Release','cuaDriverTested':'0.30.1'}
manifest_path.write_text(json.dumps(m,indent=2)+'\n')
for directory in ('skills','docs'):
 shutil.copytree(a.source/directory,root/'assets/upstream'/directory,dirs_exist_ok=True)
 shutil.copytree(a.source/directory,root/'runtime'/a.platform/'share/kiseki'/directory,dirs_exist_ok=True)
