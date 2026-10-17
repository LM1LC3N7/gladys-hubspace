# Hubspace pour Gladys Assistant

Affiche et commande dans Gladys les appareils de votre compte **Hubspace**
(Home Depot, cloud Afero) : lumières, prises et interrupteurs, ventilateurs
de plafond, capteurs des extracteurs de salle de bain, et l'état des
serrures et des programmateurs d'arrosage.

> **API non officielle, jamais testée avec un vrai compte.** L'intégration
> parle à l'API de l'application Hubspace, que Hubspace ne documente pas et
> peut changer à tout moment. Elle a été écrite à partir de la bibliothèque
> aioafero (celle de l'intégration Home Assistant) et testée seulement avec
> des réponses inventées. Sans lien avec Hubspace, Home Depot ni Afero.

## Ce que vous obtenez

Un appareil Gladys par appareil Hubspace pris en charge :

| Appareil Hubspace                   | Fonctionnalités Gladys                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Lumière, variateur                  | Marche/Arrêt, Luminosité, Température de couleur, Couleur (selon l'ampoule) ; une série par zone (ex. `main` et `trim`) |
| Prise, interrupteur, transformateur | Marche/Arrêt (une par sortie ou zone), Puissance (W) quand l'appareil la donne                                          |
| Ventilateur de plafond              | Marche/Arrêt, Vitesse (%), Sens de rotation                                                                             |
| Extracteur                          | Mouvement, Humidité au-dessus du seuil (lecture seule)                                                                  |
| Serrure                             | État de la serrure (lecture seule), boutons Verrouiller et Déverrouiller, Batterie                                      |
| Programmateur d'arrosage            | Arrosage par robinet (1 = ouvert, lecture seule), boutons Ouvrir la vanne et Fermer la vanne, Batterie                  |

La lumière d'un ventilateur de plafond est un appareil à part (comme dans
l'application). Les autres appareils Hubspace (thermostats, climatiseurs,
déshumidificateurs, alarme) ne sont pas encore affichés. Les portes de
garage ne sont pas gérées par aioafero : elles ne le sont pas non plus ici.

### Serrures et vannes : désactivées par défaut

- **Serrures** : l'état est en lecture seule, les commandes sont des boutons
  (jamais un interrupteur : un « tout éteindre » de Gladys, d'un assistant
  vocal ou d'une scène ne peut pas les toucher). **Verrouiller** est
  toujours permis ; **Déverrouiller** est refusé tant que l'option
  _Autoriser le déverrouillage des serrures depuis Gladys_ est désactivée
  (par défaut).
- **Programmateurs d'arrosage** : **Ouvrir la vanne** et **Fermer la vanne**
  sont refusés tant que l'option _Autoriser les vannes d'arrosage depuis
  Gladys_ est désactivée (par défaut) ; l'état reste affiché.
- Avant chaque commande de serrure ou de vanne, l'intégration relit l'état
  auprès de Hubspace : rien n'est envoyé si l'appareil est hors ligne, si
  l'état est inconnu ou si la serrure est en mouvement, et rien n'est
  renvoyé si l'appareil est déjà dans l'état voulu.

## Mise en place

1. Dans Gladys, installez l'intégration **Hubspace** depuis le store.
2. Saisissez l'**e-mail** et le **mot de passe** de votre compte Hubspace
   (ceux de l'application), puis enregistrez.
3. Si l'état indique qu'un code a été envoyé par e-mail, voir ci-dessous.
4. Ouvrez l'onglet **Découverte** et ajoutez les appareils.

Le champ du mot de passe est un champ `secret` : Gladys le garde dans sa
base (en clair, comme toute valeur de configuration, et dans ses
sauvegardes), ne le réaffiche jamais, et l'intégration ne l'envoie qu'à la
page de connexion Hubspace (`accounts.hubspaceconnect.com`). Il ne sert
qu'à la première connexion et quand Hubspace refuse le jeton de
renouvellement : le reste du temps, l'intégration renouvelle sa session
avec ce jeton.

### Code de vérification (par e-mail)

Hubspace peut demander un code envoyé par e-mail lors d'une connexion. Dans
ce cas, Hubspace envoie le code au moment de la connexion, l'intégration
s'arrête et l'état l'indique :

1. Sous **Vérifier le code**, saisissez le code du dernier e-mail de Hubspace
   et cliquez sur le bouton. « Code accepté » veut dire connecté.
2. Pas d'e-mail, ou code trop vieux (plus de 10 minutes) ? Cliquez sur
   **Envoyer le code de vérification** : l'intégration se reconnecte et
   Hubspace envoie un nouveau code (au plus une fois par minute).

La session est ensuite gardée (dans le `/data` de l'intégration) : pas de
code aux redémarrages. L'intégration ne se reconnecte jamais d'elle-même en
boucle : au plus un e-mail automatique par incident.

## Rafraîchissement

Tous les appareils sont lus toutes les **60 secondes** par défaut (30 à 60,
_Intervalle de rafraîchissement_), en **une seule requête**. Une commande
part tout de suite ; la valeur confirmée par Hubspace s'affiche aussitôt et
n'est pas défaite par une lecture un peu en retard (15 secondes).

Les commandes d'un même appareil passent l'une après l'autre. Gladys attend
5 secondes la réponse d'une commande : si Hubspace est trop lent,
l'intégration refuse la commande **avant de l'envoyer** plutôt que de
l'envoyer après l'échec affiché.

## En cas de problème

- **E-mail ou mot de passe refusé** : l'intégration s'arrête et attend, même
  après un redémarrage. Corrigez-les puis enregistrez (ou cliquez sur
  _Tester la connexion_). Elle ne se reconnecte jamais d'elle-même après un
  refus.
- **Session refusée** : la session est renouvelée une fois ; refusée à
  nouveau, l'intégration se met en pause et réessaie après 1 heure,
  6 heures, puis toutes les 24 heures (gardé après un redémarrage).
  _Tester la connexion_ réessaie tout de suite.
- **Page de connexion inconnue** : Hubspace demande une étape que
  l'intégration ne connaît pas (accepter des conditions, changer le mot de
  passe…) : connectez-vous une fois dans l'application, puis cliquez sur
  _Tester la connexion_.
- **Trop de requêtes (429)** : une pause de 1 minute à 6 heures (le
  `Retry-After` de Hubspace, 10 minutes sans lui), pour les lectures, les
  commandes et les boutons, gardée après un redémarrage ou une reconnexion
  à Gladys. **HTTP 403** de la page de connexion : une heure.
- **Hubspace indisponible (5xx, réseau)** : nouveaux essais après 1, 2, 5,
  10, puis toutes les 15 minutes, jamais plus vite que l'intervalle.
- Un appareil hors ligne pour Hubspace est marqué « injoignable » sur sa
  carte.

## Limites

- API non officielle : Hubspace peut la changer, la bloquer ou demander plus
  de vérifications.
- Pas de mises à jour en direct (le canal « Conclave » de l'application) :
  une lecture toutes les 30 à 60 secondes.
- Un seul compte Hubspace par Gladys.
- Pas d'effets lumineux, de minuteries ni de réglages (LED, sensibilité,
  haut-parleur…) dans cette version.
- Jamais testée avec un vrai compte : merci de signaler ce que vous voyez sur
  le [dépôt GitHub](https://github.com/LM1LC3N7/gladys-hubspace/issues) (sans
  votre e-mail, mot de passe ni codes).

## Vie privée

L'intégration garde dans `/data/hubspace-state.json` (lisible par son seul
conteneur) : les jetons de session (renouvellement et accès) et
l'identifiant de compte Afero, le compte auquel ils appartiennent sous forme
d'empreinte de l'e-mail, une connexion en attente de code (ses cookies et
paramètres), l'heure de la dernière demande de code, la fin d'une pause 429,
et un arrêt sur identifiants refusés lié à une empreinte salée de l'e-mail et
du mot de passe. Ni l'e-mail ni le mot de passe. Rien n'est envoyé ailleurs
qu'à Hubspace et Afero.
