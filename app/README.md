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
2. Il ajoute des **jalons** (titre, description, montant facultatif).
3. Il attache des **livrables** : liens (staging, Figma…) et notes texte.
4. Il clique sur « Envoyer au client » : Signoff envoie le **lien client** par email au client, et l'affiche aussi pour que le dev puisse le copier.
5. Le client ouvre le lien, sans compte : il voit les livrables et clique sur **J'approuve** ou **Laisser un feedback**.
6. Feedback : le dev corrige et clique sur « Renvoyer » : le client reçoit à nouveau le même lien.
7. Approbation : un **certificat** imprimable en PDF est créé. Le lien client (et le certificat côté client) expire **7 jours après l'approbation**. Le dev garde l'accès au certificat pour toujours.
8. Le dev peut encore modifier le jalon après approbation : le certificat montre toujours ce que le client a réellement approuvé.

Statuts d'un jalon : brouillon, envoyé, vu, feedback, approuvé.

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
    email.js         emails via Resend (ou affichés dans le terminal)
    auth.js          protège les pages du dev
    routes/
      auth.js        inscription (code d'invitation), connexion, déconnexion
      password.js    mot de passe oublié
      legal.js       mentions légales, confidentialité, conditions
      projects.js    tableau de bord et projets
      milestones.js  jalons, livrables, lien client, certificat côté dev
      review.js      pages client : validation, feedback, certificat
    views/           templates EJS
  public/            style.css et app.js (copier le lien, confirmations, impression)
  test/              tests automatiques (npm test)
```

## Base de données

Six tables : `users`, `projects`, `milestones`, `deliverables`, `review_events`, `password_resets`.

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

Toutes sont décrites dans [`.env.example`](.env.example) : `NODE_ENV`, `APP_URL`, `SESSION_SECRET`, `DATABASE_URL`, `LANDING_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `INVITE_CODE`.

En production (`NODE_ENV=production`), l'app refuse de démarrer s'il manque `SESSION_SECRET`, `APP_URL`, `DATABASE_URL` ou `INVITE_CODE`, et affiche la liste de ce qui manque.

## Page santé

`GET /health` répond `{"status":"ok"}` (code 200) quand l'app et la base répondent, sinon `{"status":"error"}` (code 503). À indiquer comme *Health Check Path* dans Render.

## Tests

```bash
npm test
```

Les tests démarrent l'app avec une base en mémoire et vérifient le parcours complet : inscription du dev, projet, jalon, envoi du lien au client, ouverture par le client, approbation, puis le certificat horodaté avec l'IP réelle. Ils couvrent aussi le code d'invitation, le CSRF, le mot de passe oublié, `/health`, les pages légales et les en-têtes de sécurité.

Pour les lancer contre un vrai Postgres jetable : `TEST_DATABASE_URL=postgres://… npm test`.

## Pas encore dans cette version

- Fichiers et captures comme livrables : prévu en v1.1.
- Logo du dev sur la page client : plus tard.
- Mise en ligne (comptes Render, Neon, Resend, domaine) : à faire de ton côté.
