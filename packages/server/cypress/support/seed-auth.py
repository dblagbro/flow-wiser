"""Create only a disposable GitHub Actions authentication fixture via the supported CLI."""
import os
import pathlib
import pty
import secrets
import select
import subprocess
import sys
import re
import time

assert os.environ.get('CI') in ('true', '1'), 'Only run against an isolated CI database'
root = pathlib.Path(os.environ['RUNNER_TEMP']).resolve()
database = pathlib.Path(os.environ['DATABASE_PATH']).resolve()
assert database == root / 'flow-wiser-cypress-db', 'Refusing any other database path'
assert (database / 'database.sqlite').is_file(), 'Start the CI server and migrations first'
password = 'Cypress-A7!' + secrets.token_urlsafe(32)
master, slave = pty.openpty()
process = subprocess.Popen(
    ['node', 'bin/run', 'admin:create', '--email', 'cypress-auth@example.invalid',
     '--role', 'super-admin', '--name', 'Cypress authentication fixture'],
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
buffer = b''
stage = 0
deadline = time.monotonic() + 90
try:
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.5)[0]:
            try:
                buffer += os.read(master, 65536)
            except OSError:
                break
            if stage == 0 and b'New password for ' in buffer and buffer.rstrip().endswith(b':'):
                os.write(master, (password + chr(13)).encode())
                stage = 1
                buffer = b''
            elif stage == 1 and b'Repeat password:' in buffer:
                os.write(master, (password + chr(13)).encode())
                stage = 2
                buffer = b''
    process.wait(timeout=5)
    if process.returncode != 0 or stage != 2:
        diagnostic = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', buffer.decode(errors='replace')).replace(password, '[redacted]')
        diagnostic = ' '.join(diagnostic.split())
        print('CI fixture failed: exit=' + str(process.returncode) + ' prompt_stage=' + str(stage) + ' ' + diagnostic[-700:], file=sys.stderr)
        sys.exit(1)
    assert password.encode() not in buffer, 'CLI exposed generated fixture credential'
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
print('Created isolated CI account through the recovery CLI')
