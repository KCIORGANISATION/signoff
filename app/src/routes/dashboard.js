import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { milestonesWithProgress, nextStep, onboarding } from '../projects.js';
import { activityLabel, findUser } from '../profile.js';
import { computeHome, loadStatsData } from '../stats.js';

const router = Router();
const MAX_STEPS = 6;
export const HOME_CHARTS = ['projects', 'amounts', 'milestones'];

// Home tab: the greeting, the first-launch guide or what to do next on each active project, and a chart.
router.get('/dashboard', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const [user, guide, data] = await Promise.all([findUser(userId), onboarding(userId), loadStatsData(userId)]);
  const chart = HOME_CHARTS.includes(req.query.chart) ? req.query.chart : 'projects';

  const projects = await query(`SELECT * FROM projects WHERE user_id = $1 AND status = 'active' ORDER BY id`, [userId]);
  const milestones = await milestonesWithProgress(projects.map((p) => p.id));
  const steps = projects
    .map((project) => ({ project, ...nextStep(project, milestones.filter((m) => m.project_id === project.id)) }))
    .sort((a, b) => a.priority - b.priority || (b.days ?? 0) - (a.days ?? 0));

  res.render('dashboard', {
    user,
    activity: activityLabel(req.t, user),
    guide,
    steps: steps.slice(0, MAX_STEPS),
    moreSteps: Math.max(0, steps.length - MAX_STEPS),
    activeCount: projects.length,
    home: computeHome(data),
    chart,
    charts: HOME_CHARTS,
  });
});

export default router;
