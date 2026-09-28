import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const text = (v, limit = 500) => typeof v === 'string' ? v.slice(0, limit) : '';
function cleanUrl(v) {
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}`.slice(0, 1000) : ''; } catch { return text(v).split(/[?#]/)[0]; }
}
function redact(v) {
  return text(v, 6000).replace(/https?:\/\/[^\s)]+/g, cleanUrl).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]').replace(/(token|password|authorization|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}
export function createMonitor({ dbPath = resolve(root, 'data/monitor.sqlite'), allowedOrigins = [], retentionDays = 30, basePath = '', publicOrigin = '', trustProxy = false } = {}) {
  basePath = basePath.replace(/\/$/, '');
  if (basePath && !/^\/[a-zA-Z0-9_/-]+$/.test(basePath)) throw new Error('Invalid BASE_PATH');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, project TEXT NOT NULL, environment TEXT NOT NULL, session TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, timestamp INTEGER NOT NULL, received INTEGER NOT NULL, value REAL, status INTEGER, fingerprint TEXT, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_filter ON events(project, environment, timestamp);
    CREATE TABLE IF NOT EXISTS issues (project TEXT NOT NULL, fingerprint TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project, fingerprint));`);
  const insert = db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const prune = () => db.prepare('DELETE FROM events WHERE received < ?').run(Date.now() - retentionDays * 86400000);
  prune();
  const housekeeping = setInterval(prune, 3600000); housekeeping.unref();
  const rates = new Map();
  const rateReset = setInterval(() => rates.clear(), 60000); rateReset.unref();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    const localOrigin = origin && (publicOrigin ? origin === publicOrigin : origin === `http://${req.headers.host}`);
    const permitted = !origin || localOrigin || allowedOrigins.includes(origin);
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/healthz' && req.method === 'GET') return json(200, { status: 'ok' });
    if (basePath) {
      if (url.pathname === basePath) { res.writeHead(308, { Location: `${basePath}/${url.search}` }); return res.end(); }
      if (!url.pathname.startsWith(`${basePath}/`)) return json(404, { error: 'Not found' });
      url.pathname = url.pathname.slice(basePath.length);
    }
    // Only the public ingestion endpoint supports cross-origin access.
    if (url.pathname === '/api/ingest' && origin && permitted) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    try {
      if (url.pathname === '/api/ingest') {
        if (!permitted) return json(403, { error: 'Origin not allowed' });
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        if (req.method !== 'POST') return json(405, { error: 'POST required' });
        const ip = trustProxy && req.headers['x-real-ip'] ? String(req.headers['x-real-ip']).slice(0, 100) : req.socket.remoteAddress;
        const count = (rates.get(ip) || 0) + 1; rates.set(ip, count);
        if (count > 120) return json(429, { error: 'Rate limited' });
        if (rates.size > 10000) return json(503, { error: 'Capacity exceeded' });
        let bytes = 0, chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 65536) return json(413, { error: 'Batch exceeds 64 KiB' });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(400, { error: 'Invalid JSON' }); }
        if (!body || !Array.isArray(body.events) || !body.events.length || body.events.length > 50) return json(400, { error: 'Expected 1–50 events' });
        const records = [];
        for (const e of body.events) {
          if (!e || !['error', 'resource', 'network', 'vital', 'pageview', 'custom'].includes(e.type) || !/^[\w.-]{1,64}$/.test(e.project || '') || typeof e.id !== 'string' || !e.id || e.id.length > 100 || typeof e.session !== 'string' || !e.session || !Number.isFinite(e.timestamp) || Math.abs(Date.now() - e.timestamp) > 7 * 86400000) return json(400, { error: 'Invalid event schema or timestamp' });
          if (e.value != null && (!Number.isFinite(e.value) || e.value < 0)) return json(400, { error: 'Invalid numeric value' });
          if (e.status != null && (!Number.isInteger(e.status) || e.status < 0 || e.status > 599)) return json(400, { error: 'Invalid HTTP status' });
          const event = { id: e.id, project: e.project, environment: text(e.environment, 40) || 'production', session: text(e.session, 100), type: e.type, name: redact(text(e.name, 500)), timestamp: e.timestamp, url: cleanUrl(e.url), release: text(e.release, 80), value: e.value ?? null, status: e.status ?? null, method: text(e.method, 10), stack: redact(e.stack), metricId: text(e.metricId, 100), browser: text(e.browser, 100), breadcrumbs: Array.isArray(e.breadcrumbs) ? e.breadcrumbs.slice(-15).map(b => ({ type: text(b?.type, 30), name: redact(text(b?.name, 200)), timestamp: Number.isFinite(b?.timestamp) ? b.timestamp : 0 })) : [] };
          event.fingerprint = ['error', 'resource'].includes(e.type) ? createHash('sha256').update(`${event.type}:${event.name}:${event.stack.split('\n')[1] || ''}`).digest('hex').slice(0, 20) : '';
          records.push(event);
        }
        let accepted = 0;
        db.exec('BEGIN');
        try {
          for (const e of records) accepted += Number(insert.run(e.id, e.project, e.environment, e.session, e.type, e.name, e.timestamp, Date.now(), e.value, e.status, e.fingerprint, JSON.stringify(e)).changes);
          db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
        return json(202, { accepted });
      }
      if (url.pathname === '/api/demo/failure' && req.method === 'GET') return json(503, { error: 'Intentional demo failure' });
      if (url.pathname.startsWith('/api/')) {
        if (origin && !localOrigin) return json(403, { error: 'Same-origin access required' });

        if (url.pathname === '/api/events' && req.method === 'GET') {
          const hours = Math.max(1, Math.min(720, Number(url.searchParams.get('hours')) || 24));
          const project = url.searchParams.get('project') || '';
          const environment = url.searchParams.get('environment') || '';
          const where = 'timestamp >= ? AND (? = \'\' OR project = ?) AND (? = \'\' OR environment = ?)';
          const args = [Date.now() - hours * 3600000, project, project, environment, environment];
          const rows = db.prepare(`SELECT payload FROM events WHERE ${where} ORDER BY timestamp DESC LIMIT 10000`).all(...args);
          const total = db.prepare(`SELECT COUNT(*) AS count FROM events WHERE ${where}`).get(...args).count;
          const projects = db.prepare('SELECT DISTINCT project FROM events ORDER BY project').all().map(r => r.project);
          const environments = db.prepare('SELECT DISTINCT environment FROM events ORDER BY environment').all().map(r => r.environment);
          return json(200, { events: rows.map(r => JSON.parse(r.payload)), projects, environments, total, truncated: total > 10000, resolved: db.prepare('SELECT project, fingerprint FROM issues WHERE resolved = 1').all() });
        }
        if (url.pathname === '/api/issues/resolve' && req.method === 'POST') {
          const project = url.searchParams.get('project'); const fingerprint = url.searchParams.get('fingerprint');
          if (!project || !/^[a-f0-9]{20}$/.test(fingerprint || '')) return json(400, { error: 'Invalid issue' });
          db.prepare('INSERT INTO issues VALUES (?, ?, 1) ON CONFLICT(project, fingerprint) DO UPDATE SET resolved = 1').run(project, fingerprint);
          return json(200, { ok: true });
        }
        return json(404, { error: 'Not found' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: 'GET required' });
      const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/monitor.js': 'monitor.js', '/demo.html': 'demo.html', '/favicon.svg': 'favicon.svg' };
      const file = files[url.pathname];
      if (!file) return json(404, { error: 'Not found' });
      let content;
      try { content = readFileSync(resolve(root, 'dist', file)); } catch { return json(503, { error: 'Run npm run build first' }); }
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      console.error('Monitor request failed:', error.message);
      if (!res.headersSent) json(500, { error: 'Internal server error' }); else res.end();
    }
  });
  server.on('close', () => { clearInterval(housekeeping); clearInterval(rateReset); db.close(); });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const days = Number(process.env.RETENTION_DAYS || 30);
  if (!Number.isFinite(days) || days < 1) throw new Error('RETENTION_DAYS must be >= 1');
  createMonitor({ allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean), retentionDays: days, basePath: process.env.BASE_PATH || '', publicOrigin: process.env.PUBLIC_ORIGIN || '', trustProxy: process.env.TRUST_PROXY === '1' }).listen(Number(process.env.PORT || 4318), host, () => console.log(`Page Monitor → http://${host}:${process.env.PORT || 4318}${process.env.BASE_PATH || ''}/`));
}
