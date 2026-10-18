// Starts the app on a random port with an in-memory database, and offers a tiny
// browser that keeps cookies and reads the CSRF token from each page.
process.env.NODE_ENV = 'test';
process.env.INVITE_CODE = 'beta-2026';
process.env.APP_URL = '';
// Tests use an in-memory database unless TEST_DATABASE_URL points to a throwaway Postgres.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
process.env.RESEND_API_KEY = '';
process.env.TRUST_PROXY = '1';

const { migrate, close } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
export const { testOutbox } = await import('../src/email.js');

export async function startServer() {
  await migrate();
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await close();
    },
  };
}

export class Browser {
  constructor(base, headers = {}) {
    this.base = base;
    this.headers = headers;
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
