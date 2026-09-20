#!/usr/bin/env python3
"""Resume PP OCR for every unfinished current capture saved before this run."""
import argparse
from datetime import date, datetime, time as daytime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from receipt_api import (ClientError, ScannerClient, SHA, UUID, artifact_directory,
                         credentials, matches_prepared_ocr, run_jev_backfill, write_new_file)
from receipt_locks import acquire_lock, LockBusy
from receipt_ppocr_setup import REPO, discover, ensure_profile


def save_json(path, value):
    temporary = path.with_name(path.name + '-' + os.urandom(6).hex())
    write_new_file(temporary, json.dumps(value, ensure_ascii=False).encode('utf-8'))
    os.replace(temporary, path)


def fingerprint(capture):
    value = {key: capture.get(key) for key in ('id', 'sha256', 'manual_outline')}
    value['quad'] = ((capture.get('metadata') or {}).get('quality') or {}).get('quad')
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def utc(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ClientError('Capture timestamp is missing its timezone.')
    return result.astimezone(timezone.utc)


def day_window(day, zone):
    tz = ZoneInfo(zone)
    start = datetime.combine(day, daytime.min, tzinfo=tz)
    end = datetime.combine(day + timedelta(days=1), daytime.min, tzinfo=tz)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def scan_window(day, zone, now):
    """Use an explicit calendar day only when requested; normal catch-up runs through now."""
    scan_day = day or now.date()
    start, end = day_window(scan_day, zone)
    return scan_day, start, end if day is not None else now.astimezone(timezone.utc)


def inventory(client, end):
    """Follow all cursor pages, including old failures; freeze this run's scan cutoff."""
    found, cursors, cursor = {}, set(), None
    while True:
        query = dict(limit=100, current=1)
        if cursor:
            query['before'] = cursor
        result = client.get('/api/captures?' + urlencode(query))
        for capture in result['captures']:
            if (capture.get('is_current') is True and capture.get('status') in {'accepted', 'manual-review'}
                    and utc(capture['created_at']) < end):
                found[capture['id']] = capture
        cursor = result.get('next')
        if not cursor:
            break
        if cursor in cursors:
            raise ClientError('Repeated capture cursor; inventory is incomplete.')
        cursors.add(cursor)
    return sorted(found.values(), key=lambda item: (item['created_at'], item['id']))


def needs_ocr(capture):
    status = capture.get('ocr_status')
    if status not in {'awaiting Work', 'unverified'}:
        raise ClientError('Capture inventory returned an invalid OCR status.')
    return status == 'awaiting Work'


class CachedBackend:
    """Reuse a generated artifact after uncertain/failed upload, even across restarts."""
    engine = 'PP-OCRv6'

    def __init__(self, backend, directory):
        self.backend, self.directory = backend, directory
        artifact_directory(directory)

    def run(self, manifest, output):
        source = json.loads(Path(manifest).read_text(encoding='utf-8'))
        key = {k: source.get(k) for k in ('capture_id', 'sha256', 'crop', 'rotation')}
        digest = hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()
        pointer = self.directory / (digest + '.json')
        if pointer.exists():
            saved = json.loads(pointer.read_text(encoding='utf-8'))
            artifact = self.directory / (saved['sha256'] + '.ocr.json')
            data = artifact.read_bytes()
            if hashlib.sha256(data).hexdigest() != saved['sha256']:
                raise ClientError('Pending OCR checksum mismatch; preserve the cache and investigate.')
            if not matches_prepared_ocr(json.loads(data), source['capture_id'], source['sha256'],
                                        source['crop'], self, source['rotation']):
                raise ClientError('Pending OCR does not match the current source layout.')
            write_new_file(Path(output), data)
            return
        self.backend.run(manifest, output)
        data = Path(output).read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        artifact = self.directory / (sha + '.ocr.json')
        if not artifact.exists():
            write_new_file(artifact, data)
        save_json(pointer, {'sha256': sha})


def is_access_failure(error):
    return isinstance(error, ClientError) and ('HTTP 401' in str(error) or 'HTTP 403' in str(error))


def read_requirement(path, origin):
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    if (not isinstance(value, dict) or set(value) != {'origin', 'capture_id', 'source_sha256', 'crop', 'rotation'}
            or value['origin'] != origin or not isinstance(value['capture_id'], str)
            or not UUID.fullmatch(value['capture_id']) or not isinstance(value['source_sha256'], str)
            or not SHA.fullmatch(value['source_sha256']) or type(value['rotation']) is not int
            or value['rotation'] not in (0, 90, 180, 270)):
        raise ClientError('Invalid or differently scoped OCR request.')
    crop = value['crop']
    if crop is not None and (not isinstance(crop, list) or len(crop) != 4
            or any(type(v) is not int for v in crop) or not (0 <= crop[0] < crop[2] and 0 <= crop[1] < crop[3])):
        raise ClientError('Invalid requested OCR crop.')
    return value


def prepare_requirement(client, value, root):
    """Also fulfill Luna's exact region, which may differ from the standard scan outline."""
    cid = value['capture_id']
    original = client.original(cid, root / 'originals')
    if original['sha256'] != value['source_sha256']:
        raise ClientError('Requested OCR source hash changed; preserve the Luna claim for review.')
    prepared = client.prepare(cid, root / 'required', crop=value['crop'], rotation=value['rotation'])
    if prepared['sha256'] != value['source_sha256']:
        raise ClientError('Prepared OCR source does not match the Luna request.')
    return dict(capture_id=cid, ocr_sha256=prepared['ocr_sha256'], verified=True)


def finish_jev(client):
    """Drain hosted Jev work without copying document identifiers into the OCR summary."""
    result = run_jev_backfill(client)
    fields = ('complete', 'deferred', 'waiting', 'processed', 'remaining', 'phase', 'blocked')
    return {key: result[key] for key in fields if key in result}


def drain(client, captures, root, state, *, attempts=3, sleep=time.sleep, emit=print):
    """Try every scan before retrying individual failures; an access loss blocks further writes."""
    pending = captures
    errors = {}
    verified, reused, retired = set(), set(), set()
    consecutive_network_failures = 0
    for attempt in range(1, attempts + 1):
        retry = []
        for capture in pending:
            cid = capture['id']
            try:
                current = client.get('/api/captures/' + cid)
                if not current.get('is_current') or current.get('status') not in {'accepted', 'manual-review'}:
                    retired.add(cid)
                    errors.pop(cid, None)
                    consecutive_network_failures = 0
                    continue
                signature = fingerprint(current)
                prior = state['completed'].get(cid)
                if (prior and prior['fingerprint'] == signature and
                        any(a.get('kind') == 'ocr' and a.get('sha256') == prior['ocr_sha256']
                            for a in current.get('artifacts', []))):
                    reused.add(cid)
                    errors.pop(cid, None)
                    consecutive_network_failures = 0
                    continue
                prepared = client.prepare(cid, root / 'artifacts')
                # If an outline changed while OCR was running, keep the artifact but retry the new layout.
                latest = client.get('/api/captures/' + cid)
                if fingerprint(latest) != signature:
                    raise ClientError('Source layout changed during OCR; retry with current metadata.')
                state['completed'][cid] = dict(fingerprint=signature, ocr_sha256=prepared['ocr_sha256'])
                save_json(root / 'progress.json', state)
                verified.add(cid)
                consecutive_network_failures = 0
                errors.pop(cid, None)
                emit(json.dumps(dict(event='ocr_verified', capture_id=cid, attempt=attempt,
                                     ocr_sha256=prepared['ocr_sha256'])), flush=True)
            except (ClientError, OSError, ValueError, subprocess.SubprocessError) as error:
                # Neither receipt content nor a subprocess's potentially sensitive stderr goes to chat.
                message = str(error) if isinstance(error, ClientError) else type(error).__name__
                errors[cid] = dict(attempt=attempt, error=message)
                network_failure = isinstance(error, ClientError) and str(error).startswith('Scanner connection failed;')
                consecutive_network_failures = consecutive_network_failures + 1 if network_failure else 0
                save_json(root / 'failures.json', errors)
                emit(json.dumps(dict(event='ocr_failed', capture_id=cid, attempt=attempt, error=message)), flush=True)
                if is_access_failure(error) or consecutive_network_failures >= 3:
                    return dict(complete=False, blocked='authorization' if is_access_failure(error) else 'connectivity', selected=len(captures),
                                verified=len(verified), reused=len(reused), retired=len(retired), failures=errors,
                                remaining=len(captures) - len(verified | reused | retired))
                retry.append(capture)
        pending = retry
        if not pending:
            break
        if attempt < attempts:
            sleep(min(30, attempt * 5))
    save_json(root / 'failures.json', errors)
    return dict(complete=not pending, selected=len(captures), verified=len(verified), reused=len(reused),
                retired=len(retired), failures=errors, remaining=len(pending))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--worker-profile')
    parser.add_argument('--timezone', default='Europe/Copenhagen')
    parser.add_argument('--date', type=date.fromisoformat,
                        help='Explicit historical calendar-day scope; normal runs catch up through now')
    parser.add_argument('--cpu', action='store_true', help='Install/use CPU even when a GPU profile is configured')
    parser.add_argument('--node')
    parser.add_argument('--inventory-only', action='store_true', help='Read-only inventory; no runtime installation or OCR')
    parser.add_argument('--request', help='Worker OCR request file: catch up all current scans through now, then this exact layout')
    parser.add_argument('--limit', type=int, help='Explicit diagnostic subset only; omitted for normal unlimited runs')
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error('--limit must be positive')
    if args.request and (args.date or args.limit or args.inventory_only):
        parser.error('--request requires the full current backlog, without date, limit or inventory-only')
    os.chdir(REPO)
    config, profile = discover(args.config, args.worker_profile)
    client = ScannerClient(credentials(config))
    requirement = read_requirement(args.request, client.origin) if args.request else None
    access = client.get('/api/processing/access')
    capabilities = set(access.get('capabilities', []))
    if not {'save_ocr_artifacts', 'jev_classification'} <= capabilities:
        raise ClientError('Processing access was not confirmed.')
    # Only public timezone data is installed here; no receipt is sent to an inference provider.
    try:
        tz = ZoneInfo(args.timezone)
    except ZoneInfoNotFoundError:
        if args.inventory_only:
            raise ClientError('Install tzdata in this Python runtime for calendar-day inventory.') from None
        setup_root = REPO / '.local' / 'receipt-ppocr-runtime'
        artifact_directory(setup_root)
        from receipt_ppocr_setup import run_logged
        run_logged([sys.executable, '-m', 'pip', 'install', 'tzdata>=2025.2,<2027'], setup_root, 'install-timezones')
        tz = ZoneInfo(args.timezone)
    now = datetime.now(tz)
    day, start, end = scan_window(args.date, args.timezone, now)
    captures = inventory(client, end)
    awaiting_ocr = [capture for capture in captures if needs_ocr(capture)]
    summary = dict(scan_day=day.isoformat(), timezone=args.timezone, cutoff=end.isoformat(), eligible=len(captures),
                   scanned_that_day=sum(utc(c['created_at']) >= start for c in captures),
                   older_backlog_checked=sum(utc(c['created_at']) < start for c in captures),
                   ocr_available=len(captures) - len(awaiting_ocr), ocr_missing=len(awaiting_ocr))
    print(json.dumps(dict(event='inventory', **summary)), flush=True)
    if args.inventory_only:
        return 0
    root = REPO / '.local' / 'receipt-ocr-nightly' / hashlib.sha256(client.origin.encode()).hexdigest()[:16]
    artifact_directory(root)
    with acquire_lock(root / 'nightly.lock'):
        profile = ensure_profile(config, profile, force_cpu=args.cpu, node=args.node)
        client.configure_ppocr(profile)
        client.ocr_backend = CachedBackend(client.ocr_backend, root / 'pending')
        state_path = root / 'progress.json'
        state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else dict(origin=client.origin, completed={})
        if state['origin'] != client.origin:
            raise ClientError('OCR progress belongs to a different Site.')
        selected = awaiting_ocr[:args.limit] if args.limit else awaiting_ocr
        # Save the immutable snapshot before starting; an interrupted run remains diagnosable.
        write_new_file(root / ('inventory-' + os.urandom(6).hex() + '.json'), json.dumps(captures).encode())
        result = drain(client, selected, root, state)
        if requirement:
            result['required_ocr'] = dict(verified=False, capture_id=requirement['capture_id'])
            if not result.get('blocked'):
                try:
                    result['required_ocr'] = prepare_requirement(client, requirement, root)
                except (ClientError, OSError, ValueError, subprocess.SubprocessError) as error:
                    result['required_ocr']['error'] = str(error) if isinstance(error, ClientError) else type(error).__name__
            if not result['required_ocr']['verified']:
                result['complete'] = False
        result.update(summary)
        result['limited'] = args.limit is not None and len(selected) < len(awaiting_ocr)
        if result['limited']:
            result['complete'] = False
        if result.get('blocked'):
            result['jev'] = dict(complete=False, skipped=True, reason=result['blocked'])
        else:
            try:
                result['jev'] = finish_jev(client)
            except ClientError as error:
                result['jev'] = dict(complete=False, error=str(error))
        if not result['jev'].get('complete'):
            result['complete'] = False
        print(json.dumps(dict(event='jev_finished', **result['jev'])), flush=True)
        save_json(root / 'last-run.json', result)
        print(json.dumps(dict(event='finished', **result)), flush=True)
        return 0 if result['complete'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except LockBusy:
        print(json.dumps(dict(complete=False, error='Another nightly OCR process is active; preserve it.')))
        sys.exit(2)
    except ClientError as error:
        print(json.dumps(dict(complete=False, error=str(error))))
        sys.exit(1)
