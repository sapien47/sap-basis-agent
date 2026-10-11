// Ready-to-paste ticket replies, in English or French. Deterministic templates: the agent fills in
// facts that SAP confirmed after the change, it does not invent them. Passwords never appear here.

const list = (names) => names.join(", ");
const until = (d, lang) => (d ? d : lang === "fr" ? "sans date de fin" : "no end date");

export function deactivated(users, sys, lang = "en") {
  if (lang === "fr")
    return `Bonjour,\n\nLe ou les comptes SAP suivants ont été désactivés dans ${sys} : ${list(users)}.\n` +
      `Ils sont verrouillés et leur validité se termine aujourd'hui. Les rôles sont conservés pour la piste d'audit.\n\n` +
      `Nous fermons ce billet. N'hésitez pas à nous recontacter si nécessaire.\n\nCordialement,\nÉquipe SAP Basis`;
  return `Hello,\n\nThe following SAP account(s) have been deactivated in ${sys}: ${list(users)}.\n` +
    `They are locked and their validity ends today. Roles are kept for the audit trail.\n\n` +
    `We are closing this ticket. Feel free to contact us if anything else is needed.\n\nBest regards,\nSAP Basis team`;
}

export function created(user, template, sys, lang = "en") {
  const roles = user.roles.length ? user.roles.join(", ") : lang === "fr" ? "aucun" : "none";
  if (lang === "fr")
    return `Bonjour,\n\nLe compte SAP ${user.username} (${user.fullName}) a été créé dans ${sys}, sur le modèle de ${template}.\n` +
      `Rôles : ${roles}. Validité : ${until(user.validTo, lang)}.\n` +
      `Le mot de passe initial sera transmis à l'utilisateur par un canal sécurisé ; il devra le changer à la première connexion.\n\n` +
      `Nous fermons ce billet.\n\nCordialement,\nÉquipe SAP Basis`;
  return `Hello,\n\nSAP account ${user.username} (${user.fullName}) has been created in ${sys}, modelled on ${template}.\n` +
    `Roles: ${roles}. Valid until: ${until(user.validTo, lang)}.\n` +
    `The initial password will be sent to the user through a secure channel; they must change it at first logon.\n\n` +
    `We are closing this ticket.\n\nBest regards,\nSAP Basis team`;
}

export function rolesAssigned(user, roles, roleEnd, sys, lang = "en") {
  const end = roleEnd === "9999-12-31" ? until(null, lang) : roleEnd;
  if (lang === "fr")
    return `Bonjour,\n\nLe ou les rôles suivants ont été attribués au compte SAP ${user.username} (${user.fullName}) dans ${sys} : ${list(roles)}.\n` +
      `Validité des rôles : ${end}. Les rôles existants du compte sont conservés.\n` +
      `L'utilisateur doit se déconnecter puis se reconnecter pour voir les nouveaux accès.\n\n` +
      `Nous fermons ce billet.\n\nCordialement,\nÉquipe SAP Basis`;
  return `Hello,\n\nThe following role(s) have been assigned to SAP account ${user.username} (${user.fullName}) in ${sys}: ${list(roles)}.\n` +
    `Role validity: ${end}. The account's existing roles are kept.\n` +
    `The user should log off and on again to see the new access.\n\n` +
    `We are closing this ticket.\n\nBest regards,\nSAP Basis team`;
}

export function reactivated(user, { unlocked, validityChanged, passwordReset }, sys, lang = "en") {
  const fr = lang === "fr";
  const done = [
    unlocked && (fr ? "le compte est déverrouillé" : "the account is unlocked"),
    validityChanged && (fr ? `la validité est prolongée jusqu'au ${user.validTo}` : `validity is extended until ${user.validTo}`),
    passwordReset && (fr ? "un nouveau mot de passe initial a été généré (transmis par un canal sécurisé, à changer à la première connexion)"
      : "a new initial password was generated (sent through a secure channel, to be changed at first logon)"),
  ].filter(Boolean);
  if (fr)
    return `Bonjour,\n\nPour le compte SAP ${user.username} dans ${sys} : ${done.join(" ; ")}.\n\n` +
      `L'utilisateur peut de nouveau se connecter. Nous fermons ce billet.\n\nCordialement,\nÉquipe SAP Basis`;
  return `Hello,\n\nFor SAP account ${user.username} in ${sys}: ${done.join("; ")}.\n\n` +
    `The user can log on again. We are closing this ticket.\n\nBest regards,\nSAP Basis team`;
}

export function diagnosis(username, findings, sys, lang = "en") {
  const fr = lang === "fr";
  const problems = findings.filter((f) => f.severity === "blocking" || f.severity === "warning");
  if (!problems.length)
    return fr
      ? `Bonjour,\n\nNous avons vérifié le compte SAP ${username} dans ${sys} : il n'est pas verrouillé, il est valide et il a des rôles.\n` +
        `Pouvez-vous nous envoyer une capture d'écran du message d'erreur et la transaction ou l'application utilisée ?\n\nCordialement,\nÉquipe SAP Basis`
      : `Hello,\n\nWe checked SAP account ${username} in ${sys}: it is not locked, it is valid and it has roles.\n` +
        `Could you send us a screenshot of the error message and the transaction or app you were using?\n\nBest regards,\nSAP Basis team`;
  const lines = problems.map((p) => `- ${fr ? p.fr : p.finding}`).join("\n");
  return fr
    ? `Bonjour,\n\nNous avons vérifié le compte SAP ${username} dans ${sys} et trouvé la cause :\n${lines}\n\n` +
      `Nous corrigeons cela et revenons vers vous.\n\nCordialement,\nÉquipe SAP Basis`
    : `Hello,\n\nWe checked SAP account ${username} in ${sys} and found the cause:\n${lines}\n\n` +
      `We are fixing this and will get back to you.\n\nBest regards,\nSAP Basis team`;
}
