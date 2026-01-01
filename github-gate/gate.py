#!/usr/bin/python3 -I
"""Mastan Me GitHub gate. Holds Owner's GitHub token; the agent never sees it.

Runs as user mastan-gh, socket-activated on /run/mastan-gh.sock (group mastan, 0660). One request per connection:
a JSON header line, then for `push` the raw bytes of a git bundle. One JSON line back.

What it allows (per repo, from /opt/mastan-gh/repos.json, root-owned):
  read     sync a read-only mirror the agent fetches from, list/view PRs and issues, PR diffs, GET inside the repo
  push     branches only: never main, master, the default branch or a protected pattern; fast-forward on any other
           branch, force only on branches this gate created; no workflow files; message and author rules
  pr       open DRAFT PRs, edit title/body of PRs opened by the token's user
  comment  comment on PRs and issues
  issue    open issues
Never: merge, close, delete, ready-for-review, settings, releases, workflow runs, other repos.
"""
import base64
import fnmatch
import json
import os
import pwd
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

CONF = os.environ.get('MASTAN_GH_CONF', '/opt/mastan-gh/repos.json')
TOKEN_FILE = os.environ.get('MASTAN_GH_TOKEN', '/etc/mastan-gh/token')
STATE = os.environ.get('MASTAN_GH_STATE', '/var/lib/mastan-gh')
MIRRORS = os.path.join(STATE, 'mirrors')
PRIVATE = os.path.join(STATE, 'private')
API = os.environ.get('MASTAN_GH_API', 'https://api.github.com')
GIT_BASE = os.environ.get('MASTAN_GH_GIT_BASE', 'https://github.com/')
SOCKET_PATH = os.environ.get('MASTAN_GH_SOCKET', '/run/mastan-gh.sock')
MAX_HEADER = 1 << 20
MAX_BUNDLE = 300 << 20
MAX_NEW_COMMITS = 300
MAX_TEXT = 60000

FORBID = {
    'model-names': r'\b(claude|anthropic|opus|sonnet|haiku|fable|codex|openai|chatgpt|gpt[-\s]?\d[\w.\-]*|gpt)\b',
    'attribution': r'(co-authored-by|generated with|\U0001F916)',
}
DEFAULT_PROTECTED = ['main', 'master', 'gh-pages', 'production', 'release/*']
DEFAULT_BLOCKED_PATHS = ['.github/workflows/', '.github/actions/']
REPO_RE = re.compile(r'^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$')
SHA_RE = re.compile(r'^[0-9a-f]{40}$')


class Refused(Exception):
    pass


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------- policy ----------

def load_conf():
    with open(CONF) as f:
        return json.load(f)


def policy(repo, conf=None):
    """Policy for repo, or None. Exact entries win over owner/* entries (read-only unless they say otherwise)."""
    conf = conf or load_conf()
    if not isinstance(repo, str) or not REPO_RE.match(repo) or '..' in repo:
        return None
    repos = conf.get('repos', {})
    if repo in repos:
        p = dict(repos[repo])
    else:
        p = None
        for pat, v in repos.items():
            if pat.endswith('/*') and repo.split('/')[0].lower() == pat[:-2].lower():
                p = dict(v)
                break
        if p is None:
            return None
    p.setdefault('write', [])
    p['protected'] = list(conf.get('protected_branches', DEFAULT_PROTECTED)) + list(p.get('protected', []))
    p['blocked_paths'] = list(conf.get('blocked_paths', DEFAULT_BLOCKED_PATHS))
    return p


def need(repo, action):
    p = policy(repo)
    if p is None:
        raise Refused(f'{repo} is not on the gate list (/opt/mastan-gh/repos.json); ask Owner')
    if action != 'read' and action not in p['write']:
        raise Refused(f'{action} is not allowed on {repo} (allowed: {", ".join(p["write"]) or "read only"})')
    return p


def check_text(p, *texts):
    for name in p.get('forbid', []):
        rx = re.compile(FORBID.get(name, name), re.I)
        for t in texts:
            m = rx.search(t or '')
            if m:
                raise Refused(f'"{m.group(0)}" is not allowed in this repo ({name} rule); rewrite and try again')


def valid_branch(name):
    if not isinstance(name, str) or not re.match(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$', name):
        return False
    if '..' in name or '//' in name or name.endswith(('/', '.lock', '.')) or '@{' in name:
        return False
    return subprocess.run(['git', 'check-ref-format', '--branch', name], capture_output=True).returncode == 0


def protected(branch, p, default_branch):
    if branch == default_branch:
        return True
    return any(fnmatch.fnmatchcase(branch, pat) for pat in p['protected'])


def blocked_path(path, p):
    return any(path == b.rstrip('/') or path.startswith(b) for b in p['blocked_paths'])


# ---------- token, git, api ----------

def token():
    try:
        with open(TOKEN_FILE) as f:
            t = f.read().strip()
    except FileNotFoundError:
        raise Refused('no GitHub token on the server yet: Owner runs `mastan-gh-admin set-token` once')
    if not t:
        raise Refused('the GitHub token file is empty: Owner runs `mastan-gh-admin set-token`')
    return t


def git_env(auth=False):
    env = {'HOME': PRIVATE, 'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'GIT_TERMINAL_PROMPT': '0',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.hooksPath', 'GIT_CONFIG_VALUE_0': '/dev/null'}
    if auth and GIT_BASE.startswith('https://'):
        basic = base64.b64encode(f'x-access-token:{token()}'.encode()).decode()
        env.update({'GIT_CONFIG_COUNT': '2', 'GIT_CONFIG_KEY_1': f'http.{GIT_BASE}.extraheader',
                    'GIT_CONFIG_VALUE_1': f'AUTHORIZATION: basic {basic}'})
    return env


def git(mirror, *args, auth=False, check=True, timeout=600):
    r = subprocess.run(['git', '-C', mirror, *args], capture_output=True, text=True, env=git_env(auth), timeout=timeout)
    if check and r.returncode != 0:
        err = (r.stderr or r.stdout).strip()
        raise Refused(f'git {args[0]} failed: {scrub(err)[-1500:]}')
    return r.stdout.strip()


def scrub(s):
    try:
        t = token()
    except Refused:
        return s
    return s.replace(t, '***')


def gh(method, path, body=None, accept='application/vnd.github+json', limit=4 << 20):
    req = urllib.request.Request(API + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={'Authorization': f'Bearer {token()}', 'Accept': accept,
                                          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mastan-gh-gate',
                                          'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read(limit + 1)
            headers = dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read(65536)).get('message', '')
        except Exception:
            msg = ''
        raise Refused(f'GitHub said {e.code} {msg}'.strip())
    except urllib.error.URLError as e:
        raise Refused(f'GitHub unreachable: {e.reason}')
    truncated = len(raw) > limit
    raw = raw[:limit]
    if accept.endswith('json'):
        return (json.loads(raw) if raw else None), headers
    return raw.decode('utf-8', 'replace') + ('\n[... truncated by the gate]' if truncated else ''), headers


def me():
    data, headers = gh('GET', '/user')
    return data['login'], headers.get('X-OAuth-Scopes', headers.get('x-oauth-scopes', ''))


# ---------- mirrors ----------

def mirror_path(repo):
    return os.path.join(MIRRORS, repo.replace('/', '__') + '.git')


def sync(repo):
    m = mirror_path(repo)
    if not os.path.isdir(m):
        subprocess.run(['git', 'init', '-q', '--bare', m], check=True, env=git_env())
        git(m, 'config', 'remote.origin.url', f'{GIT_BASE}{repo}.git')
        git(m, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*')
        git(m, 'config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*')
        git(m, 'config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/pull/*/head')
        git(m, 'config', 'gc.auto', '0')
    git(m, 'fetch', '-q', '--prune', 'origin', auth=True)
    head = git(m, 'ls-remote', '--symref', 'origin', 'HEAD', auth=True, check=False)
    mm = re.search(r'ref: refs/heads/(\S+)\s+HEAD', head)
    default = mm.group(1) if mm else 'main'
    git(m, 'symbolic-ref', 'HEAD', f'refs/heads/{default}')
    return m, default


def heads(m):
    out = git(m, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads')
    return dict(line.split(' ', 1) for line in out.splitlines() if line)


# ---------- state ----------

def created_file():
    return os.path.join(PRIVATE, 'created.json')


def created():
    try:
        with open(created_file()) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def mark_created(repo, branch):
    c = created()
    c.setdefault(repo, [])
    if branch not in c[repo]:
        c[repo].append(branch)
    tmp = created_file() + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(c, f, indent=1)
    os.replace(tmp, created_file())


def audit(entry):
    entry = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **entry}
    with open(os.path.join(PRIVATE, 'audit.jsonl'), 'a') as f:
        f.write(json.dumps(entry) + '\n')
    log(' '.join(f'{k}={v}' for k, v in entry.items() if k != 'at'))


# ---------- ops ----------

def op_status(req):
    conf = load_conf()
    out = {'repos': {k: v.get('write', []) for k, v in conf.get('repos', {}).items()}}
    try:
        login, scopes = me()
        out.update(token='ok', login=login, scopes=scopes)
    except Refused as e:
        out.update(token='missing or rejected', detail=str(e))
    return out


def op_sync(req):
    repo = req.get('repo')
    p = need(repo, 'read')
    m, default = sync(repo)
    return {'repo': repo, 'mirror': m, 'default_branch': default, 'branches': heads(m),
            'identity': p.get('identity'), 'write': p['write']}


def op_push(req, bundle):
    repo = req.get('repo')
    p = need(repo, 'push')
    branch, sha, force = req.get('branch'), req.get('sha', ''), bool(req.get('force'))
    if not valid_branch(branch):
        raise Refused(f'bad branch name {branch!r}')
    if not SHA_RE.match(sha):
        raise Refused('sha must be a full 40-character commit id')
    check_text(p, branch)
    m, default = sync(repo)
    if protected(branch, p, default):
        raise Refused(f'{branch} is protected: push your own branch and open a draft PR; Owner merges')
    inbox = f'refs/gate/inbox/{os.getpid()}-{int(time.time() * 1000)}'
    try:
        if bundle:
            src = req.get('bundle_ref', '')
            if not src.startswith('refs/heads/') or not valid_branch(src[len('refs/heads/'):]):
                raise Refused('bundle_ref must be refs/heads/<branch>')
            v = subprocess.run(['git', '-C', m, 'bundle', 'verify', bundle], capture_output=True, text=True, env=git_env())
            if v.returncode != 0:
                raise Refused('the bundle needs commits GitHub does not have: rebase onto github/<base> first. '
                              + v.stderr.strip()[-600:])
            git(m, 'fetch', '-q', '--no-tags', bundle, f'+{src}:{inbox}')
            if git(m, 'rev-parse', inbox) != sha:
                raise Refused('bundle tip does not match the sha you sent')
        elif git(m, 'cat-file', '-t', sha, check=False) != 'commit':
            raise Refused(f'{sha[:12]} is not on GitHub and no bundle came with it')
        tip = heads(m).get(branch)
        if tip == sha:
            return {'branch': branch, 'sha': sha, 'note': 'already there, nothing pushed'}
        ff = tip is None or subprocess.run(['git', '-C', m, 'merge-base', '--is-ancestor', tip, sha],
                                           env=git_env()).returncode == 0
        if not ff:
            if not force:
                raise Refused(f'{branch} on GitHub is at {tip[:12]} and your commit does not contain it: '
                              'fetch github and rebase, or pass --force on a branch the gate created')
            if branch not in created().get(repo, []):
                raise Refused(f'--force only works on branches the gate created; {branch} is someone else\'s')
        new = git(m, 'rev-list', sha, '--not', '--branches', '--tags', '--glob=refs/pull/*').split()
        if len(new) > MAX_NEW_COMMITS:
            raise Refused(f'{len(new)} new commits; the gate takes at most {MAX_NEW_COMMITS} per push')
        if new:
            msgs = git(m, 'log', '--no-walk', '--format=%an%n%cn%n%B%x00', *new)
            check_text(p, msgs)
            ident = (p.get('identity') or {}).get('email')
            if ident:
                for line in git(m, 'log', '--no-walk', '--format=%h %ae %ce', *new).splitlines():
                    h, ae, ce = line.split(' ')
                    if ae != ident or ce != ident:
                        raise Refused(f'commit {h} is by {ae}/{ce}; this repo takes {ident} only. Fix: '
                                      f'git rebase <base> --exec "git commit --amend --no-edit --reset-author"')
            paths = set(git(m, 'log', '--no-walk', '--format=', '--name-only', '--cc', *new).split('\n')) - {''}
            bad = sorted(x for x in paths if blocked_path(x, p))
            if bad:
                raise Refused(f'workflow files are Owner\'s step from the Mac: {", ".join(bad[:5])}')
        ref = inbox if bundle else sha
        git(m, 'push', '--porcelain', f'--force-with-lease=refs/heads/{branch}:{tip or ""}', 'origin',
            f'{ref}:refs/heads/{branch}', auth=True)
        if tip is None:
            mark_created(repo, branch)
        git(m, 'fetch', '-q', '--prune', 'origin', auth=True)
    finally:
        git(m, 'update-ref', '-d', inbox, check=False)
    audit({'op': 'push', 'repo': repo, 'branch': branch, 'sha': sha[:12], 'was': (tip or 'new')[:12],
           'commits': len(new), 'force': force and not ff})
    return {'branch': branch, 'sha': sha, 'was': tip, 'new_commits': len(new),
            'url': f'https://github.com/{repo}/tree/{branch}',
            'compare': f'https://github.com/{repo}/compare/{default}...{branch}'}


def pick(d, *keys):
    return {k: d.get(k) for k in keys}


def short_pr(x):
    return {'number': x['number'], 'title': x['title'], 'state': x['state'], 'draft': x.get('draft'),
            'user': x['user']['login'], 'head': x['head']['ref'], 'base': x['base']['ref'],
            'updated': x['updated_at'], 'url': x['html_url']}


def num(req):
    n = req.get('number')
    if not isinstance(n, int) or n <= 0:
        raise Refused('number must be a positive integer')
    return n


def text(req, key, required=True):
    t = req.get(key)
    if t is None and not required:
        return None
    if not isinstance(t, str) or not t.strip() or len(t) > MAX_TEXT:
        raise Refused(f'{key} must be non-empty text under {MAX_TEXT} characters')
    return t


def op_pr_list(req):
    repo = req.get('repo')
    need(repo, 'read')
    state = req.get('state', 'open')
    if state not in ('open', 'closed', 'all'):
        raise Refused('state is open, closed or all')
    data, _ = gh('GET', f'/repos/{repo}/pulls?state={state}&per_page=50')
    return {'prs': [short_pr(x) for x in data]}


def op_pr_view(req):
    repo, n = req.get('repo'), num(req)
    need(repo, 'read')
    pr, _ = gh('GET', f'/repos/{repo}/pulls/{n}')
    comments, _ = gh('GET', f'/repos/{repo}/issues/{n}/comments?per_page=100')
    reviews, _ = gh('GET', f'/repos/{repo}/pulls/{n}/reviews?per_page=100')
    rcomments, _ = gh('GET', f'/repos/{repo}/pulls/{n}/comments?per_page=100')
    files, _ = gh('GET', f'/repos/{repo}/pulls/{n}/files?per_page=100')
    status, _ = gh('GET', f'/repos/{repo}/commits/{pr["head"]["sha"]}/status')
    checks, _ = gh('GET', f'/repos/{repo}/commits/{pr["head"]["sha"]}/check-runs?per_page=50')
    out = short_pr(pr)
    out.update(body=pr.get('body') or '', mergeable=pr.get('mergeable'), mergeable_state=pr.get('mergeable_state'),
               head_sha=pr['head']['sha'], commits=pr.get('commits'), additions=pr.get('additions'),
               deletions=pr.get('deletions'),
               files=[pick(f, 'filename', 'status', 'additions', 'deletions') for f in files],
               comments=[{'user': c['user']['login'], 'at': c['created_at'], 'body': c['body']} for c in comments],
               reviews=[{'user': r['user']['login'], 'state': r['state'], 'body': r.get('body') or ''} for r in reviews],
               review_comments=[{'user': c['user']['login'], 'path': c.get('path'), 'line': c.get('line'),
                                 'body': c['body']} for c in rcomments],
               status=status.get('state'),
               checks=[pick(c, 'name', 'status', 'conclusion') for c in checks.get('check_runs', [])])
    return out


def op_pr_diff(req):
    repo, n = req.get('repo'), num(req)
    need(repo, 'read')
    diff, _ = gh('GET', f'/repos/{repo}/pulls/{n}', accept='application/vnd.github.diff', limit=2 << 20)
    return {'diff': diff}


def op_pr_create(req):
    repo = req.get('repo')
    p = need(repo, 'pr')
    head, base = req.get('head'), req.get('base')
    title, body = text(req, 'title'), text(req, 'body')
    check_text(p, title, body)
    m, default = sync(repo)
    base = base or default
    hs = heads(m)
    if head not in hs:
        raise Refused(f'{head} is not on GitHub: `mastan-gh push` it first')
    if base not in hs:
        raise Refused(f'base {base} is not on GitHub')
    pr, _ = gh('POST', f'/repos/{repo}/pulls', {'title': title, 'body': body, 'head': head, 'base': base, 'draft': True})
    audit({'op': 'pr-create', 'repo': repo, 'number': pr['number'], 'head': head, 'base': base})
    return short_pr(pr)


def op_pr_edit(req):
    repo, n = req.get('repo'), num(req)
    p = need(repo, 'pr')
    title, body = text(req, 'title', False), text(req, 'body', False)
    if title is None and body is None:
        raise Refused('give a title or a body')
    check_text(p, title, body)
    pr, _ = gh('GET', f'/repos/{repo}/pulls/{n}')
    login, _ = me()
    if pr['user']['login'] != login:
        raise Refused(f'PR {n} was opened by {pr["user"]["login"]}; the gate only edits PRs opened by {login}')
    patch = {k: v for k, v in (('title', title), ('body', body)) if v is not None}
    pr, _ = gh('PATCH', f'/repos/{repo}/pulls/{n}', patch)
    audit({'op': 'pr-edit', 'repo': repo, 'number': n, 'fields': ','.join(patch)})
    return short_pr(pr)


def op_comment(req):
    repo, n = req.get('repo'), num(req)
    p = need(repo, 'comment')
    body = text(req, 'body')
    check_text(p, body)
    c, _ = gh('POST', f'/repos/{repo}/issues/{n}/comments', {'body': body})
    audit({'op': 'comment', 'repo': repo, 'number': n})
    return {'url': c['html_url']}


def op_issue_list(req):
    repo = req.get('repo')
    need(repo, 'read')
    state = req.get('state', 'open')
    if state not in ('open', 'closed', 'all'):
        raise Refused('state is open, closed or all')
    data, _ = gh('GET', f'/repos/{repo}/issues?state={state}&per_page=50')
    return {'issues': [{'number': x['number'], 'title': x['title'], 'state': x['state'], 'user': x['user']['login'],
                        'pr': 'pull_request' in x, 'url': x['html_url']} for x in data]}


def op_issue_view(req):
    repo, n = req.get('repo'), num(req)
    need(repo, 'read')
    x, _ = gh('GET', f'/repos/{repo}/issues/{n}')
    comments, _ = gh('GET', f'/repos/{repo}/issues/{n}/comments?per_page=100')
    return {'number': n, 'title': x['title'], 'state': x['state'], 'user': x['user']['login'], 'body': x.get('body') or '',
            'url': x['html_url'],
            'comments': [{'user': c['user']['login'], 'at': c['created_at'], 'body': c['body']} for c in comments]}


def op_issue_create(req):
    repo = req.get('repo')
    p = need(repo, 'issue')
    title, body = text(req, 'title'), text(req, 'body')
    check_text(p, title, body)
    x, _ = gh('POST', f'/repos/{repo}/issues', {'title': title, 'body': body})
    audit({'op': 'issue-create', 'repo': repo, 'number': x['number']})
    return {'number': x['number'], 'url': x['html_url']}


def op_api(req):
    repo, path = req.get('repo'), req.get('path', '')
    need(repo, 'read')
    base = f'/repos/{repo}'
    if not isinstance(path, str) or '..' in path or not (path == base or path.startswith(base + '/') or path.startswith(base + '?')):
        raise Refused(f'api reads only paths under {base}')
    data, _ = gh('GET', path)
    return {'data': data}


OPS = {'status': op_status, 'sync': op_sync, 'pr-list': op_pr_list, 'pr-view': op_pr_view, 'pr-diff': op_pr_diff,
       'pr-create': op_pr_create, 'pr-edit': op_pr_edit, 'comment': op_comment, 'issue-list': op_issue_list,
       'issue-view': op_issue_view, 'issue-create': op_issue_create, 'api': op_api}


# ---------- server ----------

def allowed_uids():
    uids = {0, os.getuid()}
    for name in os.environ.get('MASTAN_GH_CLIENTS', 'mastan').split(','):
        try:
            uids.add(pwd.getpwnam(name).pw_uid)
        except KeyError:
            pass
    return uids


def handle(conn, uids):
    if hasattr(socket, 'SO_PEERCRED'):
        import struct
        pid, uid, gid = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid not in uids:
            raise Refused(f'uid {uid} may not use the gate')
    f = conn.makefile('rb')
    line = f.readline(MAX_HEADER)
    if not line.endswith(b'\n'):
        raise Refused('header too long or missing')
    req = json.loads(line)
    op = req.get('op')
    if op == 'push':
        n = req.get('bundle_len', 0)
        if not isinstance(n, int) or n < 0 or n > MAX_BUNDLE:
            raise Refused(f'bundle must be under {MAX_BUNDLE >> 20} MB')
        if not n:
            return op_push(req, None)
        tmp = tempfile.mkdtemp(dir=PRIVATE, prefix='bundle-')
        try:
            path = os.path.join(tmp, 'in.bundle')
            with open(path, 'wb') as out:
                left = n
                while left:
                    chunk = f.read(min(left, 1 << 20))
                    if not chunk:
                        raise Refused('bundle cut short')
                    out.write(chunk)
                    left -= len(chunk)
            return op_push(req, path)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    if op not in OPS:
        raise Refused(f'unknown op {op!r}')
    return OPS[op](req)


def serve():
    os.makedirs(MIRRORS, exist_ok=True)
    os.makedirs(PRIVATE, mode=0o700, exist_ok=True)
    if os.environ.get('LISTEN_FDS') == '1' and os.environ.get('LISTEN_PID') == str(os.getpid()):
        srv = socket.socket(fileno=3)
    else:
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(SOCKET_PATH)
        os.chmod(SOCKET_PATH, 0o660)
        srv.listen(8)
    uids = allowed_uids()
    log(f'mastan-gh gate ready (conf {CONF})')
    while True:
        conn, _ = srv.accept()
        with conn:
            conn.settimeout(900)
            try:
                res = {'ok': True, **handle(conn, uids)}
            except Refused as e:
                res = {'ok': False, 'error': str(e)}
            except Exception as e:  # keep serving; never echo the token
                res = {'ok': False, 'error': scrub(f'gate error: {type(e).__name__}: {e}')}
                log(res['error'])
            try:
                conn.sendall((json.dumps(res) + '\n').encode())
            except OSError:
                pass


if __name__ == '__main__':
    serve()
