import { queryOne } from './db.js';

// The kinds of freelance work the sign-up questionnaire offers. The key is stored;
// the wording, and later the examples shown in the app, can follow it.
export const ACTIVITIES = ['web_dev', 'video', 'design', 'illustration', 'writing', 'photography', 'other'];
export const DELIVERIES = ['files', 'links', 'both'];
export const NAME_MAX_LENGTH = 80;
export const BUSINESS_NAME_MAX_LENGTH = 120;
export const ACTIVITY_OTHER_MAX_LENGTH = 60;

export function hasNames(user) {
  return Boolean(user?.first_name && user?.last_name);
}

function cleanLine(value, max) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text.length > max ? false : text;
}

// First and last name: both required, one line each.
export function readNames(body) {
  const values = { first_name: cleanLine(body.first_name, NAME_MAX_LENGTH), last_name: cleanLine(body.last_name, NAME_MAX_LENGTH) };
  const error = values.first_name === false || values.last_name === false
    ? 'profile.error.length'
    : !values.first_name || !values.last_name ? 'profile.error.names' : null;
  return {
    values: {
      first_name: values.first_name === false ? String(body.first_name ?? '') : values.first_name,
      last_name: values.last_name === false ? String(body.last_name ?? '') : values.last_name,
    },
    error,
  };
}

// The two optional questions. Anything not offered is treated as no answer.
export function readQuestionnaire(body) {
  const activity = ACTIVITIES.includes(body.activity) ? body.activity : null;
  const other = activity === 'other' ? cleanLine(body.activity_other, ACTIVITY_OTHER_MAX_LENGTH) : '';
  return {
    values: {
      activity,
      activity_other: other === false ? String(body.activity_other ?? '') : other || null,
      delivers: DELIVERIES.includes(body.delivers) ? body.delivers : null,
    },
    error: other === false ? 'profile.error.activityOther' : null,
  };
}

// The line under the greeting: "Web development", or what the developer typed for "Other".
export function activityLabel(t, user) {
  if (!user.activity) return null;
  if (user.activity === 'other') return user.activity_other || t('activity.other');
  return t(`activity.${user.activity}`);
}

export function findUser(userId) {
  return queryOne('SELECT * FROM users WHERE id = $1', [userId]);
}
