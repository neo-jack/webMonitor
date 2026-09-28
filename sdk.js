import { onCLS, onINP, onLCP, onFCP, onTTFB } from 'web-vitals';

let active;
export function init(options = {}) {
  if (active) return active;
  if (!/^[\w.-]{1,64}$/.test(options.project || '')) throw new Error('PageMonitor: project is required');
  const endpoint = new URL(options.endpoint || '/api/ingest', location.href).href;
  const nativeFetch = window.fetch;
  const queue = [], crumbs = [], cleanup = [];
  let stopped = false, sending = false, failures = 0, retryAt = 0;
  let session;
  try { session = sessionStorage.getItem('page-monitor-session') || crypto.randomUUID(); sessionStorage.setItem('page-monitor-session', session); } catch { session = crypto.randomUUID(); }
  const safeUrl = v => { try { const u = new URL(v, location.href); return `${u.origin}${u.pathname}`; } catch { return ''; } };
  const clean = v => String(v ?? '').slice(0, 5000).replace(/https?:\/\/[^\s)]+/g, safeUrl).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]').replace(/(token|password|authorization|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  const breadcrumb = (type, name) => { crumbs.push({ type, name: clean(name).slice(0, 200), timestamp: Date.now() }); if (crumbs.length > 15) crumbs.shift(); };
  function record(type, name, data = {}) {
    if (stopped) return;
    try {
      const event = { ...data, id: crypto.randomUUID(), project: options.project, environment: options.environment || 'production', release: options.release || '', session, type, name: clean(name).slice(0, 500), timestamp: Date.now(), url: safeUrl(location.href), browser: navigator.userAgent.slice(0, 100), breadcrumbs: [...crumbs] };
      if (options.beforeSend && options.beforeSend(event) === false) return;
      queue.push(event); if (queue.length > 100) queue.shift();
    } catch { /* Telemetry must never break the host page. */ }
  }
  async function flush(beacon = false) {
    if (sending || !queue.length || (!beacon && Date.now() < retryAt)) return;
    const batch = [];
    while (queue.length && batch.length < 20) {
      if (new Blob([JSON.stringify({ events: [...batch, queue[0]] })]).size > 55000) { if (!batch.length) queue.shift(); break; }
      batch.push(queue.shift());
    }
    if (!batch.length) return;
    const body = JSON.stringify({ events: batch });
    if (beacon && navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
    sending = true;
    try {
      const response = await nativeFetch.call(window, endpoint, { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, keepalive: true, credentials: 'omit' });
      if (!response.ok) throw new Error('Upload failed');
      failures = 0; retryAt = 0;
    } catch {
      failures++; retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
      if (failures <= 5) queue.unshift(...batch);
      queue.splice(100);
    } finally { sending = false; }
  }
  const listen = (target, type, handler, capture = false) => { target.addEventListener(type, handler, capture); cleanup.push(() => target.removeEventListener(type, handler, capture)); };
  listen(window, 'error', e => {
    if (e.target !== window) { record('resource', `资源加载失败: ${safeUrl(e.target?.src || e.target?.href || '')}`); return; }
    record('error', e.message || 'Unknown error', { stack: clean(e.error?.stack || `${safeUrl(e.filename)}:${e.lineno}:${e.colno}`) });
  }, true);
  listen(window, 'unhandledrejection', e => record('error', `UnhandledRejection: ${clean(e.reason?.message || e.reason)}`, { stack: clean(e.reason?.stack || '') }));
  listen(document, 'click', e => { const el = e.target?.closest?.('button,a,[data-monitor]'); if (el) breadcrumb('click', el.getAttribute('data-monitor') || el.tagName.toLowerCase()); }, true);
  const isSelf = url => safeUrl(url) === safeUrl(endpoint);
  const wrappedFetch = async function (...args) {
    const input = args[0]; const url = input instanceof Request ? input.url : String(input);
    const start = performance.now();
    try {
      const response = await nativeFetch.apply(this, args);
      if (!stopped && !isSelf(url)) record('network', safeUrl(url), { value: performance.now() - start, status: response.status, method: args[1]?.method || (input instanceof Request ? input.method : 'GET') });
      return response;
    } catch (error) {
      if (!stopped && !isSelf(url)) record('network', safeUrl(url), { value: performance.now() - start, status: 0, method: args[1]?.method || (input instanceof Request ? input.method : 'GET') });
      throw error;
    }
  };
  window.fetch = wrappedFetch;
  cleanup.push(() => { if (window.fetch === wrappedFetch) window.fetch = nativeFetch; });
  const xhrOpen = XMLHttpRequest.prototype.open, xhrSend = XMLHttpRequest.prototype.send;
  const metadata = new WeakMap();
  function open(method, url, ...rest) { metadata.set(this, { method, url: String(url) }); return xhrOpen.call(this, method, url, ...rest); }
  function send(...args) {
    const data = metadata.get(this); const start = performance.now();
    if (data && !isSelf(data.url)) this.addEventListener('loadend', () => record('network', safeUrl(data.url), { value: performance.now() - start, status: this.status, method: data.method }), { once: true });
    return xhrSend.apply(this, args);
  }
  XMLHttpRequest.prototype.open = open; XMLHttpRequest.prototype.send = send;
  cleanup.push(() => { if (XMLHttpRequest.prototype.open === open) XMLHttpRequest.prototype.open = xhrOpen; if (XMLHttpRequest.prototype.send === send) XMLHttpRequest.prototype.send = xhrSend; });
  const pageview = () => { breadcrumb('navigation', safeUrl(location.href)); record('pageview', location.pathname); };
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    const wrapper = function (...args) { const previous = location.href; const result = original.apply(this, args); if (location.href !== previous) pageview(); return result; };
    history[method] = wrapper; cleanup.push(() => { if (history[method] === wrapper) history[method] = original; });
  }
  listen(window, 'popstate', pageview); listen(window, 'hashchange', pageview);
  for (const observe of [onLCP, onINP, onCLS, onFCP, onTTFB]) observe(metric => record('vital', metric.name, { value: metric.value, metricId: metric.id }), { reportAllChanges: true });
  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(true); });
  listen(window, 'pagehide', () => void flush(true));
  const interval = setInterval(() => void flush(), 5000);
  pageview();
  active = {
    captureException(error) { record('error', error?.message || error, { stack: clean(error?.stack || '') }); },
    track(name, value) { record('custom', name, { value: Number.isFinite(value) && value >= 0 ? value : null }); },
    flush: () => flush(),
    stop() { void flush(true); stopped = true; clearInterval(interval); cleanup.forEach(fn => fn()); active = undefined; }
  };
  return active;
}
