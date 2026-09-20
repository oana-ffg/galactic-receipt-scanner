#!/usr/bin/env python3
"""Create a saved-PP receipt-processing profile without installing OCR inference."""
import argparse
import json
import os
from pathlib import Path
import shutil

from receipt_api import ClientError, ScannerClient, artifact_directory, credentials, write_new_file
from receipt_ppocr_setup import check_layout, check_node, check_renderer, publish_host_descriptor

REPO = Path(__file__).resolve().parent.parent


def ensure_consumer_profile(config, *, node=None, renderer=None):
    client = ScannerClient(credentials(config))
    root = REPO / '.local' / 'receipt-processing-runtime'
    artifact_directory(root)
    node_value = node or shutil.which('node.exe' if os.name == 'nt' else 'node')
    if not node_value:
        raise ClientError('Install Node 22.18+ for the saved-PP receipt worker.')
    node_path = str(Path(node_value).resolve(strict=True))
    check_node(node_path, root)
    renderer_value = renderer or shutil.which('pdftoppm.exe' if os.name == 'nt' else 'pdftoppm')
    if not renderer_value:
        raise ClientError('Install Poppler for saved-PP PDF generation and verification.')
    renderer_path = check_renderer(Path(renderer_value).resolve(strict=True))
    value = dict(origin=client.origin, repository=str(REPO), node=node_path,
                 renderer=renderer_path, confirmation_provider='ppocr')
    candidate = root / ('profile-' + os.urandom(6).hex() + '.json')
    write_new_file(candidate, json.dumps(value).encode())
    client.configure_saved_ppocr(candidate)
    check_layout(client, root)
    prepared = root / 'profile.json'
    os.replace(candidate, prepared)
    return str(prepared)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--node')
    parser.add_argument('--renderer')
    parser.add_argument('--worker-python')
    args = parser.parse_args()
    profile = ensure_consumer_profile(args.config, node=args.node, renderer=args.renderer)
    descriptor = publish_host_descriptor(profile, args.worker_python,
                                         name='processing-host.json', include_config=False)
    print(json.dumps({'profile': profile, 'descriptor': descriptor}))


if __name__ == '__main__':
    main()
