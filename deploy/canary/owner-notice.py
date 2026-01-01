#!/usr/bin/python3 -IB
# Forced command for the hub's owner-notice key. Reads one JSON notice from stdin and queues it in
# public_contact_notices, which the canary service delivers to the inbound admin on WhatsApp.
# It ignores SSH_ORIGINAL_COMMAND, touches no other table, opens no network and writes no files.
# Runs as mastan-pub (runuser in authorized_keys), so the WAL files keep their owner.
import json, re, sqlite3, sys, time, unicodedata

DB = '/var/lib/mastan-public/me.sqlite'
MAX_INPUT = 4096
MAX_CHARS = 700
MAX_LINES = 6
HOUR_LIMIT = 30
HEADERS = ('📧 New email', '📧 New emails', '📧 Mail alerts problem')
IDS = (
    re.compile(r'mail:[a-z0-9_-]{1,40}:[0-9]{1,10}:[0-9]{1,10}'),
    re.compile(r'mail:[a-z0-9_-]{1,40}:summary:[0-9]{1,13}'),
    re.compile(r'mail:health:[0-9]{8}'),
)


class Refused(Exception):
    pass


def valid_text(value):
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_CHARS:
        return False
    # Control and format characters (bidi overrides included) are refused, newline is the only exception.
    if any(c != '\n' and unicodedata.category(c) in ('Cc', 'Cf', 'Cs', 'Zl', 'Zp') for c in value):
        return False
    lines = value.split('\n')
    return len(lines) <= MAX_LINES and lines[0] in HEADERS


def validate(raw):
    if len(raw) > MAX_INPUT:
        raise Refused('size')
    try:
        notice = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise Refused('json')
    if not isinstance(notice, dict) or set(notice) != {'id', 'text', 'fallback'}:
        raise Refused('fields')
    if not isinstance(notice['id'], str) or not any(p.fullmatch(notice['id']) for p in IDS):
        raise Refused('id')
    if not valid_text(notice['text']) or not valid_text(notice['fallback']):
        raise Refused('text')
    return notice


def queue(notice, db_path, now_ms):
    db = sqlite3.connect(db_path, timeout=5, isolation_level=None)
    try:
        db.execute('PRAGMA busy_timeout=5000')
        db.execute('BEGIN IMMEDIATE')
        try:
            if db.execute('SELECT 1 FROM public_contact_notices WHERE id=?', (notice['id'],)).fetchone():
                db.execute('COMMIT')
                return 'duplicate'
            recent = db.execute("SELECT count(*) FROM public_contact_notices WHERE id LIKE 'mail:%' AND due>?",
                                (now_ms - 3600_000,)).fetchone()[0]
            if recent >= HOUR_LIMIT:
                raise Refused('rate')
            db.execute('INSERT OR IGNORE INTO public_contact_notices(id,due,text,fallback) VALUES(?,?,?,?)',
                       (notice['id'], now_ms, notice['text'], notice['fallback']))
            db.execute('COMMIT')
            return 'ok'
        except BaseException:
            db.execute('ROLLBACK')
            raise
    finally:
        db.close()


def main(stdin, db_path=DB):
    try:
        notice = validate(stdin.read(MAX_INPUT + 1))
        result = queue(notice, db_path, int(time.time() * 1000))
    except Refused as error:
        print(error.args[0], file=sys.stderr)
        return 2 if error.args[0] != 'rate' else 3
    except sqlite3.Error:
        print('database', file=sys.stderr)
        return 4
    print(result)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.stdin.buffer))
