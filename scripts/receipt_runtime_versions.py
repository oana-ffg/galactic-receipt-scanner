"""Security version floors shared by receipt setup and the OCR process."""
import re

from receipt_api import ClientError

PILLOW_PATCH = '13.0.0'
NODE_REQUIREMENT = 'Install patched Node 22.23.4, 24.22.1, or 26.12.1+ and rerun setup.'


class UnsafePillowError(ClientError):
    """A prepared interpreter cannot safely decode receipt originals."""


def require_pillow_version(value):
    version = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:\.post\d+)?', value.strip())
    if not version or tuple(map(int, version.groups())) < (13, 0, 0):
        raise UnsafePillowError(
            f'PP OCR requires Pillow {PILLOW_PATCH} or newer. Upgrade Pillow in the supplied '
            'profile, or rerun setup with --cpu to repair the managed CPU runtime.')


def require_supported_node(value):
    version = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)\s*', value)
    if version:
        parts = tuple(map(int, version.groups()))
        major = parts[0]
        if ((major == 22 and parts >= (22, 23, 4))
                or (major == 24 and parts >= (24, 22, 1))
                or (major == 26 and parts >= (26, 12, 1))):
            return
    raise ClientError(NODE_REQUIREMENT)
