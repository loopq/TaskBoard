#!/usr/bin/env python3
"""白名单源码包；manifest 的 hash 同时标识未提交代码和前端构建。"""
import gzip
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile

root = pathlib.Path(__file__).resolve().parents[1]
names = {
    'Dockerfile', '.dockerignore', 'api/package.json', 'api/schema.sql',
    'api/test/rules.sh', 'deploy/compose.yaml', 'deploy/package-release.py',
    'deploy/ssh.sh', 'deploy/deploy.sh', 'deploy/setup.sh',
    'deploy/server/taskboard-release', 'deploy/server/taskboard-setup',
    'deploy/server/taskboard-backup', 'deploy/server/taskboard-set-password',
    'deploy/systemd/taskboard-backup.service', 'deploy/systemd/taskboard-backup.timer',
}
for directory in ('api/src', 'web/dist'):
    for path in (root / directory).rglob('*'):
        if path.is_symlink():
            raise SystemExit(f'Symlink forbidden: {path}')
        if path.is_file():
            names.add(path.relative_to(root).as_posix())
if not (root / 'web/dist/index.html').is_file():
    raise SystemExit('Build web first')
for name in names:
    if (root / name).is_symlink() or not (root / name).is_file():
        raise SystemExit(f'Not a regular file: {name}')
manifest = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sorted(names)}
revision = subprocess.run(
    ['git', '-C', str(root), 'rev-parse', '--verify', '--quiet', 'HEAD'],
    check=False, text=True, capture_output=True,
).stdout.strip() or None  # 仓库尚无首次提交时，仍用内容 hash 标识发布。
metadata = json.dumps({'git_base': revision, 'files': manifest}, sort_keys=True, indent=2).encode()
release = hashlib.sha256(metadata).hexdigest()[:20]
out = root / 'artifacts'
out.mkdir(exist_ok=True)
with (out / f'{release}.tar.gz').open('wb') as dest:
    with gzip.GzipFile(filename='', fileobj=dest, mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for name in sorted(names):
                path = root / name
                info = archive.gettarinfo(str(path), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mtime = 0
                info.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
                with path.open('rb') as source:
                    archive.addfile(info, source)
            info = tarfile.TarInfo('release-manifest.json')
            info.size = len(metadata)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(metadata))
(out / f'{release}.manifest.json').write_bytes(metadata)
print(release)
