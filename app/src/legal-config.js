import { config } from './config.js';
import { formatters } from './format.js';

// The facts the privacy policy and the terms of use cannot state yet: the company does not
// exist yet, some durations are not decided, some provider regions are to be confirmed.
// Every value starts as null. While BETA_MODE is on, the pages show "[à compléter]" for it;
// with BETA_MODE off, the app warns at startup and test/legal.test.js fails, so nothing
// goes public with an empty field.
//
// A text is either one string for both languages, or { fr: '…', en: '…' }.
// Durations are numbers in the unit their name says. lastUpdated is a date: '2026-10-27'.
export const LEGAL = {
  companyName: null,
  legalForm: null,
  address: null,
  enterpriseNumber: null,
  vatNumber: null,
  // Falls back to CONTACT_EMAIL.
  contactEmail: null,
  legalRepresentative: null,
  // Falls back to BETA_RESPONSIBLE_NAME. Only shown, and only required, during the beta.
  betaResponsible: null,

  storageCleanupDays: null,
  backupRetentionDays: null,
  inactiveAccountMonths: null,
  billingRetentionYears: null,

  liabilityMonths: null,
  serviceEndNoticeDays: null,
  termsChangeNoticeDays: null,
  courtCity: null,

  regionRender: null,
  regionNeon: null,
  regionR2: null,
  regionGitHub: null,
  regionResend: null,
  regionDiscord: null,

  lastUpdated: null,
};

const BETA_ONLY = new Set(['betaResponsible']);

function resolved(values, settings) {
  return {
    ...values,
    contactEmail: values.contactEmail ?? (settings.contactEmail || null),
    betaResponsible: values.betaResponsible ?? (settings.beta.responsibleName || null),
  };
}

// The names of the values still empty for this setting of BETA_MODE.
export function legalGaps(values = LEGAL, settings = config) {
  const all = resolved(values, settings);
  return Object.keys(all).filter((key) => all[key] === null && (settings.beta.enabled || !BETA_ONLY.has(key)));
}

// The startup warning, or null when there is nothing to say.
export function legalWarning(values = LEGAL, settings = config) {
  if (settings.beta.enabled) return null;
  const gaps = legalGaps(values, settings);
  if (gaps.length === 0) return null;
  return `Legal pages: BETA_MODE is off but these values are still empty in src/legal-config.js: ${gaps.join(', ')}. The privacy policy and the terms show "[à compléter]" in their place.`;
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const UNITS = {
  Days: { fr: ['jour', 'jours'], en: ['day', 'days'] },
  Months: { fr: ['mois', 'mois'], en: ['month', 'months'] },
  Years: { fr: ['an', 'ans'], en: ['year', 'years'] },
};

// For the legal templates: legal('key') returns the value as safe HTML, a duration with its
// unit, the date in the page's language, or the "[à compléter]" mark.
export function legalText(lang, values = LEGAL, settings = config) {
  const all = resolved(values, settings);
  const fmt = formatters(lang);
  const missing = `<span class="placeholder">${lang === 'fr' ? '[à compléter]' : '[to be completed]'}</span>`;
  return (key) => {
    if (!(key in all)) throw new Error(`Unknown legal value: ${key}`);
    const value = all[key];
    if (value === null) return missing;
    if (key === 'lastUpdated') return escapeHtml(fmt.date(value));
    const unit = Object.keys(UNITS).find((suffix) => key.endsWith(suffix));
    if (unit && typeof value === 'number') {
      const [one, many] = UNITS[unit][lang] ?? UNITS[unit].en;
      return `${value} ${value === 1 ? one : many}`;
    }
    if (typeof value === 'object') return escapeHtml(value[lang] ?? value.en ?? value.fr);
    if (key === 'contactEmail') return `<a href="mailto:${escapeHtml(value)}">${escapeHtml(value)}</a>`;
    return escapeHtml(value);
  };
}
