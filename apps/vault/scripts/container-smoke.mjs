import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:4310';
const origin = process.env.VAULT_ORIGIN;
const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.VAULT_PASSWORD }) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
async function api(url, body) {
  const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal(response.status, 200, `${url} ${await response.clone().text()}`);
  return response;
}
await api('/api/examples', {});
const result = await (await api('/api/components')).json();
assert.equal(result.total, 4);
const table = result.items.find(item => item.slug === 'compact-table');
const preview = await (await api('/api/preview', { id: table.id })).json();
assert.ok(preview.html.includes('Content-Security-Policy'));
const selection = result.items.map(item => ({ id: item.id, revision: item.revision }));
const archive = await api('/api/export', { selection, format: 'zip' });
assert.ok((await archive.arrayBuffer()).byteLength > 1000);
const page = await fetch(base); assert.equal(page.status, 200);
console.log(JSON.stringify({ health: (await (await fetch(base + '/api/health')).json()).status, components: result.total, preview: 'compiled', export: 'zip ready', page: page.status }));
