const base = new URL('./', location.href);
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = v => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(v);
const time = v => new Date(v).toLocaleTimeString('zh-CN', { hour12: false });
const date = v => new Date(v).toLocaleString('zh-CN', { hour12: false });
const percentile = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .75) - 1] : null;
let page = 'overview', events = [], resolved = [], search = '', loading = false, pending = false;
const titles = { overview: '概览', errors: '异常', performance: '性能', network: '请求', sessions: '会话', setup: '接入' };
const badge = (text, kind = '') => `<span class="pill ${kind}">${esc(text)}</span>`;
function empty(title = '暂无数据') { return `<div class="empty">${esc(title)}</div>`; }
function setPage(next) { page = next; search = ''; render(); }
function metric(name) {
  const latest = new Map();
  for (const e of events) if (e.type === 'vital' && e.name === name && e.value != null) { const key = `${e.project}:${e.session}:${e.metricId || e.url}`; if (!latest.has(key)) latest.set(key, e.value); }
  return { value: percentile([...latest.values()]), count: latest.size };
}
function groups() {
  const map = new Map();
  for (const e of events.filter(e => ['error', 'resource'].includes(e.type))) {
    const key = `${e.project}:${e.fingerprint}`;
    if (!map.has(key)) map.set(key, { ...e, count: 0, sessions: new Set(), resolved: resolved.some(r => r.project === e.project && r.fingerprint === e.fingerprint) });
    const item = map.get(key); item.count++; item.sessions.add(e.session);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
function stat(label, value, unit, foot) { return `<article class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}<small>${unit}</small></div><div class="stat-foot">${foot}</div></article>`; }
function vitals(names = ['LCP', 'INP', 'CLS']) {
  const info = { LCP: ['最大内容绘制', 2500, 4000], INP: ['交互响应延迟', 200, 500], CLS: ['累积布局偏移', .1, .25], FCP: ['首次内容绘制', 1800, 3000], TTFB: ['首字节时间', 800, 1800] };
  return `<div class="vitals">${names.map(name => {
    const m = metric(name), [label, good, poor] = info[name]; const rating = m.value === null ? '' : m.value <= good ? 'good' : m.value <= poor ? 'needs-improvement' : 'poor';
    const val = m.value === null ? '—' : name === 'CLS' ? m.value.toFixed(3) : name === 'LCP' || name === 'FCP' ? (m.value / 1000).toFixed(2) : number(m.value);
    const unit = name === 'CLS' ? '' : name === 'LCP' || name === 'FCP' ? 's' : 'ms';
    return `<div class="vital"><div class="vital-top">${name}<span class="muted">${label}</span><strong>${val} <small>${unit}</small></strong></div><div class="vital-track" data-rating="${rating}"><i></i><i></i><i></i></div><div class="vital-caption">${m.count ? `${m.count} 个指标样本 · P75 · ${rating === 'good' ? '体验良好' : rating === 'poor' ? '需要优化' : '建议改善'}` : '暂无样本'}</div></div>`;
  }).join('')}</div>`;
}
function chart() {
  const hours = Number($('hours').value), now = Date.now(), start = now - hours * 3600000;
  const count = hours === 1 ? 12 : hours <= 24 ? 24 : hours / 24;
  const bins = Array.from({ length: count }, () => ({ views: 0, errors: 0 }));
  const label = timestamp => new Date(timestamp).toLocaleString('zh-CN', hours > 24
    ? { month: '2-digit', day: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', hour12: false });
  for (const e of events) { if (e.timestamp < start || e.timestamp > now) continue; const index = Math.min(count - 1, Math.floor((e.timestamp - start) / (now - start) * count)); if (e.type === 'pageview') bins[index].views++; if (['error', 'resource'].includes(e.type)) bins[index].errors++; }
  const max = Math.max(1, ...bins.flatMap(b => [b.views, b.errors]));
  const points = key => bins.map((b, i) => `${30 + i / (count - 1) * 586.5},${145 - b[key] / max * 125}`).join(' ');
  return `<div class="chart"><svg viewBox="0 0 630 165" preserveAspectRatio="none" role="img" aria-label="访问量与异常数趋势"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#94d3a4" stop-opacity=".2"/><stop offset="100%" stop-color="#94d3a4" stop-opacity="0"/></linearGradient></defs>${[0, 1, 2, 3].map(n => `<line x1="30" x2="620" y1="${20 + n * 41.6}" y2="${20 + n * 41.6}" stroke="#2a3236" stroke-dasharray="3 5"/><text x="0" y="${24 + n * 41.6}" fill="#66757c" font-size="9">${Math.round(max * (1 - n / 3))}</text>`).join('')}<polygon points="30,145 ${points('views')} 616.5,145" fill="url(#chart-fill)"/><polyline points="${points('views')}" fill="none" stroke="#9fd8ac" stroke-width="2"/><polyline points="${points('errors')}" fill="none" stroke="#d88a97" stroke-width="1.5"/></svg>${!events.length ? '<div class="chart-empty">暂无数据</div>' : ''}<div class="chart-labels">${[0, 6, 12, 18, 24].map(n => `<span>${label(start + n / 24 * (now - start))}</span>`).join('')}</div></div>`;
}
function issueTable(limit = 1000) {
  const list = groups().filter(e => `${e.name} ${e.project}`.toLowerCase().includes(search.toLowerCase())).slice(0, limit);
  return list.length ? `<div class="table-wrap"><table><thead><tr><th>异常 / 应用</th><th>状态</th><th>发生次数</th><th>影响会话</th><th>最近发生</th></tr></thead><tbody>${list.map(e => `<tr class="clickable" data-event="${esc(e.id)}" tabindex="0"><td><div class="issue-title">${esc(e.name)}</div><div class="issue-subtitle">${esc(e.project)} · ${esc(e.url)}</div></td><td>${badge(e.resolved ? '已解决' : '待处理', e.resolved ? 'green' : '')}</td><td>${number(e.count)}</td><td>${e.sessions.size}</td><td class="muted">${time(e.timestamp)}</td></tr>`).join('')}</tbody></table></div>` : empty(search ? '没有匹配的异常' : '暂无异常', search ? '尝试更换关键词或筛选条件。' : '接入完成后，浏览器异常与资源错误会自动出现在这里。');
}
function overview() {
  const views = events.filter(e => e.type === 'pageview').length, sessions = new Set(events.map(e => `${e.project}:${e.session}`)), failures = new Set(events.filter(e => ['error', 'resource'].includes(e.type)).map(e => `${e.project}:${e.session}`));
  const errorCount = events.filter(e => ['error', 'resource'].includes(e.type)).length;
  const lcp = metric('LCP');
  return `<div class="stats">${stat('页面访问量', number(views), 'PV', `<span class="accent">${sessions.size}</span> 个访问会话`)}${stat('无异常会话', sessions.size ? (100 * (1 - failures.size / sessions.size)).toFixed(1) : '—', '%', 'JS / 资源错误')}${stat('捕获异常', number(errorCount), '次', `<span class="accent">${groups().length}</span> 组聚合问题`)}${stat('最大内容绘制 · P75', lcp.value == null ? '—' : (lcp.value / 1000).toFixed(2), 's', `${lcp.count} 个 LCP 样本`)}</div>
  <div class="two-columns"><article class="panel"><div class="panel-heading"><h2>流量与异常趋势</h2><div class="legend"><span><i></i>页面访问</span><span><i class="red"></i>异常事件</span></div></div>${chart()}</article><article class="panel"><div class="panel-heading"><h2>Core Web Vitals</h2><button class="text-button" data-goto="performance">查看详情 ↗</button></div>${vitals()}</article></div>
  <article class="panel"><div class="panel-heading"><h2>异常 <span>${groups().filter(e => !e.resolved).length} 待处理</span></h2><button class="text-button" data-goto="errors">全部异常 →</button></div>${issueTable(5)}</article>`;
}
function network() {
  const list = events.filter(e => e.type === 'network' && e.name.toLowerCase().includes(search.toLowerCase()));
  const failed = list.filter(e => e.status === 0 || e.status >= 400);
  return `<div class="stats">${stat('请求总数', list.length, '次', 'Fetch + XMLHttpRequest')}${stat('失败请求', failed.length, '次', 'HTTP ≥ 400 或网络错误')}${stat('成功率', list.length ? (100 * (1 - failed.length / list.length)).toFixed(1) : '—', '%', '当前筛选结果')}${stat('响应耗时 · P75', list.length ? number(percentile(list.map(e => e.value || 0))) : '—', 'ms', '浏览器端请求耗时')}</div><article class="panel"><div class="table-toolbar"><h2>请求明细</h2><input class="search" id="search" placeholder="搜索接口地址…" value="${esc(search)}"></div>${list.length ? `<div class="table-wrap"><table><thead><tr><th>接口地址</th><th>方法</th><th>状态</th><th>耗时</th><th>时间</th></tr></thead><tbody>${list.slice(0, 500).map(e => `<tr class="clickable" data-event="${esc(e.id)}" tabindex="0"><td><div class="issue-title">${esc(e.name)}</div><div class="issue-subtitle">${esc(e.project)}</div></td><td>${esc(e.method)}</td><td>${badge(e.status || '网络错误', e.status > 0 && e.status < 400 ? 'green' : '')}</td><td>${number(e.value || 0)} ms</td><td>${time(e.timestamp)}</td></tr>`).join('')}</tbody></table></div>` : empty()}</article>`;
}
function sessionsView() {
  const map = new Map();
  for (const e of events) { const key = `${e.project}:${e.session}`; if (!map.has(key)) map.set(key, { session: e.session, project: e.project, timestamp: e.timestamp, items: [] }); map.get(key).items.push(e); }
  return `<article class="panel"><div class="panel-heading"><h2>访问会话 <span>${map.size}</span></h2></div>${map.size ? `<div class="table-wrap"><table><thead><tr><th>会话 / 应用</th><th>页面访问</th><th>异常</th><th>事件总数</th><th>最近活跃</th></tr></thead><tbody>${[...map.values()].map(s => `<tr class="clickable" data-session="${esc(s.session)}" data-project="${esc(s.project)}" tabindex="0"><td><div>${esc(s.session.slice(0, 16))}…</div><div class="issue-subtitle">${esc(s.project)}</div></td><td>${s.items.filter(e => e.type === 'pageview').length}</td><td>${s.items.filter(e => ['error', 'resource'].includes(e.type)).length}</td><td>${s.items.length}</td><td>${time(s.timestamp)}</td></tr>`).join('')}</tbody></table></div>` : empty()}</article>`;
}
function setup() {
  const snippet = `<script src="${new URL('monitor.js', base)}"><\/script>\n<script>\n  const monitor = PageMonitor.init({\n    project: '3Dpage',\n    endpoint: '${new URL('api/ingest', base)}',\n    environment: 'production',\n    release: '1.0.0'\n  });\n<\/script>`;
  return `<article class="panel setup-card"><h2>浏览器 SDK</h2><pre id="snippet">${esc(snippet)}</pre><div class="setup-actions"><button class="secondary" id="copy">复制代码</button><a href="./demo.html" target="_blank" rel="noopener">测试采集 ↗</a></div><details><summary>配置与采集范围</summary><p>跨域接入需将应用 Origin 加入 ALLOWED_ORIGINS。HTTPS 页面使用 HTTPS 采集地址。</p><p>手动捕获：monitor.captureException(error)<br>自定义事件：monitor.track(name, value)</p><ul><li>JS / Promise / 资源错误，Fetch / XHR，路由与操作线索</li><li>LCP、INP、CLS、FCP、TTFB，指标 P75</li><li>URL 删除查询参数与 hash；不采集请求正文、Cookie、表单值或 DOM</li><li>数据默认保存 30 天；会话为事件时间线，不录制视频</li></ul></details></article>`;
}
function render() {
  $('page-title').textContent = titles[page];
  document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('error-count').textContent = groups().filter(e => !e.resolved).length;
  const views = { overview, errors: () => `<article class="panel"><div class="table-toolbar"><h2>异常列表 <span>${groups().length}</span></h2><input class="search" id="search" placeholder="搜索错误或应用…" value="${esc(search)}"></div>${issueTable()}</article>`, performance: () => `<div class="metric-grid">${['LCP', 'INP', 'CLS', 'FCP', 'TTFB'].map(name => `<article class="panel">${vitals([name])}</article>`).join('')}</div>`, network, sessions: sessionsView, setup };
  $('view').innerHTML = views[page]();
}
async function api(path, options = {}) {
  const response = await fetch(new URL(path.replace(/^\//, ''), base), options);
  if (!response.ok) throw new Error(`服务请求失败 (${response.status})`);
  return response.json();
}
function populate(id, values, label) { const selected = $(id).value; $(id).innerHTML = `<option value="">${label}</option>${values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`; $(id).value = values.includes(selected) ? selected : ''; }
async function refresh() {
  if (loading) { pending = true; return; }
  loading = true; $('refresh').disabled = true;
  const filters = { hours: $('hours').value, project: $('project').value, environment: $('environment').value };
  try {
    const result = await api(`/api/events?${new URLSearchParams(filters)}`);
    if (Object.entries(filters).some(([k, v]) => $(k).value !== v)) { pending = true; return; }
    events = result.events; resolved = result.resolved;
    populate('project', result.projects, '全部应用'); populate('environment', result.environments, '全部环境');
    $('connection').dataset.state = 'online';
    $('connection').title = `更新于 ${time(Date.now())}`;
    $('connection').setAttribute('aria-label', '已连接');
    $('notice').hidden = !result.truncated; $('notice').textContent = '当前范围超过 10,000 条事件，统计仅基于最近 10,000 条。请缩短时间范围。';
    const inputFocused = document.activeElement?.id === 'search';
    if (!inputFocused) render();
  } catch (error) { $('connection').dataset.state = 'error'; $('connection').title = error.message; $('connection').setAttribute('aria-label', error.message); $('notice').hidden = false; $('notice').textContent = error.message; }
  finally { loading = false; $('refresh').disabled = false; if (pending) { pending = false; void refresh(); } }
}
function showEvent(id) {
  const e = events.find(item => item.id === id); if (!e) return;
  $('detail-content').innerHTML = `<h2>${esc(e.name)}</h2><div class="details-grid">${[['应用', e.project], ['环境 / 版本', `${e.environment} / ${e.release || '未指定'}`], ['发生时间', date(e.timestamp)], ['页面', e.url], ['会话', e.session], ['事件类型', e.type]].map(([k, v]) => `<div><small>${k}</small>${esc(v)}</div>`).join('')}</div>${e.stack ? `<h3>异常堆栈</h3><pre>${esc(e.stack)}</pre>` : ''}${e.type === 'network' ? `<h3>请求结果</h3><pre>${esc(e.method)} ${esc(e.name)}\n状态: ${e.status} · 耗时: ${number(e.value)} ms</pre>` : ''}<h3>发生前的操作线索</h3>${e.breadcrumbs.length ? `<ul class="timeline">${e.breadcrumbs.map(b => `<li><time>${time(b.timestamp)}</time>${esc(b.type)} · ${esc(b.name)}</li>`).join('')}</ul>` : '<p class="muted">没有操作线索</p>'}${e.fingerprint ? `<div class="dialog-actions"><button class="primary" data-resolve="${esc(e.fingerprint)}" data-project="${esc(e.project)}">标记为已解决</button></div>` : ''}`;
  $('detail').showModal();
}
document.addEventListener('click', async event => {
  const el = event.target.closest('button,a,tr'); if (!el) return;
  if (el.dataset.page) setPage(el.dataset.page);
  if (el.dataset.goto) setPage(el.dataset.goto);
  if (el.dataset.event) showEvent(el.dataset.event);
  if (el.dataset.session) {
    const items = events.filter(e => e.session === el.dataset.session && e.project === el.dataset.project).sort((a, b) => a.timestamp - b.timestamp);
    $('detail-content').innerHTML = `<h2>会话时间线</h2><p class="muted">${esc(el.dataset.project)} · ${esc(el.dataset.session)}</p><ul class="timeline">${items.map(e => `<li><time>${time(e.timestamp)}</time>${badge(e.type, 'neutral')} ${esc(e.name)}</li>`).join('')}</ul>`; $('detail').showModal();
  }
  if (el.dataset.resolve) {
    el.disabled = true;
    try { await api(`/api/issues/resolve?${new URLSearchParams({ project: el.dataset.project, fingerprint: el.dataset.resolve })}`, { method: 'POST' }); $('detail').close(); await refresh(); } catch (error) { $('notice').textContent = error.message; $('notice').hidden = false; } finally { el.disabled = false; }
  }
  if (el.id === 'copy') { try { await navigator.clipboard.writeText($('snippet').textContent); el.textContent = '已复制 ✓'; } catch { el.textContent = '请手动选择上方代码复制'; } }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('tr.clickable')) e.target.click(); });
document.addEventListener('input', e => { if (e.target.id === 'search') { const position = e.target.selectionStart; search = e.target.value; render(); $('search').focus(); $('search').setSelectionRange(position, position); } });
for (const id of ['project', 'environment', 'hours']) $(id).addEventListener('change', refresh);
$('refresh').onclick = refresh;
$('close-detail').onclick = () => $('detail').close();
render(); void refresh(); setInterval(() => { if (!document.hidden && !$('detail').open) void refresh(); }, 10000);
