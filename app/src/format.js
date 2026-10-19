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
    // A month key "2026-10" as "oct. 2026" / "Oct 2026".
    month(key) {
      const [year, month] = key.split('-').map(Number);
      return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
    },
    // Amounts the statistics add up in cents.
    cents(value, currency) {
      return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value / 100);
    },
    percent(ratio) {
      return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(ratio);
    },
    decimal(value) {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
    },
    // A delay: "5 h" under two days, else "3,5 jours" / "3.5 days".
    duration(ms) {
      const hours = ms / 3600000;
      const number = (n) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
      if (hours < 48) return `${number(Math.max(hours, 0.1))} h`;
      return `${number(hours / 24)} ${lang === 'fr' ? 'jours' : 'days'}`;
    },
    // Exact timestamp for the certificate, e.g. 2026-10-18 15:09:22 UTC
    isoUtc(value) {
      if (!value) return '';
      return new Date(value).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    },
  };
}
