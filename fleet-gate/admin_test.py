"""Offline invented data only. Called by node --test fleet-gate/."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


admin = load('fleet_admin', HERE / 'mastan-fleet-admin')
enroll = load('fleet_enroll', HERE / 'client/enroll-key.py')
cli = load('fleet_cli', HERE / 'mastan-fleet')

db = sqlite3.connect(':memory:')
db.execute('CREATE TABLE credentials(id TEXT, public_key BLOB, transports TEXT, user TEXT)')
db.executemany('INSERT INTO credentials VALUES(?,?,?,?)', [
    ('fixture-owner-credential', b'invented public key', '["internal"]', 'owner'),
    ('fixture-other-credential', b'other invented public key', '[]', 'someone-else'),
    ('operator', b'not a credential', '[]', 'operator'),
])
rows = admin.trust_rows(db)
assert [row['id'] for row in rows] == ['fixture-owner-credential']
assert set(rows[0]) == {'id', 'public_key_b64', 'transports'}
assert rows[0]['transports'] == ['internal']
db.close()

# Actual harness schema: credentials belong to Owner; operator links are separate.
db = sqlite3.connect(':memory:')
db.execute('CREATE TABLE credentials(id TEXT, public_key BLOB, transports TEXT, origin TEXT)')
db.executemany('INSERT INTO credentials VALUES(?,?,?,?)', [
    ('fixture-owner', b'invented', '[]', 'local'), ('operator', b'invented', '[]', 'local')])
assert [row['id'] for row in admin.trust_rows(db)] == ['fixture-owner']
db.close()

key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyOnly0000000000000000 invented'
existing = '# invented existing line\nssh-ed25519 AAAADifferentKey unrelated\n'
merged = enroll.merge_authorized_keys(existing, key)
assert merged.startswith(existing)
assert merged.count('mastan-ops-dev01') == 1
assert 'from="203.0.113.20,2a01:4f8:1c19:7424::1"' in merged
assert 'command="/usr/bin/python3 -B /opt/mastan/fleet/maintenance/audit-command.py"' in merged
assert enroll.merge_authorized_keys(merged, key) == merged
assert enroll.merge_authorized_keys(existing.rstrip('\n'), key).startswith(existing.rstrip('\n') + '\n')
for invalid in ('not a key', 'ssh-rsa AAAA fixture'):
    try:
        enroll.merge_authorized_keys(existing, invalid)
        raise AssertionError('invalid key accepted')
    except ValueError:
        pass
try:
    enroll.merge_authorized_keys(key + '\n', key)
    raise AssertionError('unrestricted existing key accepted')
except ValueError:
    pass

req, raw = cli.arguments(['--json', 'run', 'fixture-01', '--reason', 'invented reason', '--timeout', '900', '--', 'printf', '%s', 'two words;$(id)'])
assert raw and req['timeout_s'] == 900
assert req['command'] == "printf %s 'two words;$(id)'"
req, raw = cli.arguments(['run', 'fixture-01', '--reason', 'invented', '--', 'true && printf done'])
assert req['command'] == 'true && printf done'
req, _ = cli.arguments(['logs', 'fixture-01', 'mastan-web', '--grep', 'a.*', '--lines', '30'])
assert req['grep'] == 'a.*' and req['lines'] == 30 and req['since'] == '2h'
for state, expected in [('pending', 2), ('approved', 2), ('expired', 2), ('done', 0), ('failed', 1), ('denied', 1), ('cancelled', 1)]:
    assert cli.exit_code({'ok': True, 'state': state, 'status': state}) == expected
assert cli.exit_code({'ok': False}) == 1

with tempfile.TemporaryDirectory(prefix='fleet-admin-') as directory:
    admin.CONF = Path(directory)
    (admin.CONF / 'servers.json').write_text('{"servers": []}\n')
    (admin.CONF / 'known_hosts').write_text('')
    def atomic(path, text, mode=0o644, group=0):
        path.write_text(text)
    admin.atomic = atomic
    calls = []
    def scan(argv, **kwargs):
        calls.append(argv)
        if argv[0] == 'ssh-keyscan':
            return subprocess.CompletedProcess(argv, 0, '192.0.2.11 ssh-ed25519 AAAAFixtureHostKey\n', '')
        return subprocess.CompletedProcess(argv, 0, '256 SHA256:invented fixture (ED25519)\n', '')
    admin.add_server('fixture-01', '192.0.2.11', 'invented', scan)
    pins = (admin.CONF / 'known_hosts').read_text()
    admin.add_server('fixture-01', '192.0.2.11', 'invented', scan)
    assert len(calls) == 2
    assert (admin.CONF / 'known_hosts').read_text() == pins
    assert len(json.loads((admin.CONF / 'servers.json').read_text())['servers']) == 1
    try:
        admin.add_server('fixture-01', '192.0.2.99', 'invented', scan)
        raise AssertionError('changed host accepted')
    except ValueError:
        pass

print('offline admin checks passed')
