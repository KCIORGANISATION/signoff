const locales = { en: 'en-GB', fr: 'fr-BE' };

export function formatters(lang) {
  const locale = locales[lang] ?? locales.en;

  return {
    money(amount, currency) {
      if (amount === null || amount === undefined || amount === '') return '';
      return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(amount));
    },
    date(value) {
      if (!value) return '';
      return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));
    },
    dateTime(value) {
      if (!value) return '';
      const text = new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(value));
      return `${text} UTC`;
    },
    // File sizes: 820 KB, 4.2 MB
    bytes(value) {
      const size = Number(value);
      if (size < 1024 * 1024) {
        return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.max(1, Math.round(size / 1024)))} ${lang === 'fr' ? 'Ko' : 'KB'}`;
      }
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size / 1024 / 1024)} ${lang === 'fr' ? 'Mo' : 'MB'}`;
    },
    // Exact timestamp for the certificate, e.g. 2026-10-18 15:09:22 UTC
    isoUtc(value) {
      if (!value) return '';
      return new Date(value).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    },
  };
}
