# Signoff app (MVP)

L'outil lui-même : le dev crée un projet et ses jalons, attache les livrables, envoie un lien unique au client, et le client approuve ou laisse un feedback. Chaque approbation est enregistrée avec la date, l'heure, l'IP, le navigateur et une copie figée des livrables.

## Lancer en local

Il faut Node.js 22 ou plus. Rien d'autre à installer : la base de données Postgres tourne dans Node (PGlite) et se range dans `app/data/`.

```bash
cd app
npm install
cp .env.example .env
npm run dev
```

Ouvre http://localhost:3000, crée un compte, puis un projet.

Pour tester côté client, ouvre le lien client dans une fenêtre de navigation privée (sinon tu restes connecté en tant que dev, ce qui ne gêne pas mais brouille le test).

Pour repartir de zéro, arrête le serveur et supprime le dossier `app/data/`.

## Le parcours

1. Le dev crée un **projet** (nom, client, email du client, devise).
2. Il ajoute des **jalons** (titre, description, montant facultatif, lien et instructions de paiement facultatifs).
3. Il attache des **livrables** : liens (staging, Figma…), notes texte et **fichiers** (captures, PDF, maquettes).
4. « Voir comme le client » montre la page du client sans rien envoyer ni enregistrer. Puis il clique sur « Envoyer au client » : Signoff envoie le **lien client** par email au client, et l'affiche aussi pour que le dev puisse le copier.
5. Le client ouvre le lien, sans compte : une carte d'accueil (`/r/:token`) résume le jalon, puis « Voir le jalon » ouvre la page du jalon (`/r/:token/review`) avec les fichiers, le montant et la description. Il clique sur **Approuver ce jalon** (il tape alors son nom complet, puis « Je confirme ») ou **Laisser un retour**. Dans son retour, il peut citer un fichier avec `/fichier2` (`/file2` en anglais) : le dev voit ces citations comme des liens vers le fichier.
6. Feedback : le dev corrige et clique sur « Renvoyer » : le client reçoit à nouveau le même lien.
7. Approbation : un **certificat** imprimable en PDF est créé. Le lien client (et le certificat côté client) expire **7 jours après l'approbation**. Le dev garde l'accès au certificat pour toujours.
8. Un jalon approuvé est **verrouillé** : titre, description, montant et livrables ne peuvent plus changer (seuls le lien et les instructions de paiement restent modifiables). Pour toute modification, le bouton « Créer un jalon de suite » crée un nouveau jalon brouillon dans le même projet. Il n'y a pas de réouverture pour une nouvelle approbation.

### Preuve d'approbation

Au moment où le client approuve, Signoff enregistre dans `review_events` un instantané du jalon (titre, description, montant, livrables) avec le nom complet tapé par le client avec la date, l'IP et le navigateur. Le certificat est construit uniquement à partir de cet enregistrement, jamais relu depuis le jalon.

Le verrouillage est appliqué deux fois : par l'app (une requête directe sur un jalon approuvé reçoit une erreur 409) et par la base elle-même (des triggers dans `schema.sql`). La base refuse :

- toute modification d'une ligne de `review_events`, et sa suppression tant que le jalon existe (supprimer un jalon, un projet ou un compte efface toujours son historique) ;
- tout changement du titre, de la description, du montant ou du statut d'un jalon approuvé ;
- tout ajout, modification ou suppression de livrable sur un jalon approuvé.

Statuts d'un jalon : brouillon, envoyé, vu, feedback, approuvé.

## Fichiers

Le dev peut joindre des fichiers à un jalon : glisser-déposer ou bouton « Choisir des fichiers », plusieurs à la fois, avec une barre de progression. Le client voit les images en miniature (clic pour agrandir) et peut télécharger les PDF et les textes.

- **Types acceptés** : PNG, JPG, WebP, GIF, PDF et texte brut (`.txt`, `.md`, `.csv`, `.log`). Le type est reconnu d'après le **contenu réel** du fichier (ses premiers octets), jamais d'après son nom ni le type envoyé par le navigateur. Le SVG, le HTML, les exécutables et les archives sont refusés. Le nom d'affichage est nettoyé et son extension corrigée pour correspondre au contenu.
- **Limites** : 10 Mo par fichier, 10 fichiers par jalon, 200 Mo par compte pendant la bêta, 30 envois par 15 minutes et par IP.
- **Accès** : aucun fichier n'est public. L'app les sert elle-même, uniquement au dev propriétaire du jalon ou à quelqu'un qui a le lien client valide de CE jalon. Les images s'ouvrent dans la page ; les PDF et les textes se téléchargent. Chaque réponse porte `X-Content-Type-Options: nosniff` et une CSP qui interdit tout script.
- **Stockage** : chaque fichier est rangé sous une clé aléatoire. Le nom d'origine (nettoyé) ne sert qu'à l'affichage.
- **Preuve** : Signoff calcule l'empreinte SHA-256 de chaque fichier à l'envoi. Le certificat liste les fichiers présents au moment de l'approbation, avec leur nom et leur empreinte. Une fois le jalon approuvé, ses fichiers sont figés : impossible de les supprimer ou d'en ajouter, ni dans l'interface, ni par une requête directe, ni dans la base (trigger).
- **Suppression** : supprimer un jalon ou un projet supprime aussi ses fichiers du stockage. L'app n'a pas encore de suppression de compte : quand elle existera, elle devra faire de même.

### Où vont les fichiers

- **En production** : dans un bucket Cloudflare R2 privé, distinct de celui des sauvegardes (jamais sur le disque de Render, qui est effacé à chaque déploiement).
- **Sans les variables `FILES_R2_*` en production** : l'app démarre normalement, la zone d'envoi est remplacée par un message (« L'envoi de fichiers n'est pas encore disponible sur ce serveur »), et un avertissement apparaît dans les logs.
- **En local sans ces variables** : dans le dossier `app/uploads/`, ignoré par git. Pour le développement uniquement.

### Mise en place du bucket (une seule fois)

1. Cloudflare > **R2 Object Storage** > **Create bucket**. Nom : `signoff-files`. Dans *Location*, choisis **Specify jurisdiction** > **European Union (EU)**. Laisse l'accès public désactivé. Crée.
2. R2 > **Manage R2 API Tokens** (ou *API Tokens*) > **Create API token**. Nom : `signoff-files-app`. Permissions : **Object Read & Write**. *Specify bucket(s)* : uniquement `signoff-files`. Crée, puis copie l'**Access Key ID**, la **Secret Access Key** et l'endpoint **pour la juridiction UE** (`https://<account-id>.eu.r2.cloudflarestorage.com`). La clé secrète ne s'affiche qu'une fois.
3. Render > le service web > **Environment** : ajoute `FILES_R2_ACCESS_KEY_ID`, `FILES_R2_SECRET_ACCESS_KEY`, `FILES_R2_BUCKET` (`signoff-files`) et `FILES_R2_ENDPOINT`. Enregistre : Render redéploie.
4. Vérifie : dans les logs du déploiement, l'avertissement « FILES_R2_* variables are not set » ne doit plus apparaître. Envoie un fichier sur un jalon de test : il doit apparaître dans le bucket sous `files/…`.

**Attention** : ce bucket n'est **pas** couvert par la sauvegarde nocturne, qui ne copie que la base de données. Une sauvegarde des fichiers reste à faire.

## Lien de paiement

Sur chaque jalon, le dev peut ajouter deux champs facultatifs :

- **Lien de paiement** : l'URL d'un Stripe Payment Link, PayPal, Wise, Payconiq… Seules les adresses `https://` valides de 500 caractères maximum sont acceptées (pas de `http:`, `javascript:`, `data:`, d'espaces, ni de `nom@domaine` avant le domaine).
- **Instructions de paiement** : texte libre de 500 caractères maximum (IBAN, communication). Toujours affiché comme du texte brut.

Le client ne les voit **qu'après avoir approuvé** : avant, ils ne sont pas du tout dans la page envoyée au navigateur (pas simplement cachés). Après l'approbation, la page du client montre le montant, un bouton « Payer maintenant » qui ouvre le lien dans un nouvel onglet, le domaine de destination (« Vous allez être redirigé vers buy.stripe.com ») et les instructions. Le bouton reste là chaque fois que le client rouvre son lien, jusqu'à son expiration.

Signoff ne traite aucun paiement, n'envoie pas d'email au client à ce sujet et ne suit pas les clics. Si le dev modifie le lien après l'approbation, le client voit le nouveau lien ; le lien de paiement ne fait pas partie de la preuve figée.

## Organisation du code

```
app/
  src/
    server.js        démarre le serveur (et l'arrête proprement sur SIGTERM)
    app.js           l'app Express : sécurité, langue, routes, erreurs
    config.js        lit et vérifie les variables d'environnement
    csrf.js          protection CSRF des formulaires
    db.js            connexion à la base (PGlite en local, Postgres si DATABASE_URL)
    schema.sql       les tables, créées au démarrage si elles n'existent pas
    models.js        requêtes partagées (jalons, livrables, preuves)
    i18n.js          textes en anglais et en français
    format.js        affichage des montants et des dates
    payment.js       vérification du lien et des instructions de paiement
    files.js         fichiers joints : type réel, nom, limites, envoi au navigateur
    storage.js       stockage des fichiers (R2, dossier local en développement, ou désactivé)
    email.js         emails via Resend (ou affichés dans le terminal)
    auth.js          protège les pages du dev
    routes/
      auth.js        inscription (code d'invitation), connexion, déconnexion
      password.js    mot de passe oublié
      legal.js       mentions légales, confidentialité, conditions
      projects.js    tableau de bord et projets
      milestones.js  jalons, livrables, lien client, certificat côté dev
      files.js       envoi, suppression et téléchargement des fichiers côté dev
      review.js      pages client : validation, feedback, certificat
    views/           templates EJS
  public/            style.css et app.js (copier le lien, confirmations, impression)
  scripts/           sauvegarde et restauration de la base (Cloudflare R2)
  test/              tests automatiques (npm test)
```

## Base de données

Sept tables : `users`, `projects`, `milestones`, `deliverables`, `files`, `review_events`, `password_resets`.

- `milestones.payment_link` et `milestones.payment_note` contiennent le lien et les instructions de paiement (vides par défaut).
- `files` décrit chaque fichier joint (nom nettoyé, type, taille, empreinte SHA-256, clé de stockage aléatoire). Le contenu est dans R2, pas dans la base.
- Chaque jalon a un `token` aléatoire de 32 caractères : c'est lui qui forme le lien client `/r/<token>`.
- `review_events` est le journal des actions (envoyé, vu, feedback, approuvé). L'app n'y fait que des ajouts, jamais de modification. Une approbation y stocke l'IP, le navigateur et un `snapshot` JSON des livrables.

Pour passer sur Neon plus tard : crée une base gratuite sur neon.tech, copie la chaîne de connexion dans `DATABASE_URL` du `.env`, relance. Les tables se créent toutes seules.

## Emails

Signoff envoie trois sortes d'emails via [Resend](https://resend.com) :

- au client, quand le dev envoie un jalon (avec le lien de validation) ;
- au dev, quand le client approuve ou laisse un feedback (dans la langue choisie par le dev) ;
- au dev, pour réinitialiser son mot de passe (lien valable 1 heure, une seule fois).

Tant que `RESEND_API_KEY` est vide, l'email s'affiche simplement dans le terminal du serveur.

## Sécurité

- **Vraie IP du client** : Express fait confiance au proxy de Render (`trust proxy`), donc la preuve d'approbation enregistre l'IP du client et pas celle de Render.
- **Cookies** : signés avec `SESSION_SECRET`, envoyés uniquement en HTTPS en production. Sans vraie clé, l'app refuse de démarrer en production.
- **CSRF** : chaque formulaire envoie un jeton caché lié à la session ; un POST sans le bon jeton est refusé (403).
- **En-têtes** : `helmet` ajoute les en-têtes de sécurité standard (CSP, HSTS en production, nosniff…).
- **Inscription sur invitation** : il faut le code `INVITE_CODE` pour créer un compte.
- **Limites** : 10 tentatives de connexion ou d'inscription et 5 demandes de mot de passe oublié par 15 minutes et par IP.

## Variables d'environnement

Toutes sont décrites dans [`.env.example`](.env.example) : `NODE_ENV`, `APP_URL`, `SESSION_SECRET`, `DATABASE_URL`, `LANDING_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `INVITE_CODE`, et les quatre `FILES_R2_*` du stockage des fichiers (facultatives : sans elles, l'envoi de fichiers est désactivé en production).

En production (`NODE_ENV=production`), l'app refuse de démarrer s'il manque `SESSION_SECRET`, `APP_URL`, `DATABASE_URL` ou `INVITE_CODE`, et affiche la liste de ce qui manque.

## Page santé

`GET /health` répond `{"status":"ok"}` (code 200) quand l'app et la base répondent, sinon `{"status":"error"}` (code 503). À indiquer comme *Health Check Path* dans Render.

## Tests

```bash
npm test
```

Les tests démarrent l'app avec une base en mémoire et vérifient le parcours complet : inscription du dev, projet, jalon, envoi du lien au client, ouverture par le client, approbation, puis le certificat horodaté avec l'IP réelle. Ils couvrent aussi les fichiers (type refusé selon le contenu réel, taille, nombre, quota, CSRF, accès refusé à un autre dev et à un mauvais lien client, en-têtes, fichiers figés après approbation, empreintes dans le certificat, suppression du stockage, app sans stockage configuré), le verrouillage des jalons approuvés (édition refusée côté serveur et par la base, certificat inchangé après une tentative, paiement toujours modifiable, jalon de suite), le lien de paiement (absent de la page avant l'approbation, présent après, liens dangereux refusés, instructions échappées), le code d'invitation, le CSRF, le mot de passe oublié, `/health`, les pages légales, les en-têtes de sécurité, la page d'accueil client et le nom obligatoire à l'approbation, l'ordre des fichiers gardé avec un retour et l'affichage échappé des `/fichierN`, et l'aperçu « Voir comme le client » sans effet de bord.

Pour les lancer contre un vrai Postgres jetable : `TEST_DATABASE_URL=postgres://… npm test`.

## Sauvegardes

Chaque nuit, une GitHub Action ([`.github/workflows/backup.yml`](../.github/workflows/backup.yml)) fait une copie complète de la base Neon et l'envoie dans un bucket Cloudflare R2. Les fichiers s'appellent `signoff/2026-10-19T01-00-12Z.dump` (date et heure UTC).

### Mise en place (une seule fois)

1. Dans Cloudflare R2 : crée un bucket (par exemple `signoff-backups`, emplacement Europe) et un jeton API R2 avec les droits *Object Read & Write* sur ce bucket. Note l'Access Key ID, la Secret Access Key et l'endpoint S3 (`https://<account-id>.r2.cloudflarestorage.com`).
2. Dans GitHub : *Settings > Secrets and variables > Actions*, ajoute 5 secrets : `DATABASE_URL` (la chaîne Neon de production), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`.
3. Dans l'onglet *Actions* : ouvre « Nightly database backup » et clique sur *Run workflow* pour tester tout de suite. Le fichier doit apparaître dans le bucket.
4. Conseillé : dans le bucket R2, ajoute une règle de cycle de vie (*Settings > Object lifecycle rules*) qui supprime les objets de plus de 30 jours, sinon les sauvegardes s'accumulent.

### Bon à savoir

- L'heure : GitHub ne connaît que l'heure UTC. La sauvegarde est programmée à 01:00 UTC, soit 3h à Bruxelles en été et 2h en hiver. GitHub peut la lancer avec quelques minutes de retard.
- GitHub met en pause les tâches programmées d'un repo public sans aucune activité pendant 60 jours. Si ça arrive, tu reçois un email et il suffit de la réactiver dans l'onglet *Actions*.
- `pg_dump` doit être de la même version majeure que Neon, ou plus récente. Le workflow installe la version 17 (`PG_MAJOR`). Si ta base Neon est dans une autre version, change ce chiffre.
- Si une sauvegarde échoue, GitHub t'envoie un email.

### Sauvegarder à la main

Avec les mêmes variables dans `app/.env` (et les outils PostgreSQL installés sur ton ordinateur) :

```bash
npm run backup
```

### Restaurer une sauvegarde (procédure de test)

On restaure toujours dans une **base de test**, jamais dans la base de production. Le script refuse si `RESTORE_DATABASE_URL` est identique à `DATABASE_URL`.

1. Crée une base vide de test, par exemple une branche Neon (*Branches > New branch*) ou un Postgres local.
2. Dans `app/.env`, mets les 4 variables `R2_…` et `RESTORE_DATABASE_URL` (la chaîne de connexion de la base de test).
3. Liste les sauvegardes disponibles :
   ```bash
   npm run restore -- --list
   ```
4. Restaure la plus récente :
   ```bash
   npm run restore
   ```
   ou une sauvegarde précise :
   ```bash
   npm run restore -- signoff/2026-10-19T01-00-12Z.dump
   ```
5. Le script affiche le nombre de lignes de chaque table. Compare-les avec la production, puis lance l'app sur la base de test pour vérifier (`DATABASE_URL=<base de test> npm run dev`).

Fais cet exercice une fois par mois : une sauvegarde qu'on n'a jamais restaurée n'est pas une vraie sauvegarde.

En cas de vrai sinistre, la même commande peut restaurer dans une nouvelle base Neon, dont tu mettras ensuite la chaîne de connexion dans `DATABASE_URL` sur Render.

## Design

- Une seule feuille de style, `public/style.css` : toutes les couleurs, rayons, ombres et durées sont des variables CSS en haut du fichier.
- Polices hébergées par l'app (aucun appel externe) : Plus Jakarta Sans pour le texte, Caveat pour le logo, fournies par les paquets `@fontsource/*` et servies sous `/fonts/`.
- Logo : `public/logo.svg`. Pour le changer, remplace ce seul fichier (il est inséré dans les pages par le serveur, d'où l'usage de la police Caveat). Le favicon est `public/favicon.svg`.
- Maquettes de référence : `design-reference/` à la racine du dépôt.

## Pas encore dans cette version

- Sauvegarde du bucket de fichiers.
- Suppression de compte (elle devra aussi supprimer les fichiers du stockage).
- Logo du dev sur la page client : plus tard.
- Mise en ligne (comptes Render, Neon, Resend, domaine) : à faire de ton côté.
