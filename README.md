# signoff-landing

Landing page de validation de Signoff (phase 1). Objectif : 30 emails early-access = feu vert pour le MVP.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | La page : hero, problème, solution, comment ça marche, CTA, footer |
| `style.css` | Dark mode, accent vert `#22c55e`, responsive (960px / 640px) |
| `script.js` | Année du footer, bouton désactivé pendant l'envoi |
| `thanks.html` | Page affichée après inscription |
| `netlify.toml` | Config Netlify (publication du dossier racine, en-têtes de sécurité) |

## Formulaire (Netlify Forms)

Les deux formulaires (hero et CTA) s'appellent `early-access` et envoient `email` + `source` (`hero` ou `cta`), ce qui permet de voir quel bloc convertit le mieux. Anti-spam par champ honeypot `bot-field`.

Les inscriptions apparaissent dans Netlify > site > **Forms** > `early-access`. Pour être notifié à chaque inscription : Forms > Form notifications > Email.

## Déployer

1. Créer le repo `signoff-landing` sur GitHub et y pousser ces fichiers.
2. Netlify > Add new site > Import from GitHub > `signoff-landing`. Pas de commande de build, dossier de publication `.`.
3. Vérifier que Forms est activé (Site configuration > Forms > Enable form detection), puis redéployer une fois.
4. Tester une inscription depuis le site en ligne.

En local, il suffit d'ouvrir `index.html` (le formulaire ne fonctionne qu'une fois déployé sur Netlify).

## À vérifier avant de publier

- Deux chiffres du bloc problème n'ont pas de source précise dans le brief ($4,300/projet et 3–5×/semaine) : ajouter la source ou reformuler.
- L'URL `signoff.dev` dans la maquette est fictive, à remplacer par le vrai domaine.
