# Signoff app (MVP)

L'outil lui-même : le dev crée un projet et ses jalons, attache les livrables, envoie un lien unique au client, et le client approuve ou laisse un feedback. Chaque approbation est enregistrée avec la date, l'heure, l'IP, le navigateur et une copie figée des livrables.

## Lancer en local

Il faut Node.js 22 ou plus. Rien d'autre à installer : la base de données Postgres tourne dans Node (PGlite) et se range dans `app/data/`.

```bash
cd app
npm install
cp .env.example .env     # puis mets une longue chaîne aléatoire dans SESSION_SECRET
npm run dev
```

Ouvre http://localhost:3000, crée un compte, puis un projet.

Pour tester côté client, ouvre le lien client dans une fenêtre de navigation privée (sinon tu restes connecté en tant que dev, ce qui ne gêne pas mais brouille le test).

Pour repartir de zéro, arrête le serveur et supprime le dossier `app/data/`.

## Le parcours

1. Le dev crée un **projet** (nom, client, email du client, devise).
2. Il ajoute des **jalons** (titre, description, montant facultatif).
3. Il attache des **livrables** : liens (staging, Figma…) et notes texte.
4. Il clique sur « Marquer comme envoyé » : l'app affiche le **lien client**, qu'il copie et envoie lui-même.
5. Le client ouvre le lien, sans compte : il voit les livrables et clique sur **J'approuve** ou **Laisser un feedback**.
6. Feedback : le dev corrige, clique sur « Marquer comme renvoyé » et renvoie le même lien.
7. Approbation : un **certificat** imprimable en PDF est créé. Le lien client (et le certificat côté client) expire **7 jours après l'approbation**. Le dev garde l'accès au certificat pour toujours.
8. Le dev peut encore modifier le jalon après approbation : le certificat montre toujours ce que le client a réellement approuvé.

Statuts d'un jalon : brouillon, envoyé, vu, feedback, approuvé.

## Organisation du code

```
app/
  src/
    server.js        point d'entrée Express, langue, gestion d'erreurs
    db.js            connexion à la base (PGlite en local, Postgres si DATABASE_URL)
    schema.sql       les 5 tables, créées au démarrage
    models.js        requêtes partagées (jalons, livrables, preuves)
    i18n.js          textes en anglais et en français
    format.js        affichage des montants et des dates
    notify.js        emails au dev (Resend, ou affichés dans le terminal)
    auth.js          protège les pages du dev
    routes/
      auth.js        inscription, connexion, déconnexion
      projects.js    tableau de bord et projets
      milestones.js  jalons, livrables, lien client, certificat côté dev
      review.js      pages client : validation, feedback, certificat
    views/           templates EJS
  public/            style.css et app.js (copier le lien, confirmations, impression)
```

## Base de données

Cinq tables : `users`, `projects`, `milestones`, `deliverables`, `review_events`.

- Chaque jalon a un `token` aléatoire de 32 caractères : c'est lui qui forme le lien client `/r/<token>`.
- `review_events` est le journal des actions (envoyé, vu, feedback, approuvé). L'app n'y fait que des ajouts, jamais de modification. Une approbation y stocke l'IP, le navigateur et un `snapshot` JSON des livrables.

Pour passer sur Neon plus tard : crée une base gratuite sur neon.tech, copie la chaîne de connexion dans `DATABASE_URL` du `.env`, relance. Les tables se créent toutes seules.

## Notifications

Quand le client approuve ou laisse un feedback, le dev est prévenu par email. Tant que `RESEND_API_KEY` et `EMAIL_FROM` sont vides, l'email s'affiche simplement dans le terminal du serveur.

## Pas encore dans cette version

- Mot de passe oublié : il faut d'abord l'envoi d'emails (à faire au moment de la mise en ligne).
- Fichiers et captures comme livrables : prévu en v1.1.
- Logo du dev sur la page client : plus tard.
- Mise en ligne (hébergement, domaine, emails) : quand tu décides de pousser l'app en ligne.
