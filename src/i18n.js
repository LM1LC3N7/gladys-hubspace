// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, buttons, command errors, feature
// names), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

const both = (en, fr) => ({ en, fr });

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  power: both('On/Off', 'Marche/Arrêt'),
  brightness: both('Brightness', 'Luminosité'),
  temperature: both('Colour temperature', 'Température de couleur'),
  color: both('Colour', 'Couleur'),
  speed: both('Speed', 'Vitesse'),
  direction: both('Direction', 'Sens de rotation'),
  motion: both('Motion', 'Mouvement'),
  humidity: both('Humidity above the threshold', 'Humidité au-dessus du seuil'),
  battery: both('Battery', 'Batterie'),
  watts: both('Power', 'Puissance'),
  lockState: both('Lock state', 'État de la serrure'),
  lock: both('Lock', 'Verrouiller'),
  unlock: both('Unlock', 'Déverrouiller'),
  valve: both('Watering (1 = open)', 'Arrosage (1 = ouvert)'),
  open: both('Open the valve', 'Ouvrir la vanne'),
  close: both('Close the valve', 'Fermer la vanne'),
};

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) {
    return { en: `${minutes} min`, fr: `${minutes} min` };
  }
  const hours = Math.round(minutes / 60);
  return { en: `${hours} h`, fr: `${hours} h` };
}

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

export const T = {
  noCredentials: both(
    'Enter the e-mail and the password of your Hubspace account (the ones of the app).',
    "Saisissez l'e-mail et le mot de passe de votre compte Hubspace (ceux de l'application).",
  ),
  connecting: both('Signing in to Hubspace…', 'Connexion à Hubspace…'),
  connected: (count, supported) =>
    both(
      `Connected to Hubspace: ${supported} device(s) Gladys can show (out of ${count}). Open Discovery to add them.`,
      `Connecté à Hubspace : ${supported} appareil(s) que Gladys peut afficher (sur ${count}). Ouvrez Découverte pour les ajouter.`,
    ),
  refused: both(
    'Hubspace refused the e-mail or the password: check them in the configuration. The integration waits for a change (or the test button).',
    "Hubspace a refusé l'e-mail ou le mot de passe : vérifiez-les dans la configuration. L'intégration attend une modification (ou le bouton de test).",
  ),
  twoFactor: both(
    'Hubspace e-mailed you a verification code: type it under "Verify the code" in this configuration screen. No code received? "Send the verification code" asks for a new one.',
    'Hubspace vous a envoyé un code de vérification par e-mail : saisissez-le sous « Vérifier le code » dans cet écran de configuration. Pas de code reçu ? « Envoyer le code de vérification » en demande un nouveau.',
  ),
  sessionRefused: (wait) =>
    both(
      `Hubspace refused the session again right after renewing it: the integration paused. New try in ${wait.en}, or click "Test the connection".`,
      `Hubspace a de nouveau refusé la session juste après son renouvellement : l'intégration est en pause. Nouvel essai dans ${wait.fr}, ou cliquez sur « Tester la connexion ».`,
    ),
  loginRejected: both(
    'Hubspace answered the sign-in with a page the integration does not know (a new step, or a changed page): sign in once in the Hubspace app, then click "Test the connection"; if it stays, the integration needs an update.',
    "Hubspace a répondu à la connexion par une page que l'intégration ne connaît pas (une nouvelle étape, ou une page modifiée) : connectez-vous une fois dans l'application Hubspace, puis cliquez sur « Tester la connexion » ; si cela reste, l'intégration doit être mise à jour.",
  ),
  busy: both(
    'A read of Hubspace is in progress: try again in a minute.',
    'Une lecture de Hubspace est en cours : réessayez dans une minute.',
  ),
  unreachable: (reason, wait) =>
    both(
      `Hubspace cannot be reached (${reason}). Next try in ${wait.en}.`,
      `Hubspace est injoignable (${reason}). Nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `Hubspace asks to slow down (HTTP 429): pausing for ${wait.en}, commands included.`,
      `Hubspace demande de ralentir (HTTP 429) : pause de ${wait.fr}, commandes comprises.`,
    ),
  forbidden: (wait) =>
    both(
      `The Hubspace sign-in refuses the requests (HTTP 403): pausing for ${wait.en}.`,
      `La connexion Hubspace refuse les requêtes (HTTP 403) : pause de ${wait.fr}.`,
    ),
  code: {
    needsFields: both(
      'This version of Gladys did not send the form of the button: update Gladys.',
      "Cette version de Gladys n'a pas envoyé le formulaire du bouton : mettez Gladys à jour.",
    ),
    sent: both(
      'Hubspace is e-mailing you a code. Type it under "Verify the code".',
      'Hubspace vous envoie un code par e-mail. Saisissez-le sous « Vérifier le code ».',
    ),
    notNeeded: both(
      'Hubspace accepted the sign-in without a code: connected.',
      'Hubspace a accepté la connexion sans code : connecté.',
    ),
    cooldown: both(
      'A sign-in was started less than a minute ago: wait for its e-mail, or try again in a minute.',
      "Une connexion a été lancée il y a moins d'une minute : attendez son e-mail, ou réessayez dans une minute.",
    ),
    noPending: both(
      'No sign-in is waiting for a code: click "Send the verification code" first.',
      "Aucune connexion n'attend de code : cliquez d'abord sur « Envoyer le code de vérification ».",
    ),
    badFormat: both(
      'The code is made of 4 to 10 digits.',
      'Le code est composé de 4 à 10 chiffres.',
    ),
    refused: both(
      'Hubspace refused the code: check it (the last e-mail), or ask for a new one.',
      'Hubspace a refusé le code : vérifiez-le (le dernier e-mail), ou demandez-en un nouveau.',
    ),
    expired: both(
      'The sign-in waiting for this code is over: click "Send the verification code" again.',
      'La connexion qui attendait ce code est terminée : cliquez à nouveau sur « Envoyer le code de vérification ».',
    ),
    alreadyConnected: both(
      'Already connected to Hubspace: no code is needed.',
      "Déjà connecté à Hubspace : aucun code n'est nécessaire.",
    ),
    verified: both('Code accepted: connected to Hubspace.', 'Code accepté : connecté à Hubspace.'),
    failed: (reason) =>
      both(
        `Hubspace could not be reached (${reason}): try again in a moment.`,
        `Hubspace est injoignable (${reason}) : réessayez dans un moment.`,
      ),
  },
  test: {
    cooldown: both(
      'Already read less than 30 seconds ago.',
      'Déjà lu il y a moins de 30 secondes.',
    ),
  },
};

/** Command errors: the message Gladys shows when a command is refused (English only). */
export const COMMAND = {
  unknown: 'This feature cannot be commanded (unknown to Hubspace now)',
  readOnly: 'This feature is read only',
  blocked: 'Hubspace is not connected: see the integration status',
  paused: 'Hubspace asked to slow down: commands paused, try again later',
  late: 'Hubspace is slow: the command was not sent (Gladys waits 5 seconds)',
  unlockOff: 'Unlocking is off: turn on "Allow unlocking" in the configuration',
  valveOff: 'Valve commands are off: turn on "Allow the water valves" in the configuration',
  unavailable: 'The device is offline for Hubspace: nothing sent',
  unknownState: 'The current state is unknown: nothing sent',
  moving: 'The lock is moving or in an unknown position: nothing sent',
  fanOff: 'The fan is off: Hubspace only changes the direction of a running fan',
  pressOnly: 'This is a button: send 1 to press it',
  refused: 'Hubspace refused the values',
};
