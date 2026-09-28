import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const shell = process.env.DEPLOY_TEST_SHELL || 'sh';
function shellPath(value) {
  if (process.platform !== 'win32') return value;
  const result = spawnSync(shell, ['-c', 'cygpath -u "$1"', 'probe', value], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function scenario(t, { failure = '', first = false, backup = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monitor-deploy-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^monitor-deploy-test-/);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'state'));
  if (!first) await writeFile(path.join(root, 'state', '100my-page-monitor'), 'old');
  if (backup) await writeFile(path.join(root, 'state', '100my-page-monitor-previous'), 'backup');
  await writeFile(path.join(root, 'monitor.env'), 'BASE_PATH=/3D/monitor\n');
  await writeFile(path.join(root, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(root, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(root, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_ROOT/commands"
if [ "$1" = --config ]; then shift 2; fi
state="$MOCK_ROOT/state"
case "$1" in
 container) test -f "$state/$3" ;;
 network|volume) exit 0 ;;
 login) cat >/dev/null ;;
 pull) [ "$FAILURE" != pull ] ;;
 run) [ "$FAILURE" != validate ] ;;
 create) [ "$FAILURE" != create ] || exit 1; shift; while [ "$1" != --name ]; do shift; done; printf new > "$state/$2" ;;
 exec) [ "$FAILURE" != route ] ;;
 inspect) case "$*" in *Running*) printf true ;; *) if [ "$FAILURE" = health ]; then printf unhealthy; else printf healthy; fi ;; esac ;;
 rename) mv "$state/$2" "$state/$3" ;;
 stop) exit 0 ;;
 start) [ "$FAILURE" != start ] || [ "$(cat "$state/$2")" = old ] ;;
 rm) shift; [ "$1" != -f ] || shift; rm -f "$state/$1" ;;
 *) exit 98 ;;
esac
`, { mode: 0o755 });
  const script = fileURLToPath(new URL('monitor.sh', import.meta.url));
  const result = spawnSync(shell, ['-c', 'PATH="$1:$PATH"; export PATH; [ "$(command -v docker)" = "$1/docker" ] || exit 99; exec sh "$2"', 'probe', shellPath(root), shellPath(script)], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, MOCK_ROOT: shellPath(root), MONITOR_ENV_FILE: shellPath(path.join(root, 'monitor.env')), DEPLOY_LOCK_FILE: shellPath(path.join(root, 'lock')), FAILURE: failure, GHCR_USER: 'test', GHCR_TOKEN: 'test', MONITOR_IMAGE: 'example.test/monitor:sha' },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.notEqual(result.status, 99);
  const state = Object.fromEntries(await Promise.all((await readdir(path.join(root, 'state'))).map(async name => [name, await readFile(path.join(root, 'state', name), 'utf8')])));
  return { ...result, state, commands: await readFile(path.join(root, 'commands'), 'utf8') };
}
test('independent workflow triggers and permanent-volume restricted deployment', async t => {
  const result = await scenario(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.state, { '100my-page-monitor': 'new' });
  assert.match(result.commands, /--read-only --cap-drop ALL/);
  assert.match(result.commands, /type=volume,src=100my-page-monitor-data,dst=\/app\/data/);
  assert.doesNotMatch(result.commands, /volume rm|stop 100my-page\n|--publish| -p /);
  const workflow = await readFile(new URL('../workflows/monitor-cicd.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \[master, main\]/);
  assert.match(workflow, /github.ref == 'refs\/heads\/master'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /needs: check/);
  assert.doesNotMatch(workflow, /working-directory: 3Dpagemonitor/);
  assert.doesNotMatch(workflow, /'3Dpage\/\*\*'|'\.github\/deploy\/\*\*'/);
});
test('first installation creates only monitor', async t => {
  const result = await scenario(t, { first: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.state, { '100my-page-monitor': 'new' });
});
for (const failure of ['pull', 'validate', 'create', 'start', 'health', 'route']) {
  test('rollback on ' + failure, async t => {
    const result = await scenario(t, { failure });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.state, { '100my-page-monitor': 'old' });
    assert.doesNotMatch(result.commands, /volume rm/);
  });
}
test('first-install failure removes only the newly-created container', async t => {
  const result = await scenario(t, { first: true, failure: 'health' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.state, {});
  assert.doesNotMatch(result.commands, /volume rm/);
});
test('unresolved backup is never replaced', async t => {
  const result = await scenario(t, { backup: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.state['100my-page-monitor-previous'], 'backup');
  assert.doesNotMatch(result.commands, /rename|stop/);
});
