// Starts the app on a random port with an in-memory database, and offers a tiny
// browser that keeps cookies and reads the CSRF token from each page.
process.env.NODE_ENV = 'test';
process.env.INVITE_CODE = 'beta-2026';
process.env.APP_URL = '';
// Tests use an in-memory database unless TEST_DATABASE_URL points to a throwaway Postgres.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
process.env.RESEND_API_KEY = '';
process.env.TRUST_PROXY = '1';
process.env.CRON_SECRET = 'test-cron-secret-0123456789abcdef0123';

const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { migrate, close } = await import('../src/db.js');
const { useStorage } = await import('../src/storage.js');
const { createApp } = await import('../src/app.js');
export const { testOutbox } = await import('../src/email.js');

// Uploaded files go to a temporary folder, or nowhere with { files: 'disabled' }.
export async function startServer({ files = 'disk' } = {}) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signoff-test-'));
  useStorage(files, { dir: uploadDir });
  await migrate();
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    uploadDir,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await close();
      fs.rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

export class Browser {
  constructor(base, headers = {}) {
    this.base = base;
    // The tests read English pages unless they ask for another language.
    this.headers = { 'accept-language': 'en', ...headers };
    this.cookies = new Map();
    this.csrf = null;
  }

  async request(method, path, form) {
    const url = path.startsWith('http') ? path : this.base + path;
    const headers = { ...this.headers, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const response = await fetch(url, { method, headers, body, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    const token = text.match(/name="_csrf" value="([^"]+)"/);
    if (token) this.csrf = token[1];
    return { status: response.status, location: response.headers.get('location'), headers: response.headers, text };
  }

  // Sends files the way the drop zone does: multipart, with the CSRF token as a form field.
  async upload(path, files, { json = true, csrf = this.csrf ?? '' } = {}) {
    const form = new FormData();
    form.append('_csrf', csrf);
    for (const file of files) form.append('files', new Blob([file.content], { type: file.type ?? 'application/octet-stream' }), file.name);
    const headers = { ...this.headers, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (json) headers.accept = 'application/json';
    const response = await fetch(this.base + path, { method: 'POST', headers, body: form, redirect: 'manual' });
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), headers: response.headers, text };
  }

  async download(path) {
    const headers = { ...this.headers, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    const response = await fetch(this.base + path, { headers, redirect: 'manual' });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  }

  get(path) {
    return this.request('GET', path);
  }

  // Posts a form the way a browser would, with the CSRF token of the last page seen.
  post(path, form = {}) {
    return this.request('POST', path, { _csrf: this.csrf ?? '', ...form });
  }
}

export function findLink(text) {
  return text.match(/https?:\/\/\S+/)[0];
}

// The client opens the milestone page of their link, then approves with their full name.
export async function approve(client, reviewPath, name = 'Jane Client') {
  await client.get(`${reviewPath}/review`);
  return client.post(`${reviewPath}/approve`, { name });
}
