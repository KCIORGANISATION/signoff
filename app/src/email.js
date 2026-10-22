import { Resend } from 'resend';
import { config } from './config.js';
import { translator } from './i18n.js';

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

// Emails sent while running the tests, so they can read the links inside.
export const testOutbox = [];

// Sends a plain-text email through Resend. Without RESEND_API_KEY the email is
// printed in the terminal instead. A failed send is logged and never breaks the page.
export async function sendEmail({ to, subject, text }) {
  if (config.test) {
    testOutbox.push({ to, subject, text });
    return;
  }
  if (!resend) {
    console.log(`\n[email to ${to}] ${subject}\n${text}\n`);
    return;
  }
  try {
    const { error } = await resend.emails.send({ from: config.emailFrom, to, subject, text });
    if (error) console.error('Resend error:', error.name, error.message);
  } catch (error) {
    console.error('Could not send email:', error.message);
  }
}

// term: the freelancer's word for a milestone (vocabulary.js), in emails to them and to their client.
function compose(lang, name, vars, term) {
  const t = translator(lang, term);
  return { subject: t(`email.${name}.subject`, vars), text: t(`email.${name}.body`, vars) };
}

export function emailReviewRequest({ to, lang, term, devName, clientName, title, projectName, link }) {
  return sendEmail({ to, ...compose(lang, 'review', { dev: devName, client: clientName, title, project: projectName, link }, term) });
}

export function emailApproved({ to, lang, term, clientName, title, projectName, link }) {
  return sendEmail({ to, ...compose(lang, 'approved', { client: clientName, title, project: projectName, link }, term) });
}

export function emailFeedback({ to, lang, term, clientName, title, projectName, message, link }) {
  return sendEmail({ to, ...compose(lang, 'feedback', { client: clientName, title, project: projectName, message, link }, term) });
}

export function emailPasswordReset({ to, lang, term, link }) {
  return sendEmail({ to, ...compose(lang, 'reset', { link }, term) });
}

export function emailReviewReminder({ to, lang, term, devName, clientName, title, projectName, link }) {
  return sendEmail({ to, ...compose(lang, 'reminder', { dev: devName, client: clientName, title, project: projectName, link }, term) });
}

export function emailProjectClosed({ to, lang, term, devName, clientName, projectName }) {
  return sendEmail({ to, ...compose(lang, 'projectClosed', { dev: devName, client: clientName, project: projectName }, term) });
}

export function emailFeedbackOverLimit({ to, lang, term, clientName, title, projectName, message, round, limit, link }) {
  return sendEmail({ to, ...compose(lang, 'overLimit', { client: clientName, title, project: projectName, message, round, limit, link }, term) });
}

export function emailDeadlineReminder({ to, lang, term, devName, clientName, title, projectName, date, link }) {
  return sendEmail({ to, ...compose(lang, 'deadline', { dev: devName, client: clientName, title, project: projectName, date, link }, term) });
}

export function emailDeadlinePassed({ to, lang, term, clientName, title, projectName, date, link }) {
  return sendEmail({ to, ...compose(lang, 'overdue', { client: clientName, title, project: projectName, date, link }, term) });
}

export function emailSupplementProposed({ to, lang, term, devName, clientName, title, projectName, amount, link }) {
  return sendEmail({ to, ...compose(lang, 'supplement', { dev: devName, client: clientName, title, project: projectName, amount, link }, term) });
}

export function emailSupplementDecided({ to, lang, term, clientName, title, projectName, accepted, comment, link }) {
  const name = accepted ? 'supplementAccepted' : 'supplementDeclined';
  return sendEmail({ to, ...compose(lang, name, { client: clientName, title, project: projectName, comment: comment || '–', link }, term) });
}
