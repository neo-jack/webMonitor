import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor } from '../server.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const event = (overrides = {}) => ({ id: crypto.randomUUID(), project: 'test-app', environment: 'test', session: 'session-1', type: 'error', name: 'Example failure', timestamp: Date.now(), url: 'https://example.com/scene?token=secret#private', stack: 'Error\n at https://example.com/app.js?token=secret:1:2', ...overrides });
async function start(t, options = {}) {
  const server = createMonitor({ dbPath: ':memory:', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, post: (events, headers = {}) => fetch(`${base}/api/ingest`, { method: 'POST', headers, body: JSON.stringify({ events }) }), get: query => fetch(`${base}/api/events${query || ''}`) };
}
test('ingestion deduplicates IDs, redacts URL/stack, filters project and persists resolved issues', async t => {
  const app = await start(t);
  const e = event({ name: 'Failure for person@example.com token=private' });
  assert.equal((await (await app.post([e, e])).json()).accepted, 1);
  const result = await (await app.get()).json();
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].url, 'https://example.com/scene');
  assert.ok(!JSON.stringify(result.events).includes('secret'));
  assert.ok(!result.events[0].name.includes('person@example.com'));
  assert.ok(!result.events[0].name.includes('private'));
  assert.equal((await (await app.get('?project=other')).json()).events.length, 0);
  assert.equal((await (await app.get('?environment=other')).json()).events.length, 0);
  const params = new URLSearchParams({ project: e.project, fingerprint: result.events[0].fingerprint });
  assert.equal((await fetch(`${app.base}/api/issues/resolve?${params}`, { method: 'POST' })).status, 200);
  assert.equal((await (await app.get()).json()).resolved.length, 1);
});
test('rejects malformed and oversized batches atomically', async t => {
  const app = await start(t);
  assert.equal((await app.post([event(), event({ project: '' })])).status, 400);
  assert.equal((await (await app.get()).json()).events.length, 0);
  assert.equal((await app.post([event({ value: -5 })])).status, 400);
  assert.equal((await app.post([event({ status: 700 })])).status, 400);
  assert.equal((await app.post([event({ timestamp: 1 })])).status, 400);
  assert.equal((await app.post(Array.from({ length: 51 }, () => event()))).status, 400);
  assert.equal((await app.post([event({ name: 'x'.repeat(70000) })])).status, 413);
  assert.equal((await fetch(`${app.base}/api/ingest`, { method: 'POST', body: '{invalid' })).status, 400);
});
test('public data access preserves ingestion and cross-origin boundaries', async t => {
  const app = await start(t, { allowedOrigins: ['https://allowed.example'] });
  assert.equal((await app.get()).status, 200);
  assert.equal((await app.post([event()], { Origin: 'https://evil.example' })).status, 403);
  const accepted = await app.post([event()], { Origin: 'https://allowed.example' });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get('access-control-allow-origin'), 'https://allowed.example');
  assert.equal((await fetch(`${app.base}/api/events`, {})).status, 200);
  assert.equal((await fetch(`${app.base}/api/events`, { headers: { Origin: 'https://allowed.example' } })).status, 403);
});
test('disk storage survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-monitor-test-'));
  const dbPath = join(directory, 'monitor.sqlite');
  let server;
  try {
    server = createMonitor({ dbPath });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await fetch(`http://127.0.0.1:${server.address().port}/api/ingest`, { method: 'POST', body: JSON.stringify({ events: [event()] }) });
    await new Promise(resolve => server.close(resolve));
    server = createMonitor({ dbPath });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const result = await (await fetch(`http://127.0.0.1:${server.address().port}/api/events`)).json();
    assert.equal(result.events.length, 1);
    await new Promise(resolve => server.close(resolve));
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('orbit-monitor-test-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('subpath routes preserve redirects, public access, same-origin HTTPS and isolate root APIs', async t => {
  const app = await start(t, { basePath: '/3D/monitor', publicOrigin: 'https://monitor.example' });
  const redirect = await fetch(app.base + '/3D/monitor?from=test', { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/3D/monitor/?from=test');
  assert.equal((await fetch(app.base + '/healthz')).status, 200);
  assert.equal((await app.get()).status, 404);
  const api = app.base + '/3D/monitor/api/';
  const accepted = await fetch(api + 'ingest', { method: 'POST', headers: { Origin: 'https://monitor.example' }, body: JSON.stringify({ events: [event()] }) });
  assert.equal(accepted.status, 202);
  assert.equal((await fetch(api + 'events')).status, 200);
  assert.equal((await fetch(api + 'events', { headers: { Origin: 'https://monitor.example' } })).status, 200);
  assert.equal((await fetch(api + 'events', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(api + 'demo/failure')).status, 503);
});
