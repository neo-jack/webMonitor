import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const chartSource = source.slice(source.indexOf('function chart()'), source.indexOf('function issueTable('));
// The chart displays local time; keep the fixture at local noon in every runner timezone.
const now = new Date(2026, 8, 24, 12, 0, 0).getTime();
function render(hours, events = []) {
  return vm.runInNewContext(`${chartSource}\nchart()`, {
    $: () => ({ value: String(hours) }), events,
    Date: class extends Date { static now() { return now; } },
  });
}
const line = html => html.match(/<polyline points="([^"]+)"/)[1].split(' ');
const labels = html => html.split('<div class="chart-labels">')[1];

test('trend switches between five-minute, hourly and daily buckets with readable axes', () => {
  const results = [1, 24, 168, 720].map(hours => render(hours));
  assert.deepEqual(results.map(html => line(html).length), [12, 24, 7, 30]);
  assert.match(labels(results[0]), /11:00/);
  assert.match(labels(results[2]), /09\/17/);
  assert.match(labels(results[3]), /08\/25/);
  assert.equal(new Set(results.map(labels)).size, 4);
});

test('range changes include historical traffic without clamping out-of-range events', () => {
  const events = [
    { type: 'pageview', timestamp: now - 2 * 3600000 },
    { type: 'pageview', timestamp: now - 40 * 86400000 },
    { type: 'error', timestamp: now + 3600000 },
  ];
  assert.ok(line(render(1, events)).every(point => point.endsWith(',145')));
  assert.equal(line(render(24, events)).filter(point => !point.endsWith(',145')).length, 1);
  const html = render(720, events);
  const errors = html.match(/<polyline points="([^"]+)" fill="none" stroke="#d88a97"/)[1];
  assert.ok(errors.split(' ').every(point => point.endsWith(',145')));
});
