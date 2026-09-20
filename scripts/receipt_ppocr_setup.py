#!/usr/bin/env python3
"""Install an isolated CPU PP-OCRv6 runtime, or reuse a working prepared profile."""
import argparse
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from urllib.request import urlopen
import venv

from receipt_api import ClientError, ScannerClient, artifact_directory, credentials, write_new_file

REPO = Path(__file__).resolve().parent.parent
PACKAGES = ['paddlepaddle==3.3.1', 'paddleocr==3.7.0', 'paddlex[ocr]==3.7.2',
            'PyMuPDF==1.26.7', 'Pillow==12.3.0', 'tzdata>=2025.2,<2027']
MODELS = {
    'det': '144d0621e059566e5086e228829171591c144c2deb07b2dad4962214fbabfcf7',
    'rec': '4eecc1c6a4623765042e6fc15446da0da110b7d875b6b72b2d351d2b2dbd4da6',
}


def run_logged(command, root, label, timeout=1800):
    log = root / (label + '-' + os.urandom(6).hex() + '.log')
    with log.open('xb') as stream:
        environment = os.environ.copy()
        # Do not inherit unrelated host package mirrors or change their global configuration.
        environment['PIP_CONFIG_FILE'] = os.devnull
        environment.pop('PIP_EXTRA_INDEX_URL', None)
        result = subprocess.run(command, cwd=REPO, stdout=stream, stderr=stream,
                                timeout=timeout, env=environment)
    if result.returncode:
        raise ClientError(f'{label} failed; inspect {log} and repair the installation.')


def install_models(root):
    artifact_directory(root)
    for kind, expected in MODELS.items():
        name = f'PP-OCRv6_medium_{kind}_infer'
        archive = root / (name + '.tar')
        if not archive.exists():
            url = ('https://paddle-model-ecology.bj.bcebos.com/paddlex/'
                   f'official_inference_model/paddle3.0.0/{name}.tar')
            with urlopen(url, timeout=180) as response:
                data = response.read(160 * 1024 * 1024 + 1)
            if hashlib.sha256(data).hexdigest() != expected:
                raise ClientError('Downloaded PP model checksum mismatch; no model installed.')
            write_new_file(archive, data)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise ClientError(f'PP archive checksum mismatch: {archive}. Preserve and investigate it.')
        # Extract only verified regular files, without overwriting a different installation.
        with tarfile.open(archive) as bundle:
            for member in bundle.getmembers():
                target = (root / member.name).resolve()
                if (not target.is_relative_to((root / name).resolve()) or
                        not (member.isfile() or member.isdir())):
                    raise ClientError('Unsafe PP model archive member.')
                if member.isdir():
                    artifact_directory(target)
                    continue
                body = bundle.extractfile(member).read()
                artifact_directory(target.parent)
                if target.exists():
                    if target.read_bytes() != body:
                        raise ClientError(f'Existing PP model differs: {target}. Preserve it for diagnosis.')
                else:
                    write_new_file(target, body)


def discover(config=None, profile=None):
    descriptor = REPO / '.local' / 'receipt-ocr-host.json'
    if profile is None and config is None:
        candidates = [descriptor, REPO / '.local' / 'processing-host.json']
        for candidate in candidates:
            if candidate.exists() and candidate.is_file() and not candidate.is_symlink() and not candidate.is_junction():
                host = json.loads(candidate.read_text(encoding='utf-8'))
                value = host.get('worker_profile')
                if isinstance(value, str):
                    settings = json.loads(Path(value).read_text(encoding='utf-8'))
                    if isinstance(settings.get('ppocr'), dict):
                        profile = value
                        descriptor_config = host.get('client_config')
                        if isinstance(descriptor_config, str):
                            config = descriptor_config
                        break
    settings = json.loads(Path(profile).read_text(encoding='utf-8')) if profile else {}
    config = config or settings.get('client_config')
    if not config:
        raise ClientError('No receipt connection configured. Follow the receipt-data-access skill to authorize this host.')
    return str(Path(config).resolve(strict=True)), profile


def check_node(node, root):
    result = subprocess.run([str(node), '--version'], capture_output=True, text=True, timeout=30)
    version = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)\s*', result.stdout)
    if result.returncode or not version or tuple(map(int, version.groups())) < (22, 18, 0):
        raise ClientError('Install Node 22.18+ for the shared TypeScript crop geometry, then rerun setup.')
    if not (REPO / 'node_modules' / 'pdf-lib').exists():
        npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
        if not npm:
            raise ClientError('npm is unavailable; install the project dependencies with npm ci, then rerun.')
        run_logged([npm, 'ci', '--no-audit', '--no-fund'], root, 'install-node')


def check_renderer(renderer):
    path = Path(renderer)
    if (not path.is_absolute() or not path.is_file() or path.is_symlink() or path.is_junction()
            or (os.name != 'nt' and not os.access(path, os.X_OK))
            or path.name.lower() not in {'pdftoppm', 'pdftoppm.exe'}):
        raise ClientError('Install Poppler and provide its prepared absolute pdftoppm executable.')
    result = subprocess.run([str(path), '-v'], capture_output=True, timeout=30)
    if result.returncode:
        raise ClientError('The prepared PDF renderer is unavailable.')
    return str(path)


def check_layout(client, root):
    # Local synthetic data only. Exercise the real layout script, imports and runtime.
    data = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhFcAAAAASUVORK5CYII=')
    path = root / 'layout-preflight.png'
    if not path.exists():
        write_new_file(path, data)
    crop = client.source_region(dict(path=str(path), sha256=hashlib.sha256(data).hexdigest(), quad=None), root)
    if crop != [0, 0, 1, 1]:
        raise ClientError('Synthetic crop preflight returned unexpected bounds.')


def ensure_profile(config, profile=None, *, force_cpu=False, node=None):
    client = ScannerClient(credentials(config))
    root = REPO / '.local' / 'receipt-ppocr-runtime'
    artifact_directory(root)
    if profile and not force_cpu:
        try:
            client.configure_ppocr(Path(profile).resolve())
            check_node(client.node, root)
            check_layout(client, root)
            client.ocr_backend.preflight()
            return str(Path(profile).resolve())
        except (ClientError, OSError, subprocess.SubprocessError) as error:
            print(json.dumps({'event': 'prepared_runtime_unavailable', 'error_type': type(error).__name__,
                              'next': 'install isolated CPU runtime'}), flush=True)
    prepared = root / 'profile.json'
    if prepared.exists():
        try:
            client.configure_ppocr(prepared)
            check_node(client.node, root)
            check_layout(client, root)
            client.ocr_backend.preflight()
            return str(prepared)
        except (ClientError, OSError, subprocess.SubprocessError):
            pass  # Repair packages/models below; preserve the previous profile.
    if not (3, 12) <= sys.version_info[:2] <= (3, 13):
        raise ClientError('Run setup with Python 3.12 or 3.13, supported by the pinned Paddle wheels.')
    environment = root / 'cpu-venv'
    executable = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not executable.exists():
        venv.EnvBuilder(with_pip=True, symlinks=False).create(environment)
    run_logged([str(executable), '-m', 'pip', '--isolated', 'install', '--index-url',
                'https://pypi.org/simple', '--disable-pip-version-check', *PACKAGES], root, 'install-pp')
    run_logged([str(executable), '-m', 'pip', 'check'], root, 'check-pp')
    install_models(root / 'models')
    node_path = node or shutil.which('node')
    if not node_path:
        raise ClientError('Install Node 22.18+ for the shared receipt crop geometry, then rerun setup.')
    node_path = str(Path(node_path).resolve(strict=True))
    check_node(node_path, root)
    value = dict(origin=client.origin, repository=str(REPO), client_config=str(Path(config).resolve()),
                 node=node_path, ppocr=dict(device='cpu', python=str(executable),
                 models=str(root / 'models'), timeout_seconds=1800))
    candidate = root / ('profile-' + os.urandom(6).hex() + '.json')
    write_new_file(candidate, json.dumps(value).encode())
    client.configure_ppocr(candidate)
    check_layout(client, root)
    client.ocr_backend.preflight()
    # Atomic pointer replacement, only after the runtime actually loads successfully.
    os.replace(candidate, prepared)
    return str(prepared)


def publish_host_descriptor(profile, python=None, *, config=None, name='receipt-ocr-host.json',
                            include_config=True):
    """Publish only a locally verified profile and fixed worker executable paths."""
    profile_path = Path(profile)
    if (not profile_path.is_absolute() or not profile_path.is_file()
            or profile_path.is_symlink() or profile_path.is_junction()):
        raise ClientError('Use a prepared regular absolute worker profile.')
    worker_python = Path(python or sys.executable).resolve(strict=True)
    if (not worker_python.is_file() or worker_python.is_symlink() or worker_python.is_junction()
            or (os.name != 'nt' and not os.access(worker_python, os.X_OK))
            or worker_python.name.lower() not in {'python', 'python.exe', 'python3', 'python3.exe',
                                                   f'python{sys.version_info.major}.{sys.version_info.minor}'}):
        raise ClientError('Use a prepared regular absolute Python executable for the receipt worker.')
    descriptor = REPO / '.local' / name
    artifact_directory(descriptor.parent)
    if descriptor.exists() and (not descriptor.is_file() or descriptor.is_symlink() or descriptor.is_junction()):
        raise ClientError('Processing host descriptor must be a regular file.')
    settings = json.loads(profile_path.read_text(encoding='utf-8'))
    body = dict(python=str(worker_python), worker_profile=str(profile_path))
    if include_config:
        config_value = config or settings.get('client_config')
        if not isinstance(config_value, str):
            raise ClientError('Use an explicit prepared client configuration.')
        config_path = Path(config_value)
        if (not config_path.is_absolute() or not config_path.is_file()
                or config_path.is_symlink() or config_path.is_junction()):
            raise ClientError('Use a prepared regular absolute client configuration.')
        body['client_config'] = str(config_path)
    body = json.dumps(body).encode()
    candidate = descriptor.parent / ('processing-host-' + os.urandom(6).hex() + '.json')
    write_new_file(candidate, body)
    try:
        os.replace(candidate, descriptor)
    finally:
        candidate.unlink(missing_ok=True)
    return str(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--worker-profile')
    parser.add_argument('--cpu', action='store_true')
    parser.add_argument('--node')
    parser.add_argument('--worker-python')
    args = parser.parse_args()
    config, profile = discover(args.config, args.worker_profile)
    profile = ensure_profile(config, profile, force_cpu=args.cpu, node=args.node)
    descriptor = publish_host_descriptor(profile, args.worker_python, config=config,
                                         name='receipt-ocr-host.json')
    print(json.dumps({'profile': profile, 'descriptor': descriptor}))


if __name__ == '__main__':
    main()
