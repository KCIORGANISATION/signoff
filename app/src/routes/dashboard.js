import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { milestonesWithProgress, nextStep, onboarding } from '../projects.js';

const router = Router();
const MAX_STEPS = 6;

// Home tab. A new account gets the three-step guide; afterwards, what to do next on each active project.
router.get('/dashboard', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const guide = await onboarding(userId);
  if (!guide.complete) return res.render('dashboard', { guide, steps: [], activeCount: 0 });

  const projects = await query(`SELECT * FROM projects WHERE user_id = $1 AND status = 'active' ORDER BY id`, [userId]);
  const milestones = await milestonesWithProgress(projects.map((p) => p.id));
  const steps = projects
    .map((project) => ({ project, ...nextStep(project, milestones.filter((m) => m.project_id === project.id)) }))
    .sort((a, b) => a.priority - b.priority || (b.days ?? 0) - (a.days ?? 0));

  res.render('dashboard', { guide, steps: steps.slice(0, MAX_STEPS), moreSteps: Math.max(0, steps.length - MAX_STEPS), activeCount: projects.length });
});

export default router;
