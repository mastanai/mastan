#!/usr/bin/python3
"""OpenSSH forced command. Full root execution, one durable audit row per command.

No output is captured. SQLite and one JSONL line record intent before execution.
The fixed-width JSON exit slot is updated in place, without a second append.
A killed wrapper leaves an explicit NULL outcome, never a false success.
Command arguments must never contain credentials or client content.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess

BASE=Path('/var/log/mastan-ops')
def redact(command):
    return re.sub(r'(?:Bearer\s+\S+|sk-[\w-]{8,}|\d{6,}:[\w-]{20,}|(?:token|password|secret)=\S+)',
                  '[redacted]',command,flags=re.I)[:8192]

def execute(command,key='mastan-ops-dev01',base=BASE,spawn=subprocess.Popen):
    if not command or len(command)>65536:raise ValueError('command refused')
    base.mkdir(mode=0o700,parents=True,exist_ok=True)
    db=sqlite3.connect(base/'audit.sqlite');os.chmod(base/'audit.sqlite',0o600)
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY,time TEXT,key TEXT,command TEXT,exit_code INTEGER)')
    timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
    cur=db.execute('INSERT INTO commands(time,key,command) VALUES(?,?,?)',(timestamp,key,redact(command)));db.commit()
    path=base/'commands.jsonl'
    fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    prefix=json.dumps({'time':timestamp,'key':key,'command':redact(command)})[:-1]+', "exit_code": '
    line=prefix+'null'.rjust(11)+'}\n'
    fcntl.flock(fd,fcntl.LOCK_EX)
    start=os.lseek(fd,0,os.SEEK_END)
    os.write(fd,line.encode());os.fsync(fd)
    slot=start+len(prefix.encode())
    fcntl.flock(fd,fcntl.LOCK_UN)
    # sshd has already applied authorized_keys restrictions. No argv eval here;
    # the shell is intentional: the approved dedicated key grants full root.
    try:
        child=spawn(['/bin/bash','-c',command],env={k:v for k,v in os.environ.items() if k not in ('BASH_ENV','ENV','PYTHONPATH','LD_PRELOAD')})
    except BaseException:
        os.close(fd);db.close();raise
    old={}
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):
        old[sig]=signal.signal(sig,lambda s,_f:child.send_signal(s))
    try:code=child.wait()
    finally:
        for sig,handler in old.items():signal.signal(sig,handler)
    db.execute('UPDATE commands SET exit_code=? WHERE id=?',(code,cur.lastrowid));db.commit();db.close()
    try:
        os.pwrite(fd,str(code).rjust(11).encode(),slot);os.fsync(fd)
    finally:os.close(fd)
    return code if code>=0 else 128-code

if __name__=='__main__':
    try:
        if os.getuid()!=0:raise ValueError('root required')
        os.umask(0o077)
        raise SystemExit(execute(os.environ.get('SSH_ORIGINAL_COMMAND','')))
    except Exception:raise SystemExit(126)
