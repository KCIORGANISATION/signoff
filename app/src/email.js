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

function compose(lang, name, vars) {
  const t = translator(lang);
  return { subject: t(`email.${name}.subject`, vars), text: t(`email.${name}.body`, vars) };
}

export function emailReviewRequest({ to, lang, devName, clientName, title, projectName, link }) {
  return sendEmail({ to, ...compose(lang, 'review', { dev: devName, client: clientName, title, project: projectName, link }) });
}

export function emailApproved({ to, lang, clientName, title, projectName, link }) {
  return sendEmail({ to, ...compose(lang, 'approved', { client: clientName, title, project: projectName, link }) });
}

export function emailFeedback({ to, lang, clientName, title, projectName, message, link }) {
  return sendEmail({ to, ...compose(lang, 'feedback', { client: clientName, title, project: projectName, message, link }) });
}

export function emailPasswordReset({ to, lang, link }) {
  return sendEmail({ to, ...compose(lang, 'reset', { link }) });
}

export function emailReviewReminder({ to, lang, devName, clientName, title, projectName, link }) {
  return sendEmail({ to, ...compose(lang, 'reminder', { dev: devName, client: clientName, title, project: projectName, link }) });
}

export function emailProjectClosed({ to, lang, devName, clientName, projectName }) {
  return sendEmail({ to, ...compose(lang, 'projectClosed', { dev: devName, client: clientName, project: projectName }) });
}
