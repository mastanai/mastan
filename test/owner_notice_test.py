# Run by test/owner-notice.test.js (python3 -I -B test/owner_notice_test.py). Uses a temporary database only.
import importlib.util, io, json, os, sqlite3, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('owner_notice', os.path.join(HERE, '..', 'deploy', 'canary', 'owner-notice.py'))
owner_notice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner_notice)

TEXT = '📧 New email\nhello@mastan.ai\nFrom: Invented Sender <sender@example.net>\nSubject: Workshop update\nhttps://me.test/mail#hello/Inbox/11'
FALLBACK = '📧 New email\nhello@mastan.ai\nhttps://me.test/mail#hello/Inbox/11'


def raw(**fields):
    notice = {'id': 'mail:hello:1:11', 'text': TEXT, 'fallback': FALLBACK}
    notice.update(fields)
    return json.dumps({k: v for k, v in notice.items() if v is not None}).encode()


class Validator(unittest.TestCase):
    def accepts(self, **fields):
        self.assertEqual(owner_notice.validate(raw(**fields))['id'], json.loads(raw(**fields))['id'])

    def refuses(self, reason, data):
        with self.assertRaises(owner_notice.Refused) as caught:
            owner_notice.validate(data)
        self.assertEqual(caught.exception.args[0], reason)

    def test_accepts_the_three_id_shapes(self):
        self.accepts()
        self.accepts(id='mail:hello:summary:4294967295', text='📧 New emails\n6 new messages\nhttps://me.test/mail', fallback='📧 New emails\nhttps://me.test/mail')
        self.accepts(id='mail:health:20261113', text='📧 Mail alerts problem\nFailing for an hour.', fallback='📧 Mail alerts problem')

    def test_refuses_bad_ids(self):
        for bad in ['person:1', 'mail:Hello:1:2', 'mail:hello:1:12345678901', 'mail:hello:summary:', 'mail:health:2026111', 'mail:hello:1:2\n', 'mail:' + 'a' * 41 + ':1:2', 5]:
            self.refuses('id', raw(id=bad))

    def test_refuses_bad_text(self):
        for bad in ['', 'New email\nhello', '📧 New email!\nx', '📧 New email\x00', '📧 New email\r\nx', '📧 New email\n‮x', '📧 New email' + '\nx' * 6, '📧 New email\n' + 'x' * 700, 7, None]:
            self.refuses('text' if bad is not None else 'fields', raw(text=bad))
            self.refuses('text' if bad is not None else 'fields', raw(fallback=bad))

    def test_refuses_shape_size_and_encoding(self):
        self.refuses('size', b' ' * 4097)
        self.refuses('json', b'{not json')
        self.refuses('json', b'\xff\xfe')
        self.refuses('fields', b'[]')
        self.refuses('fields', raw()[:-1] + b',"extra":1}')


class Queue(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.dir.name, 'me.sqlite')
        con = sqlite3.connect(self.db)
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('CREATE TABLE public_contact_notices(id TEXT PRIMARY KEY, due INTEGER NOT NULL, text TEXT NOT NULL, fallback TEXT NOT NULL, overflow INTEGER NOT NULL DEFAULT 0)')
        con.execute('CREATE TABLE users(user_id TEXT)')
        con.commit()
        con.close()

    def tearDown(self):
        self.dir.cleanup()

    def run_main(self, data):
        out, err = io.StringIO(), io.StringIO()
        stdout, stderr = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out, err
        try:
            code = owner_notice.main(io.BytesIO(data), self.db)
        finally:
            sys.stdout, sys.stderr = stdout, stderr
        return code, out.getvalue().strip(), err.getvalue().strip()

    def rows(self):
        con = sqlite3.connect(self.db)
        try:
            return con.execute('SELECT id,due,text,fallback,overflow FROM public_contact_notices').fetchall()
        finally:
            con.close()

    def test_inserts_once_with_due_now(self):
        before = int(time.time() * 1000)
        self.assertEqual(self.run_main(raw()), (0, 'ok', ''))
        self.assertEqual(self.run_main(raw()), (0, 'duplicate', ''))
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], 'mail:hello:1:11')
        self.assertTrue(before <= rows[0][1] <= int(time.time() * 1000))
        self.assertEqual(rows[0][2:], (TEXT, FALLBACK, 0))

    def test_invalid_input_writes_nothing(self):
        code, out, err = self.run_main(raw(id='person:1'))
        self.assertEqual((code, out, err), (2, '', 'id'))
        self.assertEqual(self.rows(), [])

    def test_rate_limit_counts_recent_mail_rows_only(self):
        con = sqlite3.connect(self.db)
        now = int(time.time() * 1000)
        con.executemany('INSERT INTO public_contact_notices(id,due,text,fallback) VALUES(?,?,?,?)',
                        [(f'mail:hello:1:{i}', now - 60_000, 'x', 'x') for i in range(29)] +
                        [('mail:hello:1:900', now - 2 * 3600_000, 'x', 'x'), ('person:1', now, 'x', 'x')])
        con.commit()
        con.close()
        self.assertEqual(self.run_main(raw(id='mail:hello:1:100'))[:2], (0, 'ok'))
        self.assertEqual(self.run_main(raw(id='mail:hello:1:101')), (3, '', 'rate'))
        # A retry of an accepted notice is still a duplicate, not a refusal.
        self.assertEqual(self.run_main(raw(id='mail:hello:1:100'))[:2], (0, 'duplicate'))
        self.assertEqual(len(self.rows()), 32)

    def test_missing_table_is_a_database_error(self):
        os.remove(self.db)
        sqlite3.connect(self.db).close()
        self.assertEqual(self.run_main(raw()), (4, '', 'database'))


if __name__ == '__main__':
    unittest.main(verbosity=0)
