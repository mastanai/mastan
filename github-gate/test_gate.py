"""End-to-end test of the gate against a local bare repo standing in for GitHub (no network, no token).
Run: python3 -I github-gate/test_gate.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gate  # noqa: E402

ID = {'name': 'your-org', 'email': 'owner@example.invalid'}


def sh(*args, cwd=None, env=None, check=True):
    r = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise AssertionError(f'{args} failed: {r.stderr}{r.stdout}')
    return r


class GateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='gh-gate-test-')
        t = cls.tmp
        cls.base = os.path.join(t, 'github') + '/'
        cls.origin = os.path.join(t, 'github', 'acme', 'widget.git')
        os.makedirs(os.path.dirname(cls.origin))
        sh('git', 'init', '-q', '--bare', '-b', 'main', cls.origin)
        seed = os.path.join(t, 'seed')
        sh('git', 'init', '-q', '-b', 'main', seed)
        sh('git', '-c', 'user.name=Client D', '-c', 'user.email=a@example.invalid', 'commit', '-q', '--allow-empty',
           '-m', 'Import', cwd=seed)
        sh('git', 'push', '-q', cls.origin, 'main', 'main:someone-else', cwd=seed)
        conf = {'repos': {'acme/widget': {'write': ['push', 'pr', 'comment'], 'forbid': ['model-names', 'attribution'],
                                          'identity': ID},
                          'acme/*': {'write': []}}}
        cls.conf = os.path.join(t, 'repos.json')
        with open(cls.conf, 'w') as f:
            json.dump(conf, f)
        cls.sock = os.path.join(t, 'gate.sock')
        cls.env = dict(os.environ, MASTAN_GH_CONF=cls.conf, MASTAN_GH_TOKEN=os.path.join(t, 'no-token'),
                       MASTAN_GH_STATE=os.path.join(t, 'state'), MASTAN_GH_GIT_BASE=cls.base, MASTAN_GH_SOCKET=cls.sock,
                       MASTAN_GH_API='http://127.0.0.1:9')
        cls.log = open(os.path.join(t, 'gate.log'), 'w')
        cls.proc = subprocess.Popen([sys.executable, '-I', os.path.join(HERE, 'gate.py')], env=cls.env, stderr=cls.log)
        for _ in range(50):
            if os.path.exists(cls.sock):
                break
            time.sleep(0.1)
        cls.home = os.path.join(t, 'home')
        os.makedirs(cls.home)
        cls.cenv = dict(os.environ, HOME=cls.home, MASTAN_GH_SOCKET=cls.sock, GIT_CONFIG_NOSYSTEM='1')
        cls.clone = os.path.join(t, 'clone')
        sh('git', 'clone', '-q', cls.origin, cls.clone)
        cls.gh('link', 'acme/widget')

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait()
        cls.log.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def gh(cls, *args, ok=True):
        r = sh(sys.executable, '-I', os.path.join(HERE, 'mastan-gh'), *args, cwd=cls.clone, env=cls.cenv, check=False)
        if ok and r.returncode != 0:
            raise AssertionError(f'mastan-gh {args} failed: {r.stderr}')
        if not ok and r.returncode == 0:
            raise AssertionError(f'mastan-gh {args} should have been refused: {r.stdout}')
        return r.stdout + r.stderr

    def commit(self, msg, path=None, email=ID['email'], branch=None):
        if branch:
            sh('git', 'checkout', '-q', '-B', branch, cwd=self.clone)
        path = path or f'f{time.time_ns()}.txt'
        full = os.path.join(self.clone, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'w') as f:
            f.write(msg)
        sh('git', 'add', path, cwd=self.clone)
        sh('git', '-c', f'user.email={email}', '-c', f'user.name={ID["name"]}', 'commit', '-q', '-m', msg, cwd=self.clone,
           env=dict(self.cenv, GIT_COMMITTER_EMAIL=email))
        return sh('git', 'rev-parse', 'HEAD', cwd=self.clone).stdout.strip()

    def origin_tip(self, branch):
        return sh('git', '-C', self.origin, 'rev-parse', '--verify', '--quiet', f'refs/heads/{branch}', check=False).stdout.strip()

    def test_01_link_sets_identity_and_readonly_remote(self):
        self.assertEqual(sh('git', 'config', 'user.email', cwd=self.clone).stdout.strip(), ID['email'])
        self.assertEqual(sh('git', 'config', 'remote.github.pushurl', cwd=self.clone).stdout.strip(),
                         '/nonexistent/use-mastan-gh-push')
        self.assertIn('github/main', sh('git', 'branch', '-r', cwd=self.clone).stdout)

    def test_02_push_new_branch_then_fast_forward(self):
        sha = self.commit('Add pricing import', branch='me/pricing')
        out = self.gh('push', 'me/pricing')
        self.assertIn('new branch', out)
        self.assertEqual(self.origin_tip('pricing'), sha)
        sha2 = self.commit('Fix the save bar')
        self.gh('push', 'me/pricing')
        self.assertEqual(self.origin_tip('pricing'), sha2)
        self.assertIn('nothing pushed', self.gh('push', 'me/pricing'))

    def test_03_main_and_default_refused(self):
        self.commit('Something', branch='me/x')
        self.assertIn('protected', self.gh('push', 'me/x', '--as', 'main', ok=False))
        self.assertIn('protected', self.gh('push', 'me/x', '--as', 'release/1', ok=False))

    def test_04_model_names_and_attribution_refused(self):
        self.commit('Built with Claude', branch='me/bad1')
        self.assertIn('model-names', self.gh('push', 'me/bad1', ok=False))
        sh('git', 'checkout', '-q', '-B', 'me/bad2', 'github/main', cwd=self.clone)
        self.commit('Fix\n\nCo-Authored-By: Someone <x@y>')
        self.assertIn('attribution', self.gh('push', 'me/bad2', ok=False))
        self.assertEqual(self.origin_tip('bad1'), '')

    def test_05_workflow_files_refused(self):
        sh('git', 'checkout', '-q', '-B', 'me/wf', 'github/main', cwd=self.clone)
        self.commit('Deploy workflow', path='.github/workflows/deploy.yml')
        self.assertIn('workflow files', self.gh('push', 'me/wf', ok=False))

    def test_06_wrong_author_refused(self):
        sh('git', 'checkout', '-q', '-B', 'me/auth', 'github/main', cwd=self.clone)
        self.commit('Fix', email='mastan-me@localhost')
        self.assertIn('takes owner@example.invalid only', self.gh('push', 'me/auth', ok=False))

    def test_07_force_only_on_gate_branches(self):
        sh('git', 'checkout', '-q', '-B', 'me/rw', 'github/main', cwd=self.clone)
        self.commit('One')
        self.gh('push', 'me/rw')
        sh('git', 'reset', '-q', '--hard', 'github/main', cwd=self.clone)
        sha = self.commit('One, squashed')
        self.assertIn('rebase', self.gh('push', 'me/rw', ok=False))
        self.gh('push', 'me/rw', '--force')
        self.assertEqual(self.origin_tip('rw'), sha)
        sh('git', 'checkout', '-q', '--orphan', 'me/other', cwd=self.clone)
        self.commit('Replace theirs')
        self.assertIn("someone else's", self.gh('push', 'me/other', '--as', 'someone-else', '--force', ok=False))

    def test_08_fast_forward_on_someone_elses_branch_is_fine(self):
        sh('git', 'checkout', '-q', '-B', 'me/theirs', 'github/someone-else', cwd=self.clone)
        sha = self.commit('Build on theirs')
        self.gh('push', 'me/theirs', '--as', 'someone-else')
        self.assertEqual(self.origin_tip('someone-else'), sha)

    def test_09_unlisted_and_readonly_repos(self):
        self.assertIn('not on the gate list', self.gh('-R', 'other/repo', 'fetch', ok=False))
        gate.CONF = self.conf
        with self.assertRaises(gate.Refused):
            gate.need('acme/other', 'push')
        self.assertEqual(gate.need('acme/other', 'read')['write'], [])

    def test_10_policy_helpers(self):
        self.assertFalse(gate.valid_branch('-x'))
        self.assertFalse(gate.valid_branch('a..b'))
        self.assertFalse(gate.valid_branch('a.lock'))
        self.assertTrue(gate.valid_branch('feature/pricing-import'))
        p = {'protected': gate.DEFAULT_PROTECTED, 'blocked_paths': gate.DEFAULT_BLOCKED_PATHS, 'forbid': ['model-names']}
        self.assertTrue(gate.protected('develop', p, 'develop'))
        self.assertTrue(gate.blocked_path('.github/workflows/x.yml', p))
        self.assertFalse(gate.blocked_path('.github/CODEOWNERS', p))
        for ok in ('Solve the save bar', 'Add GPU note', 'opusculum'):
            gate.check_text(p, ok)
        for bad in ('GPT-6.1 Sol wrote this', 'via Codex', 'Opus 5.5'):
            with self.assertRaises(gate.Refused):
                gate.check_text(p, bad)

    def test_11_no_token_means_clear_refusal_for_api(self):
        self.assertIn('no GitHub token', self.gh('pr', 'list', ok=False))


if __name__ == '__main__':
    unittest.main(verbosity=2)
