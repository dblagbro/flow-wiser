"""Create only a disposable GitHub Actions authentication fixture via the supported CLI."""
import os
import pathlib
import pty
import secrets
import select
import subprocess
import sys
import re
import sqlite3
import time

assert os.environ.get('CI') in ('true', '1'), 'Only run against an isolated CI database'
root = pathlib.Path(os.environ['RUNNER_TEMP']).resolve()
database = pathlib.Path(os.environ['DATABASE_PATH']).resolve()
run_id = os.environ['GITHUB_RUN_ID']
attempt = os.environ['GITHUB_RUN_ATTEMPT']
assert run_id.isdigit() and attempt.isdigit(), 'Expected numeric CI run identifiers'
assert database == root / ('flow-wiser-cypress-' + run_id + '-' + attempt), 'Refusing any other database path'
assert (database / 'database.sqlite').is_file(), 'Start the CI server and migrations first'
def fixture_ready():
    with sqlite3.connect('file:' + str(database / 'database.sqlite') + '?mode=ro', uri=True) as connection:
        rows = connection.execute(
            'SELECT u.name, EXISTS(SELECT 1 FROM identity_workspace_user w WHERE w.userId=u.id), '
            'EXISTS(SELECT 1 FROM identity_organization_user o WHERE o.userId=u.id) '
            'FROM identity_user u WHERE u.email=?', ('cypress-auth@example.invalid',)).fetchall()
    if not rows:
        return False
    assert rows == [('Cypress authentication fixture', 1, 1)], 'Unexpected existing fixture identity'
    return True


if fixture_ready():
    print('Isolated CI account ready')
    sys.exit(0)

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
assert fixture_ready(), 'CLI did not create a complete fixture identity'
print('Isolated CI account ready')
