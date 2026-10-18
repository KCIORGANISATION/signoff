# Registre des traitements de Signoff

Registre des activités de traitement (article 30 du RGPD). Dernière mise à jour : 18 octobre 2026.

**Responsable du traitement** : Kostia Masset-Depasse, [ADRESSE], Bruxelles, Belgique. BCE [BCE]. Contact : [EMAIL].

Signoff a deux rôles :

- **Responsable du traitement** pour les données des développeurs qui ont un compte (tableau 1) et pour la liste d'attente de la landing page.
- **Sous-traitant** pour les données des clients des développeurs (tableau 2). Le responsable est alors le développeur ; le contrat de sous-traitance est la section 11 des conditions d'utilisation (`/terms#dpa`).

Mesures de sécurité communes : HTTPS, mots de passe hachés (bcrypt), jetons de réinitialisation hachés (SHA-256), protection CSRF, limitation des tentatives de connexion, accès limité à l'éditeur, hébergement et base de données dans l'UE (Francfort), sauvegardes quotidiennes chiffrées au repos par le fournisseur.

## 1. Traitements dont Signoff est responsable

| Donnée collectée | Finalité | Base légale | Durée de conservation | Sous-traitant |
|---|---|---|---|---|
| Nom ou nom commercial, email du développeur | Créer et gérer le compte, afficher le nom aux clients, envoyer les emails du service | Exécution du contrat (art. 6.1.b) | Durée du compte + 1 an | Render (UE), Neon (UE), Resend (US), Cloudflare R2 (UE, sauvegardes) |
| Mot de passe (haché) | Authentification | Exécution du contrat (art. 6.1.b) | Durée du compte + 1 an | Render (UE), Neon (UE), Cloudflare R2 (UE, sauvegardes) |
| Langue préférée | Afficher l'interface et les emails dans la bonne langue | Exécution du contrat (art. 6.1.b) | Durée du compte + 1 an | Render (UE), Neon (UE) |
| Projets, jalons, montants, livrables (liens, notes), lien et instructions de paiement (IBAN éventuel) | Fournir le service | Exécution du contrat (art. 6.1.b) | Durée du compte + 1 an, ou suppression immédiate par le développeur | Render (UE), Neon (UE), Cloudflare R2 (UE, sauvegardes) |
| Jeton de réinitialisation du mot de passe (haché), email | Réinitialiser le mot de passe | Exécution du contrat (art. 6.1.b) | Lien valable 1 h ; ligne conservée avec le compte | Neon (UE), Resend (US) |
| Cookie de session (identifiant du compte, langue, jeton CSRF) | Garder la session ouverte, protéger les formulaires | Intérêt légitime (art. 6.1.f), cookie strictement nécessaire | 30 jours | Aucun (stocké dans le navigateur) |
| Adresse IP (limitation des tentatives de connexion, journaux de l'hébergeur) | Sécurité du service | Intérêt légitime (art. 6.1.f) | 15 minutes (limitation) ; journaux selon l'hébergeur (quelques semaines) | Render (UE) |
| Copie complète de la base | Sauvegarde et reprise après incident | Intérêt légitime (art. 6.1.f) | 30 jours (règle de cycle de vie R2) | Cloudflare R2 (UE), GitHub (US, exécution du script) |
| Email des inscrits à la liste d'attente (landing page) | Prévenir de l'ouverture de la bêta | Consentement (art. 6.1.a) | Jusqu'au désabonnement, au plus tard 1 an après le lancement | Netlify (US) |

## 2. Traitements effectués pour le compte des développeurs (sous-traitance)

| Donnée collectée | Finalité | Base légale | Durée de conservation | Sous-traitant |
|---|---|---|---|---|
| Nom et email du client | Envoyer le lien de validation, l'afficher sur le certificat | Celle du développeur (en pratique exécution du contrat ou intérêt légitime) | Durée du compte du développeur + 1 an, ou suppression immédiate du projet | Render (UE), Neon (UE), Resend (US), Cloudflare R2 (UE, sauvegardes) |
| Messages de feedback du client | Transmettre les demandes de correction au développeur | Celle du développeur | Durée du compte + 1 an | Render (UE), Neon (UE), Resend (US), Cloudflare R2 (UE, sauvegardes) |
| Preuve d'approbation : date et heure UTC, adresse IP, navigateur, copie figée des livrables | Prouver l'accord du client sur le jalon | Intérêt légitime du développeur (art. 6.1.f) | Durée du compte + 1 an | Render (UE), Neon (UE), Cloudflare R2 (UE, sauvegardes) |
| Adresse IP et navigateur à l'ouverture du lien et au feedback | Historique du jalon | Intérêt légitime du développeur (art. 6.1.f) | Durée du compte + 1 an | Render (UE), Neon (UE), Cloudflare R2 (UE, sauvegardes) |

## Transferts hors UE

Resend, GitHub et Netlify sont établis aux États-Unis ; Render, Neon et Cloudflare sont des sociétés américaines dont les données Signoff restent dans l'UE. Base des transferts : Data Privacy Framework UE–États-Unis si le fournisseur est certifié, sinon clauses contractuelles types. À vérifier et documenter au moment d'accepter le DPA de chaque fournisseur.

## À tenir à jour

- Ajouter une ligne pour tout nouveau type de donnée ou nouveau fournisseur (paiement Stripe, upload de fichiers, analytics…).
- Noter ici la date d'acceptation du DPA de chaque fournisseur.
- Garder ce registre cohérent avec `/privacy` et `/terms`.
