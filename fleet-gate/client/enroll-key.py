#!/usr/bin/python3 -I
"""Install the forced command and merge its restricted public key, idempotently."""
import fcntl
import os
from pathlib import Path
import re
import shutil
import sys

OPTIONS = ('from="203.0.113.20,2a01:4f8:1c19:7424::1",'
           'command="/usr/bin/python3 -B /opt/mastan/fleet/maintenance/audit-command.py",'
           'no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc')


def merge_authorized_keys(existing, public_key):
    parts = public_key.strip().split()
    if len(parts) < 2 or parts[0] != 'ssh-ed25519' or not re.fullmatch(r'[A-Za-z0-9+/=]+', parts[1]):
        raise ValueError('expected ed25519 public key')
    line = f'{OPTIONS} ssh-ed25519 {parts[1]} mastan-ops-dev01'
    lines = existing.splitlines()
    # An existing unrestricted copy must never win before the forced command.
    # Refuse that conflict instead of silently changing an existing access grant.
    matching = [s for s in lines if re.search(r'(?:^|\s)ssh-ed25519\s+' + re.escape(parts[1]) + r'(?:\s|$)', s)]
    if matching:
        if any(s != line for s in matching):
            raise ValueError('key already present with different restrictions; review it first')
        return existing
    return existing + ('' if not existing or existing.endswith('\n') else '\n') + line + '\n'


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        sys.exit('root and wrapper path required')
    public_key = sys.stdin.read(4096)
    ssh = Path('/root/.ssh')
    ssh.mkdir(mode=0o700, exist_ok=True)
    path = ssh / 'authorized_keys'
    # Lock the directory's stable lock file and atomically replace the key file.
    with (ssh / '.mastan-fleet.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        old = path.read_text() if path.exists() else ''
        merged = merge_authorized_keys(old, public_key)
        dest = Path('/opt/mastan/fleet/maintenance')
        dest.mkdir(parents=True, exist_ok=True)
        os.chmod(dest, 0o755); os.chown(dest, 0, 0)
        wrapper = dest / 'audit-command.py'
        shutil.copyfile(sys.argv[1], wrapper)
        os.chmod(wrapper, 0o644); os.chown(wrapper, 0, 0)
        if merged != old:
            tmp = ssh / '.authorized_keys.mastan-fleet'
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(merged); stream.flush(); os.fsync(stream.fileno())
            os.chown(tmp, 0, 0); os.replace(tmp, path)
    print('forced command installed; restricted key present')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError):
        sys.exit('enrollment refused; check existing key restrictions and paths')
