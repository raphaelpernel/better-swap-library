# Better Swap Library

Plugin Figma qui corrige deux limites connues du "Swap library" natif :

1. **Ordre** : le natif swap les variables avant les composants (plus lent, et
   retraite des bindings que le composant swappé aurait de toute façon
   ramenés). Ici : composants d'abord, puis variables orphelines, puis text
   styles, puis effects.
2. **Bug de mode** : après un swap natif, les valeurs des modes non-défaut
   (ex. Hover) restent parfois résolues vers l'ancienne library
   ([confirmé sur le forum Figma](https://forum.figma.com/ask-the-community-7/swap-library-not-updating-variable-aliases-correctly-on-hover-state-51357)).
   Ce plugin réassigne explicitement le binding pour chaque champ trouvé dans
   `boundVariables`, quel que soit le mode.

## Pourquoi un Personal Access Token ?

L'API Plugin de Figma ne permet de lister le catalogue complet d'une library
distante **que pour les variables** (`figma.teamLibrary`). Il n'existe aucune
fonction équivalente pour les composants, text styles ou effects — on ne peut
importer un asset que si on connaît déjà sa clé, et cette clé ne peut venir
que d'un asset déjà utilisé quelque part dans le fichier ouvert.

Pour matcher par nom l'intégralité de deux libraries (pas seulement ce qui
est déjà posé dans le fichier), le plugin appelle donc la REST API Figma
(`GET /v1/files/:key/components`, `/styles`) avec un
Personal Access Token fourni une fois par l'utilisateur, scope minimum
`file_content:read`. Le token est stocké via `figma.clientStorage` (local à
la machine/compte, jamais transmis ailleurs qu'à `api.figma.com`) — pas
besoin de le re-coller à chaque swap. Les paires de libraries (URLs des deux
fichiers sources + nom de la library de variables activée) sont sauvegardées
de la même façon.

## Setup

```bash
npm install
npm run build
```

Puis dans Figma desktop : **Plugins > Development > Import plugin from
manifest…** et sélectionner `manifest.json` à la racine de ce dossier.

`npm run watch` reconstruit `dist/code.js` en continu (et re-régénère
`dist/ui.html` toutes les 1.5s) pendant le développement.

## Utilisation

1. Onglet **Configuration** : coller un Personal Access Token, définir la
   **library de référence** une fois pour toutes (ex. Mealz DS / Neutral —
   URL du fichier source, et si besoin le nom de la library de variables tel
   qu'il apparaît dans le panneau Assets), puis ajouter une ou plusieurs
   **libraries cibles** (une par client). Le nom affiché est récupéré
   automatiquement depuis Figma (pas besoin de le retaper).
2. Onglet **Swap** : choisir la library cible, le sens (Référence → Cible ou
   Cible → Référence), la portée (sélection actuelle ou toute la page), puis
   **Lancer le swap**.
3. Le panneau affiche une barre de progression par phase (composants →
   variables → text styles → effects), le temps écoulé, et à la fin un
   décompte par catégorie plus la liste des assets non swappés (aucun
   équivalent trouvé par nom/clé dans la library cible).

## Limites connues de cette première version

- **Les variables ne sont swappées que si la library est activée dans le
  fichier ouvert** (Assets > Libraries) — c'est une limite de `figma.teamLibrary`
  (l'API Plugin), pas du plugin lui-même : il n'existe pas d'API Plugin pour
  lister les variables d'une library non activée dans le fichier courant (la
  REST API équivalente est réservée aux comptes Enterprise). Le nom de la
  library est résolu automatiquement à partir du nom réel du fichier (le
  champ "Variable library name override" ne sert que si le nom publié de la
  library diffère du nom du fichier). Si tu viens tout juste d'activer une
  library et que 0 variable est trouvé, **ferme et rouvre le fichier Figma**
  (pas juste le plugin) — une library fraîchement activée n'est parfois
  synchronisée pour l'API Plugin qu'après un reload complet du document.
- Les bindings de variable **par plage de caractères** sur du texte
  multi-couleurs (`boundVariables.textRangeFills`) ne sont pas remappés
  automatiquement — juste signalés dans le rapport.
- `GET /v1/files/:key/components` n'est pas paginé côté plugin : sur des
  fichiers library très volumineux (plusieurs milliers de composants), le
  premier chargement du catalogue peut prendre quelques secondes.
- Le matching par **clé** ne sert que si les deux libraries partagent
  effectivement des clés identiques (rare entre deux libraries indépendantes,
  utile si Library B a été dupliquée depuis Library A). Le matching par
  **nom complet** (`ComponentSet/Variant` ou `Collection/Variable`) est la
  voie principale, exactement comme le swap natif.
- **Composants imbriqués** (ex. un "Button" à l'intérieur d'un "Product
  Card") : les instances sont swappées en ordre bottom-up (enfants avant
  parents) pour éviter que le swap du parent n'invalide la référence à
  l'enfant avant qu'on ait pu la traiter. Mais swapper le composant principal
  d'un parent déclenche aussi la reconciliation interne de Figma sur ses
  instances imbriquées (le même mécanisme que le swap natif dans l'UI) — si
  le Pro