import crypto from 'node:crypto';
import { Router } from 'express';
import { baseUrl, config } from '../config.js';
import { checkDeadlines } from '../deadlines.js';

// Called by the scheduled GitHub Actions workflow (or any monitor) with
// "Authorization: Bearer <CRON_SECRET>". It sits before the CSRF check: the secret is the
// protection. Calling it twice changes nothing more than calling it once.
const router = Router();

// Both sides are hashed first, so the comparison takes the same time whatever their length.
function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

router.all('/cron/deadlines', async (req, res) => {
  if (!config.cronSecret) return res.status(404).json({ error: 'not configured' });
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).set('Allow', 'GET, POST').end();
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !sameSecret(token, config.cronSecret)) return res.status(401).json({ error: 'unauthorized' });

  const done = await checkDeadlines({ baseUrl: baseUrl(req) });
  res.set('Cache-Control', 'no-store').json({ status: 'ok', ...done });
});

export default router;
