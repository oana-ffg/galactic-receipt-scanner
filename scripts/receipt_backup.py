#!/usr/bin/env python3
"""Append-only original backup for POSIX hosts. No model calls or remote writes."""
import argparse
from datetime import datetime, timezone
import json
import os
import stat
from pathlib import Path
import sys
from urllib.parse import quote

from receipt_api import ClientError, ScannerClient, credentials, write_new_file


def require_posix():
    if os.name != 'posix':
        raise ClientError('Original backups require a POSIX host (Linux/macOS) and filesystem '
                          'with Unix ownership, permissions and locking; native Windows is unsupported.')


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077):
        raise ClientError('Backup directories must be private real directories owned by this user.')


def backup(client, destination):
    require_posix()
    import fcntl

    root = Path(destination)
    private_directory(root)
    for child in ('snapshots', 'originals'):
        private_directory(root / child)
        if (root / child).stat().st_dev != root.stat().st_dev:
            raise ClientError('Backup subdirectories must stay on the destination filesystem.')
    lock_fd = os.open(root / '.backup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'r+') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ClientError('Backup lock must be a private regular file.')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ClientError('Another backup is running.') from None
        snapshots = root / 'snapshots'
        previous = set()
        # A missing remote capture must never silently disappear from backup accounting.
        manifests = sorted(snapshots.glob('*.json'))
        if manifests:
            if manifests[-1].is_symlink() or not manifests[-1].is_file():
                raise ClientError('Backup snapshot must be a regular file, not a symbolic link.')
            last = json.loads(manifests[-1].read_text())
            if last['origin'] != client.origin:
                raise ClientError('Backup folder belongs to a different Site.')
            previous.update(row['id'] for row in last['captures'])
            previous.update(last['missing_remote'])
        rows, seen, cursors = [], set(), set()
        path = '/api/captures?limit=100'
        while path:
            page = client.get(path)
            for row in page['captures']:
                if row['id'] in seen:
                    raise ClientError('Duplicate capture in backup enumeration.')
                seen.add(row['id'])
                rows.append(row)
            cursor = page.get('next')
            if cursor and cursor in cursors:
                raise ClientError('Repeated backup pagination cursor.')
            cursors.add(cursor)
            path = '/api/captures?limit=100&before=' + quote(cursor, safe='') if cursor else None
        failures, originals, downloaded = [], [], 0
        for row in rows:
            try:
                meta = row if 'bytes' in row and 'content_type' in row else None
                original = client.original(row['id'], root / 'originals', metadata=meta)
                if original['sha256'] != row['sha256'] or original['scanned_at'] != row['created_at']:
                    raise ClientError('Original differs from enumeration snapshot.')
                downloaded += not original['cached']
                originals.append({**original, 'path': str(Path(original['path']).relative_to(root))})
            except (ClientError, OSError) as error:
                failures.append({'capture_id': row['id'], 'error': str(error)})
        missing = sorted(previous - seen)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        report = {'created_at': stamp, 'origin': client.origin, 'captures': rows,
                  'originals': originals, 'failures': failures, 'missing_remote': missing,
                  'complete': not failures and not missing}
        write_new_file(snapshots / (stamp + '.json'), json.dumps(report, indent=2).encode())
        # Flush all pending filesystem writes before acknowledging backup completion.
        os.sync()
        return {'complete': report['complete'], 'captures': len(rows),
                'verified': len(originals), 'downloaded': downloaded,
                'failures': len(failures), 'missing_remote': len(missing),
                'manifest': str(snapshots / (stamp + '.json'))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--mount-root', required=True)
    parser.add_argument('--credentials-stdin', action='store_true')
    parser.add_argument('--config', default='.local/processing-access.json')
    args = parser.parse_args()
    require_posix()
    root, mount = Path(args.destination), Path(args.mount_root)
    if (not root.is_absolute() or not mount.is_absolute() or not os.path.ismount(mount)
            or mount.is_symlink() or root.is_symlink() or mount.resolve() not in root.resolve().parents):
        raise ClientError('Backup drive is not mounted at the expected location; nothing was written.')
    # Refuse redirecting any existing path component away from the mounted destination.
    if any(part.is_symlink() for part in [root, *root.parents] if part != mount.parent):
        raise ClientError('Backup destination contains a symbolic link.')
    os.umask(0o077)
    result = backup(ScannerClient(credentials(args.config, args.credentials_stdin)), root)
    print(json.dumps(result))
    return 0 if result['complete'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ClientError, OSError, ValueError, KeyError) as error:
        print('Backup failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
