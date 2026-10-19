import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { PERIODS, computeStats, loadStatsData, periodStart } from '../stats.js';

const router = Router();

// Statistics tab: computed on the server from the account's own projects, milestones and client answers.
router.get('/stats', requireAuth, async (req, res) => {
  const period = PERIODS.includes(req.query.period) ? req.query.period : '12m';
  const data = await loadStatsData(req.session.user.id);
  const stats = computeStats(data, { since: periodStart(period) });
  res.render('stats', { stats, period, periods: PERIODS });
});

export default router;
