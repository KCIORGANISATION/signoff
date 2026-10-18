import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, startServer } from './helpers.js';

// Production without the FILES_R2_* variables: the app runs, uploads are simply off.
let server;
before(async () => {
  server = await startServer({ files: 'disabled' });
});
after(() => server.stop());

test('without file storage the app works and the upload zone is replaced by a message', async () => {
  const dev = new Browser(server.base);
  assert.equal((await dev.get('/health')).status, 200);
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', name: 'No Files', email: 'nofiles@example.com', password: 'correct horse battery' });
  await dev.get('/projects/new');
  const project = await dev.post('/projects', { name: 'Site', client_name: 'Acme', client_email: 'acme@example.com', currency: 'EUR' });
  await dev.get(`${project.location}/milestones/new`);
  const milestone = await dev.post(`${project.location}/milestones`, { title: 'Design' });

  const page = await dev.get(milestone.location);
  assert.equal(page.status, 200);
  assert.match(page.text, /File uploads are not available on this server yet/);
  assert.doesNotMatch(page.text, /data-upload/);

  const upload = await dev.upload(`${milestone.location}/files`, [{ name: 'a.png', content: Buffer.from('x') }]);
  assert.equal(upload.status, 503);

  await dev.post(`${milestone.location}/send`);
  const sent = await dev.get(milestone.location);
  const reviewPath = new URL(sent.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
  const client = new Browser(server.base);
  assert.equal((await client.get(reviewPath)).status, 200);
  assert.equal((await client.post(`${reviewPath}/approve`)).status, 302);
  assert.equal((await dev.get(`${milestone.location}/certificate`)).status, 200);
});
