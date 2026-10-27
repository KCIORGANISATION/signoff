import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, startServer } from './helpers.js';

let server;
let config;
let LEGAL;
let legalGaps;
let legalWarning;
let legalText;
let UPLOAD_RULES;
before(async () => {
  server = await startServer();
  ({ config } = await import('../src/config.js'));
  ({ LEGAL, legalGaps, legalWarning, legalText } = await import('../src/legal-config.js'));
  ({ UPLOAD_RULES } = await import('../src/files.js'));
});
after(() => server.stop());

function setBeta({ enabled = false, responsibleName = '', contactEmail = '', feedbackUrl = '' } = {}) {
  Object.assign(config.beta, { enabled, responsibleName });
  Object.assign(config, { contactEmail, feedbackUrl });
}
afterEach(() => setBeta());

const empty = () => Object.fromEntries(Object.keys(LEGAL).map((key) => [key, null]));
const settings = (beta, extra = {}) => ({ beta: { enabled: beta, responsibleName: '' }, contactEmail: '', ...extra });

async function page(path, lang) {
  const visitor = new Browser(server.base);
  await visitor.get(`/lang/${lang}`);
  const response = await visitor.get(path);
  assert.equal(response.status, 200, `${lang} ${path}`);
  return response.text.match(/<article[\s\S]*<\/article>/)[0];
}

const headings = (html) => [...html.matchAll(/<h2[^>]*>(\d+(?: bis|a)?)\./g)].map((match) => match[1].replace(/ bis|a/, '+'));

// --- Values ------------------------------------------------------------------------

test('every legal value starts empty', () => {
  for (const [key, value] of Object.entries(LEGAL)) assert.equal(value, null, key);
});

test('the empty values are listed, the beta ones only during the beta', () => {
  const all = Object.keys(LEGAL);
  assert.deepEqual(legalGaps(empty(), settings(true)), all);
  assert.deepEqual(legalGaps(empty(), settings(false)), all.filter((key) => key !== 'betaResponsible'));

  const filled = Object.fromEntries(all.map((key) => [key, 'x']));
  assert.deepEqual(legalGaps(filled, settings(false)), []);

  const fallback = { ...filled, contactEmail: null, betaResponsible: null };
  assert.deepEqual(legalGaps(fallback, settings(true, { contactEmail: 'a@example.com', beta: { enabled: true, responsibleName: 'Studio Démo' } })), []);
});

test('with BETA_MODE off, empty values give a startup warning', () => {
  assert.equal(legalWarning(empty(), settings(true)), null, 'nothing during the beta');
  const warning = legalWarning(empty(), settings(false));
  assert.match(warning, /BETA_MODE is off/);
  assert.match(warning, /companyName, legalForm, address/);
  assert.doesNotMatch(warning, /betaResponsible/);

  const filled = Object.fromEntries(Object.keys(LEGAL).map((key) => [key, 'x']));
  assert.equal(legalWarning(filled, settings(false)), null);
});

test('values are shown escaped, with their unit and in the page language', () => {
  const values = {
    ...empty(),
    companyName: 'Studio <Démo> & Cie',
    courtCity: { fr: 'Bruxelles', en: 'Brussels' },
    backupRetentionDays: 30,
    storageCleanupDays: 1,
    inactiveAccountMonths: 24,
    billingRetentionYears: 7,
    contactEmail: 'contact@example.com',
    lastUpdated: '2026-10-27',
  };
  const fr = legalText('fr', values, settings(true));
  const en = legalText('en', values, settings(true));
  assert.equal(fr('companyName'), 'Studio &lt;Démo&gt; &amp; Cie');
  assert.equal(fr('courtCity'), 'Bruxelles');
  assert.equal(en('courtCity'), 'Brussels');
  assert.equal(fr('backupRetentionDays'), '30 jours');
  assert.equal(en('storageCleanupDays'), '1 day');
  assert.equal(fr('inactiveAccountMonths'), '24 mois');
  assert.equal(en('billingRetentionYears'), '7 years');
  assert.equal(fr('lastUpdated'), '27 octobre 2026');
  assert.equal(en('lastUpdated'), '27 October 2026');
  assert.equal(en('contactEmail'), '<a href="mailto:contact@example.com">contact@example.com</a>');
  assert.equal(fr('address'), '<span class="placeholder">[à compléter]</span>');
  assert.equal(en('address'), '<span class="placeholder">[to be completed]</span>');
  assert.throws(() => fr('nope'), /Unknown legal value/);
});

// --- Pages -------------------------------------------------------------------------

test('during the beta, the pages show "[à compléter]" and the beta sections', async () => {
  setBeta({ enabled: true });
  for (const path of ['/privacy', '/terms']) {
    const fr = await page(path, 'fr');
    const en = await page(path, 'en');
    assert.match(fr, /<span class="placeholder">\[à compléter\]<\/span>/, path);
    assert.match(en, /<span class="placeholder">\[to be completed\]<\/span>/, path);
    assert.match(fr, /Responsable de la bêta : <span class="placeholder">/, path);
    assert.doesNotMatch(fr + en, /\[ADRESSE\]|\[BCE\]|\[EMAIL\]|Masset/, 'no old placeholder, no personal name');
  }
  const legalFr = await page('/legal', 'fr');
  const legalEn = await page('/legal', 'en');
  assert.match(legalFr, /Responsable de la publication : <span class="placeholder">\[à compléter\]<\/span>/);
  assert.match(legalEn, /Publication manager: <span class="placeholder">\[to be completed\]<\/span>/);
  assert.doesNotMatch(legalFr + legalEn, /\[ADRESSE\]|\[BCE\]|\[TVA\]|\[EMAIL\]|Masset|Kostia/, 'the legal notice names nobody and has no old placeholder');
  assert.match(await page('/privacy', 'fr'), /<h2>7\. Bêta de test<\/h2>/);
  assert.match(await page('/terms', 'en'), /<h2>5\. Beta phase<\/h2>/);

  setBeta({ enabled: true, responsibleName: 'Studio Démo', contactEmail: 'beta@example.com' });
  const privacy = await page('/privacy', 'fr');
  assert.match(privacy, /Responsable de la bêta : Studio Démo\./);
  assert.match(privacy, /<a href="mailto:beta@example.com">beta@example.com<\/a>/);
});

test('without the beta, the beta sections are gone', async () => {
  for (const lang of ['fr', 'en']) {
    const privacy = await page('/privacy', lang);
    const terms = await page('/terms', lang);
    assert.doesNotMatch(privacy, /beta_rules_accepted_at|<h2>7\. (Bêta|Test beta)/);
    assert.match(privacy, /<h2>7\. (Modifications|Changes)<\/h2>/);
    assert.doesNotMatch(terms, /<h2>5\./);
  }
});

test('French and English pages have the same sections', async () => {
  for (const enabled of [true, false]) {
    setBeta({ enabled });
    for (const path of ['/privacy', '/terms']) {
      const fr = await page(path, 'fr');
      const en = await page(path, 'en');
      assert.ok(headings(fr).length >= 7, `${path} has its sections`);
      assert.deepEqual(headings(fr), headings(en), `${path} beta=${enabled}`);
      assert.equal((fr.match(/<h3/g) ?? []).length, (en.match(/<h3/g) ?? []).length, `${path} h3`);
      assert.equal((fr.match(/<tr/g) ?? []).length, (en.match(/<tr/g) ?? []).length, `${path} rows`);
      assert.equal((fr.match(/<li/g) ?? []).length, (en.match(/<li/g) ?? []).length, `${path} items`);
      assert.equal((fr.match(/class="placeholder"/g) ?? []).length, (en.match(/class="placeholder"/g) ?? []).length, `${path} placeholders`);
    }
  }
});

test('the terms give the real upload limits and the exact approval notice', async () => {
  const fr = await page('/terms', 'fr');
  const en = await page('/terms', 'en');
  assert.match(fr, new RegExp(`${UPLOAD_RULES.size} Mo maximum par fichier, ${UPLOAD_RULES.count} fichiers maximum par jalon ou livraison, ${UPLOAD_RULES.quota} Mo maximum par compte`));
  assert.match(en, /10 MB maximum per file, 10 files maximum per milestone or delivery, 200 MB maximum per account/);
  assert.ok(en.includes(`Accepted formats: ${UPLOAD_RULES.types}.`));
  assert.ok(fr.includes('Votre approbation est enregistrée avec votre nom, la date, l&#39;heure et votre adresse IP.'));
  assert.ok(en.includes('Your approval is recorded with your name, the date, the time and your IP address.'));
});

test('the privacy policy covers the IP address, file references, deletion and backups', async () => {
  setBeta({ enabled: true });
  const fr = await page('/privacy', 'fr');
  const en = await page('/privacy', 'en');
  assert.match(fr, /adresse IP et navigateur \(user agent\) du client au moment de chaque action/);
  assert.match(fr, /« \/fichier1 »/);
  assert.match(en, /"\/file1"/);
  assert.match(fr, /<code>storage_orphans<\/code>/);
  assert.match(en, /<code>admin:clean-storage<\/code>/);
  assert.match(fr, /GitHub \(Actions\)<\/td><td>Exécute chaque nuit la sauvegarde/);
  assert.match(en, /Discord<\/td>/);
});

// The words the legal pages must not use (the only allowed exceptions are the eIDAS sentence
// and the jurisdiction clause).
test('the legal pages avoid the forbidden words', async () => {
  for (const enabled of [true, false]) {
    setBeta({ enabled });
    for (const lang of ['fr', 'en']) {
      for (const path of ['/legal', '/privacy', '/terms']) {
        const text = (await page(path, lang))
          .replace(/n(&#39;|')est pas une signature électronique qualifiée/g, '')
          .replace(/is not a qualified electronic signature/g, '')
          .replace(/les tribunaux de/g, '')
          .replace(/the courts of/g, '');
        assert.doesNotMatch(text, /valeur légale|legal value|signature électronique|electronic signature|tribunal|\bcourts?\b|garanti|guarantee|100 ?%|Work-Out/i, `${lang} ${path}`);
      }
    }
  }
});
