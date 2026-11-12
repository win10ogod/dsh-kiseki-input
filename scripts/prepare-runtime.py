"""Package the verified portable archives from a downloaded GitHub Actions run."""
import argparse, hashlib, json, shutil, subprocess, tarfile, tempfile, zipfile
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--artifacts', type=Path, required=True)
p.add_argument('--source', type=Path, required=True)
p.add_argument('--run', default='36242815724')
a = p.parse_args()
root = Path(__file__).resolve().parents[1]
platforms = {'Windows-x64': 'win32-x64', 'Linux-x64': 'linux-x64', 'Linux-arm64': 'linux-arm64', 'macOS-x64': 'darwin-x64', 'macOS-arm64': 'darwin-arm64'}
manifest = {'repository': 'win10ogod/kiseki-input', 'runId': a.run, 'commit': subprocess.check_output(['git', '-C', str(a.source), 'rev-parse', 'HEAD'], text=True).strip(), 'platforms': {}}
for label, platform in platforms.items():
    archives = list((a.artifacts / ('packages-' + label)).glob('*.zip' if platform.startswith('win') else '*.tar.gz'))
    if len(archives) != 1: raise ValueError(f'Expected one portable archive for {label}')
    archive = archives[0]
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    expected = Path(str(archive) + '.sha256').read_text().split()[0]
    if digest != expected: raise ValueError(f'Checksum failed: {archive}')
    target = root / 'runtime' / platform
    with tempfile.TemporaryDirectory() as directory:
        if archive.suffix == '.zip':
            with zipfile.ZipFile(archive) as z: z.extractall(directory)
        else:
            with tarfile.open(archive) as t: t.extractall(directory, filter='data')
        exe = next(Path(directory).rglob('kiseki.exe' if platform.startswith('win') else 'kiseki'))
        if not exe.is_file(): raise ValueError(f'Executable not found: {platform}')
        prefix = exe.parent.parent
        target.mkdir(parents=True, exist_ok=True)
        shutil.copytree(prefix / 'bin', target / 'bin', dirs_exist_ok=True)
        shutil.copytree(prefix / 'share' / 'kiseki', target / 'share' / 'kiseki', dirs_exist_ok=True)
        (target / 'bin' / exe.name).chmod(0o755)
    manifest['platforms'][platform] = {'archive': archive.name, 'sha256': digest, 'executable': f'runtime/{platform}/bin/{exe.name}'}
(root / 'runtime' / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
# Keep upstream skills and relative documentation links intact.
for folder in ('skills', 'docs'):
    shutil.copytree(a.source / folder, root / 'assets' / 'upstream' / folder, dirs_exist_ok=True)
print(json.dumps(manifest, indent=2))
