// The word the app uses for a piece of work the client approves. Developers and writers
// think in "milestones" (jalons); people who hand over a video, a design, an illustration
// or photos think in "deliveries" (livraisons). The activity chosen in the profile decides,
// for the freelancer's own pages, the client's pages and the emails. No activity: milestone.
//
// The texts themselves stay in i18n.js. This file only holds, for "delivery", the sentences
// that say "milestone" or agree with it. French sentences are written out in full, because
// "livraison" is feminine and the articles and past participles around it change too.

export const TERMS = ['milestone', 'delivery'];

const DELIVERY_ACTIVITIES = new Set(['video', 'design', 'illustration', 'photography']);

export function termFor(activity) {
  return DELIVERY_ACTIVITIES.has(activity) ? 'delivery' : 'milestone';
}

// Texts that never change with the vocabulary: the public home page, and the hint that
// explains the two words.
export const UNCHANGED_PREFIXES = ['home.', 'profile.activity.vocabulary'];

// English: the word swaps cleanly, except where the example list itself said "delivery".
const enExceptions = {
  'project.milestones.emptyHint': 'A delivery is a piece of work your client approves: a cut of a video, a set of mockups, a series of photos.',
  'review.amount.payLater': 'After approving the delivery, you can pay through the link provided by the freelancer.',
  'onboard.step.milestone.text': 'A delivery is a piece of work your client approves: a cut of a video, a set of mockups, a series of photos. Add a title, then your files or links.',
};

function englishDelivery(text) {
  return text
    .replace(/milestones/g, 'deliveries')
    .replace(/Milestones/g, 'Deliveries')
    .replace(/milestone/g, 'delivery')
    .replace(/Milestone/g, 'Delivery');
}

const frDelivery = {
  'dashboard.empty': 'Aucun projet pour le moment. Créez le premier pour envoyer une livraison à valider.',
  'project.delete.confirm': 'Supprimer ce projet, ses livraisons et toutes leurs preuves de validation ?',
  'project.milestones': 'Livraisons',
  'project.milestones.empty': 'Aucune livraison pour le moment.',
  'milestone.new': 'Nouvelle livraison',
  'milestone.edit': 'Modifier la livraison',
  'milestone.save': 'Enregistrer la livraison',
  'milestone.delete': 'Supprimer la livraison',
  'milestone.delete.confirm': 'Supprimer cette livraison et toutes ses preuves de validation ?',
  'milestone.editedAfterApproval': 'Vous avez modifié cette livraison après sa validation. Le certificat montre toujours exactement ce que le client a validé.',
  'milestone.locked': 'Cette livraison est approuvée et verrouillée. Toute modification se fait dans une nouvelle livraison.',
  'milestone.locked.error': 'Cette livraison est approuvée et verrouillée : son contenu ne peut plus changer. Créez plutôt une livraison de suite.',
  'milestone.locked.deleteError': 'Cette livraison est approuvée et verrouillée : elle ne peut pas être supprimée seule. Pour l’effacer, supprimez le projet ou le compte.',
  'milestone.followUp': 'Créer une livraison de suite',
  'files.error.count': 'Une livraison peut contenir {count} fichiers au maximum.',
  'files.error.limits': "L'envoi a été refusé : la livraison est verrouillée ou une limite est atteinte.",
  'files.limits': '{size} Mo maximum par fichier, {count} fichiers par livraison, {quota} Mo au total.',
  'account.delete.item.projects': 'vos projets ({projects}) et leurs livraisons ({milestones}), y compris les livraisons approuvées, avec leurs livrables, cadres et notes ;',
  'review.request': '{dev} vous demande de valider cette livraison.',
  'review.approve': 'Approuver cette livraison',
  'review.approve.confirm': "Approuver cette livraison ? L'approbation est enregistrée avec la date et l'heure.",
  'review.approved': 'Vous avez approuvé cette livraison le {date}.',
  'cert.intro': "Ce certificat atteste de la validation formelle d'une livraison de projet.",
  'cert.milestone': 'Livraison',
  'cert.none': "Cette livraison n'a pas encore été approuvée.",
  'email.review.body': 'Bonjour {client},\n\n{dev} a terminé la livraison « {title} » du projet {project} et vous demande votre validation.\n\nConsultez les livrables, puis approuvez ou laissez un feedback ici (sans créer de compte) :\n{link}\n\nEnvoyé avec Signoff de la part de {dev}.',
  'email.approved.body': "{client} a approuvé la livraison « {title} » ({project}).\n\nLe certificat d'approbation est prêt :\n{link}",
  'welcome.request': '{dev} vous demande de valider une livraison',
  'welcome.position': 'Livraison {position} sur {total}',
  'welcome.open': 'Voir la livraison',
  'review.main': 'Contenu de la livraison',
  'review.files.empty': 'Aucun fichier pour cette livraison.',
  'review.amount.none': "Aucun montant n'est indiqué pour cette livraison.",
  'review.amount.payLater': 'Après avoir approuvé la livraison, vous pourrez procéder au paiement via le lien proposé par le prestataire.',
  'review.amount.approved': 'Livraison approuvée : le paiement se trouve sous « Votre décision ».',
  'review.approve.nameError': 'Saisissez votre nom complet pour approuver la livraison.',
  'review.approved.title': 'Livraison approuvée',
  'review.history.sent': 'Livraison envoyée',
  'review.history.approved': '« {title} » approuvée',
  'review.preview.back': 'Retour à la livraison',
  'review.sentBy': 'Envoyée par {dev} le {date}',
  'review.closed.body': "Cette livraison n’attend plus de décision. Contactez {dev} si vous avez une question.",
  'dashboard.noMilestones': 'Aucune livraison pour le moment',
  'dashboard.noActive': 'Démarrez un nouveau projet pour envoyer votre prochaine livraison à valider.',
  'dashboard.progress': '{approved} sur {total} approuvées',
  'project.milestones.emptyHint': 'Une livraison, c’est une partie du travail que votre client valide : un montage, une série de maquettes, une série de photos.',
  'milestone.form.titleLabel': 'Titre de la livraison',
  'milestone.form.lockNote': 'Une fois approuvée, la livraison est verrouillée. Toute modification se fait dans une nouvelle livraison.',
  'milestone.form.statusDraft': 'Brouillon · pas encore envoyée',
  'milestone.form.statusNew': 'Nouvelle · pas encore enregistrée',
  'milestone.form.alreadySent': 'Déjà envoyée à {email}. Enregistrer garde le même lien.',
  'onboard.title.milestone': 'Votre projet est prêt. Créons sa première livraison.',
  'onboard.step.project.text': 'Un projet regroupe les livraisons que vous faites à un client. Il suffit de son nom et de l’email de votre client.',
  'onboard.step.milestone': 'Créer votre première livraison',
  'onboard.step.milestone.text': 'Une livraison, c’est une partie du travail que votre client valide : un montage, une série de maquettes, une série de photos. Donnez-lui un titre, puis ajoutez vos fichiers ou vos liens.',
  'onboard.step.milestone.action': 'Créez votre première livraison',
  'onboard.step.send.text': 'Signoff envoie un lien à votre client par email. Il consulte la livraison puis l’approuve ou laisse un retour, sans créer de compte.',
  'onboard.step.send.later': 'Dès que votre livraison est prête.',
  'projects.empty': 'Un projet regroupe les livraisons que vous faites à un client.',
  'project.currency.hint': 'La devise des montants des livraisons de ce projet.',
  'project.current': 'Livraison actuelle',
  'project.current.none': 'Aucune livraison en cours',
  'project.current.open': 'Ouvrir la livraison',
  'project.current.sentAt': 'Envoyée le {date}',
  'project.archived': 'Voir les livraisons terminées ou archivées ({count})',
  'project.archived.approvedAt': 'approuvée le {date}',
  'project.complete.allApproved': 'Toutes les livraisons sont approuvées. Le projet passe dans « Terminés ».',
  'project.complete.unapproved': 'Ces livraisons ne sont pas approuvées. Elles seront marquées « non réalisées » :',
  'project.complete.confirm': 'Je confirme : ces livraisons ne seront pas réalisées.',
  'project.complete.confirmError': 'Cochez la case pour confirmer que les livraisons non approuvées ne seront pas réalisées.',
  'project.complete.effects': 'Les livraisons approuvées restent verrouillées avec leur certificat. Vous pourrez rouvrir le projet plus tard.',
  'project.abandon.effect.approved': 'Les livraisons déjà approuvées restent verrouillées, avec leur certificat.',
  'project.abandon.effect.others': 'Les autres livraisons passent à « annulée ».',
  'project.reopen.from.completed': 'Le projet repasse « En cours ». Les livraisons marquées « non réalisées » retrouvent le statut qu’elles avaient.',
  'project.reopen.from.abandoned': 'Le projet repasse « En cours ». Les livraisons annulées retrouvent le statut qu’elles avaient et les liens de votre client fonctionnent à nouveau.',
  'next.firstMilestone': 'Votre projet n’a pas encore de livraison.',
  'next.firstMilestone.action': 'Créez votre première livraison',
  'next.newMilestone': 'Créer une livraison',
  'next.newMilestone.text': 'Aucune livraison n’est en cours.',
  'next.finish': 'Toutes les livraisons sont approuvées. Terminez le projet, ou ajoutez une livraison.',
  'next.send': '« {title} » est prête à être validée.',
  'milestone.projectClosed.completed': 'Le projet est terminé : cette livraison est en lecture seule.',
  'milestone.projectClosed.abandoned': 'Le projet est abandonné : cette livraison est en lecture seule.',
  'milestone.share.not_done': 'Le projet a été terminé avant l’approbation de cette livraison. Son lien n’accepte plus de décision.',
  'milestone.share.cancelled': 'Le projet a été abandonné : cette livraison est annulée et son lien n’accepte plus de décision.',
  'email.reminder.body': 'Bonjour {client},\n\n{dev} attend toujours votre décision sur la livraison « {title} » du projet {project}.\n\nConsultez-la, puis approuvez-la ou laissez un retour ici (sans créer de compte) :\n{link}\n\nEnvoyé avec Signoff de la part de {dev}.',
  'email.overLimit.body': "{client} a laissé un retour sur la livraison « {title} » du projet {project}. C'est la révision {round}, au-delà des {limit} incluses dans le cadre :\n\n{message}\n\nAcceptez-le quand même ou proposez un supplément :\n{link}",
  'email.deadline.body': 'Bonjour {client},\n\n{dev} attend votre décision sur la livraison « {title} » du projet {project}, attendue avant le {date}.\n\nConsultez-la, puis approuvez-la ou laissez un retour ici (sans créer de compte) :\n{link}\n\nEnvoyé avec Signoff de la part de {dev}.',
  'email.overdue.body': "Le délai de la livraison « {title} » du projet {project} était le {date}, et {client} n'a pas encore décidé.\n\nLa livraison reste en attente : rien n'est approuvé sans la décision du client. Vous pouvez relancer le client depuis la page de la livraison :\n{link}",
  'email.supplementAccepted.body': "{client} a accepté le supplément « {title} » du projet {project}. C'est maintenant une nouvelle livraison, en brouillon.\n\nCommentaire : {comment}\n\n{link}",
  'stats.intro': 'Uniquement ce que Signoff sait : vos projets, vos livraisons et les réponses de vos clients.',
  'stats.milestones': 'Livraisons',
  'stats.milestones.scope': 'Livraisons créées sur la période, selon leur statut aujourd’hui.',
  'stats.amounts': 'Montants des livraisons',
  'stats.amounts.note': 'Les montants indiqués sur vos livraisons. Signoff ne connaît ni les paiements reçus ni vos dépenses. Une ligne par devise, jamais additionnées.',
  'stats.amounts.none': 'Aucune livraison avec un montant sur cette période.',
  'stats.speed.scope': 'Calculée sur les livraisons approuvées pendant la période : {count}.',
  'stats.speed.rounds': 'Tours de retours par livraison',
  'frame.form.lead': 'Le cadre est ce que votre client accepte avant sa première décision : ce qui est inclus, le nombre de tours de retours compris par livraison et le délai pour décider. Laissez les valeurs par défaut si vous n’en avez pas besoin.',
  'frame.revisions': 'Révisions incluses par livraison',
  'frame.revisions.perMilestone': '{count} par livraison',
  'frame.client.lead': '{dev} a défini le cadre de travail de ce projet. Lisez-le, puis acceptez-le pour voir la livraison et donner votre décision.',
  'frame.accept.submit': 'Accepter et voir la livraison',
  'frame.dev.waiting': 'Version {version}, en attente de l’acceptation du client. Il la voit en ouvrant un lien de livraison.',
  'supplement.new.lead': '{client} le voit sur la page de sa livraison, avec Accepter et Refuser. Accepté, il devient une nouvelle livraison du projet avec ce montant.',
  'supplement.client.intro': '{dev} considère cette demande comme hors du cadre et vous la propose en supplément. Accepté, il devient une nouvelle livraison du projet.',
  'proof.intro': 'Tout ce que Signoff a enregistré sur ce projet : le cadre et ses acceptations, les livraisons et leur historique, les fichiers avec leur empreinte, les suppléments et les changements d’état.',
  'proof.milestones': 'Livraisons ({count})',
  'proof.milestones.none': 'Aucune livraison.',
  'proof.supplement.origin': 'Proposé le {date} pour la livraison « {title} ».',
  'proof.supplement.milestone': 'Nouvelle livraison : « {title} »',
  // Statuses of a delivery, which agree with it.
  'status.sent': 'Envoyée',
  'status.viewed': 'Vue',
  'status.approved': 'Approuvée',
  'status.not_done': 'Non réalisée',
  'status.cancelled': 'Annulée',
};

const enOverrides = new Map();

// The "delivery" sentences for a language, built once from the English dictionary.
export function deliveryWording(lang, en) {
  if (lang === 'fr') return frDelivery;
  if (!enOverrides.has(en)) {
    const words = {};
    for (const [key, text] of Object.entries(en)) {
      if (UNCHANGED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
      if (/milestone/i.test(text)) words[key] = englishDelivery(text);
    }
    enOverrides.set(en, { ...words, ...enExceptions });
  }
  return enOverrides.get(en);
}
