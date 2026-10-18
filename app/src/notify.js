// Emails the developer when something happens on a milestone.
// With RESEND_API_KEY and EMAIL_FROM set, mail goes through Resend.
// Otherwise the message is printed in the terminal.
export async function notifyDeveloper({ to, subject, text }) {
  const { RESEND_API_KEY, EMAIL_FROM } = process.env;

  if (!RESEND_API_KEY || !EMAIL_FROM) {
    console.log(`\n[email to ${to}] ${subject}\n${text}\n`);
    return;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, text }),
    });
    if (!response.ok) console.error('Resend error:', response.status, await response.text());
  } catch (error) {
    console.error('Could not send email:', error.message);
  }
}
