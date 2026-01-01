# Fleet gate

Mastan Me reads server health and logs through `/run/mastan-fleet.sock`. Every other
remote command needs one request and Owner's passkey on `https://me.example.com/fleet`.
The gate runs as `mastan-ops`; the agent and web service run as `mastan` and cannot
read its SSH key, state or trusted credential file. A web session is not approval.

## Install from the Mac

The existing `mastan-ops` user and `/var/lib/mastan-ops/ssh/client_ed25519` must
already exist on YOUR_SERVER. The root-owned Node 26 runtime and installed
`@simplewebauthn/server` 14.0.3 under `/opt/mastan-me` are used in place.

```sh
./fleet-gate/install.sh
ssh YOUR_SERVER mastan-fleet-admin status
```

This installs root-owned code in `/opt/mastan-fleet`, the two clients, systemd
units, `/etc/mastan-fleet-gate` (root:mastan-ops 0750), and gate state in
`/var/lib/mastan-fleet-gate` (mastan-ops 0700). `passkeys.json` is root:mastan-ops 0640.
It copies the Fleet skill into the workspace, trusts Owner's current public keys,
adds client-a-01 (203.0.113.40), and enables the socket.
Existing pins and server entries survive updates. On first add the fingerprint
comes from `ssh-keyscan -t ed25519`; compare it with a trusted server record.
Future SSH always requires the pinned key. The installer does not restart
`mastan-me.service`, change the ops key, or modify client servers. Deploy the web
code separately through the normal harness process.

The brief names `/var/lib/mastan-me/mastan-me.db`; this checkout actually uses
`/var/lib/mastan-me/me.sqlite`. `trust-passkeys` reads the first path if it exists,
otherwise the checkout path, in read-only mode. This harness has one owner:
every credentials row belongs to Owner; operator links are separate, not credentials.
If a table has explicit user attribution, only `owner` rows are copied.
Only `{id, public_key_b64, transports}` is copied, never session data or counters.
Counters start in and are owned by the gate, and survive retrusting public keys.
After adding or revoking a passkey run `mastan-fleet-admin trust-passkeys` again.

### RP ID

Owner's passkeys are registered for RP ID `mastan.ai` (`MASTAN_ME_RP_ID` on the server), and the
harness signs in with them on `https://me.example.com`. The gate verifies the same pair: RP ID
`mastan.ai`, origin exactly `https://me.example.com`. Another site under mastan.ai cannot produce an
assertion the gate accepts, because the origin is part of what the passkey signs. If the harness
RP ID ever changes, change `RP_ID` in `gate.mjs` and run `trust-passkeys` again.

## Free checks, keys, windows

`mastan-fleet check <server> <name>` runs one entry of the fixed `CHECKS` list in `gate.mjs`: read-only, no caller shell,
arguments validated, output redacted, logged. It needs nothing new on the server. `OWN_KEY=1 ./fleet-gate/enroll.sh <alias> <name>`
gives a server its own key `/var/lib/mastan-ops/ssh/<name>_ed25519`. `mastan-fleet window` opens a passkey-approved no-tap
window of at most 15 minutes, only on the servers in `WINDOW_SERVERS` (a constant, not config). Windows end when the gate restarts.
The web chat shows pending requests as cards through `/api/fleet/pending`, and running output through `/api/fleet/live/<id>`.

## Enroll a new client from the Mac

```sh
./fleet-gate/enroll.sh prod-01 prod-01 test
```

The SSH alias must resolve to an IP at port 22 with root access. This is also the
step each new server build runs. It vendors the exact maintenance audit wrapper
as `/opt/mastan/fleet/maintenance/audit-command.py` (root 0644, directory 0755),
fetches only the dev-01 public key, and appends the restricted authorized_keys line
if absent. It refuses a copy of that key with different restrictions. Repeating
enrollment leaves the same restricted line and existing host pin. Finally it runs
`mastan-fleet-admin add` on dev-01. No private key leaves dev-01.

The forced command accepts only dev-01's IPv4/IPv6 source addresses, disables
forwarding and user rc, runs `SSH_ORIGINAL_COMMAND` as root, and writes one client
audit row per command. Gate timeouts kill the SSH connection; detached remote
work may continue, so verify status before retrying.

## Use

```sh
mastan-fleet servers
mastan-fleet status client-a-01
mastan-fleet logs client-a-01 mastan-web --since 2h --lines 200 --grep 'connection refused'
mastan-fleet run client-a-01 --reason "Recover failed web unit" -- systemctl restart mastan-web
mastan-fleet wait <id> --timeout 300
mastan-fleet result <id>
mastan-fleet requests
mastan-fleet cancel <id>
```

`run` prints a pending request and `https://me.example.com/fleet#r<id>`. Requests
expire after 30 minutes. One quoted argument after `--` is an exact shell script;
multiple arguments are shell-quoted as literal words. `--timeout` before `--`
sets execution time, default 120 s, maximum 900 s. Wait defaults to 300 s, maximum
900 s; timing out leaves a live request pending or running. `--json` prints the raw
response. Exit codes: 0 success, 1 refused/failed/denied/cancelled, 2 pending/running
or expired, 3 gate unavailable. No CLI operation can bypass the passkey.

The gate issues a fresh 32-byte challenge per request, valid for 120 s, verifies
origin, RP ID, user presence, user verification, credential and counter itself,
then atomically consumes the challenge and claims execution. Concurrent approvals,
replays and changed server addresses cannot execute it again. On restart, approved
requests become failed with an unknown outcome and are never retried. Deny and
cancel need no passkey and only affect pending requests.

Server summaries run in parallel with a 15 s overall limit, cached for 60 s. Logs
validate the unit, relative time, line count and fixed grep string and shell-quote
remote values. Local SSH is spawned with an argument array. stdout and stderr are
combined; results are capped at 50 KB with head and tail and scrubbed before storage
or delivery. Private keys and common token/value formats are redacted. Commands and
reasons containing those secrets are refused. Never put credentials or private
client content in command arguments.

SQLite stores requests, counters and audit metadata. Every verb except pending
and challenge appends metadata to `audit.jsonl`; execution and restart recovery
also add metadata. Neither audit contains output, assertions or credential data.

```sh
ssh YOUR_SERVER mastan-fleet-admin audit 20
ssh YOUR_SERVER mastan-fleet-admin remove prod-01
```

Remove drops the server and any unshared host pin; it leaves client key lines.

## Offline checks

```sh
node --test fleet-gate/
node --test test/fleet-web.test.js
npm test
```

Tests generate P-256 assertions, inject an executor and use invented server data.
Python admin and authorized_keys merge checks run within the gate suite. No test
contacts a real server. Socket integration tests need local Unix socket binding;
other Fleet access and CSRF tests use in-memory HTTP requests.

## Disable or remove

```sh
ssh YOUR_SERVER 'systemctl disable --now mastan-fleet.socket; systemctl stop mastan-fleet.service'
ssh YOUR_SERVER 'rm -f /etc/systemd/system/mastan-fleet.socket /etc/systemd/system/mastan-fleet.service; systemctl daemon-reload'
```

The Fleet page then reports that the gate is not installed. Root can separately
remove `/opt/mastan-fleet`, `/usr/local/bin/mastan-fleet`,
`/usr/local/sbin/mastan-fleet-admin` and `/etc/mastan-fleet-gate`. Preserve
`/var/lib/mastan-fleet-gate` for requests and audit. The ops key and client
`authorized_keys` lines stay. No change to `mastan-me.service` is needed.
