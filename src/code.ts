// Better Swap Library - main thread (sandboxed Figma plugin environment)
//
// Ordre volontaire : composants d'abord (ils embarquent deja leurs propres
// variables liees), puis les variables orphelines, puis text styles et effects.
// A l'interieur de la phase composants, les instances sont traitees en ordre
// BOTTOM-UP (enfants avant parents) : swapper le composant principal d'un
// parent (ex. Product Card) declenche la reconciliation interne de Figma sur
// ses instances imbriquees (ex. Button), ce qui invalide les references
// collectees en pre-order. En traitant les enfants d'abord, on evite que ce
// mecanisme interne n'ecrase ou ne rende obsolete notre propre swap du Button
// avant qu'on ait pu l'executer.
//
// Voir README.md pour le contexte complet (pourquoi une REST API + token sont
// necessaires pour composants/text styles/effects, alors que les variables
// passent entierement par figma.teamLibrary).

import type {
  BaseLibrary,
  MainToUiMessage,
  SwapCategory,
  SwapCounts,
  SwapDirection,
  SwapScope,
  TargetLibrary,
  UiToMainMessage,
  UnmatchedEntry,
} from "./shared/types";

const CONFIG_KEY = "better-swap-library-config-v2";

interface StoredConfig {
  token: string | null;
  base: BaseLibrary | null;
  targets: TargetLibrary[];
}

interface RestCatalog {
  componentsByName: Map<string, string>;
  componentsByKey: Map<string, string>;
  // Fallback sans le prefixe "ComponentSet/" : utile si la resolution du nom
  // du component set echoue d'un cote ou de l'autre (voir fetchRestCatalog).
  // Liste des cles candidates (ambigu si plus d'une) pour un nom de variante sans prefixe.
  componentsByBareVariant: Map<string, string[]>;
  textStylesByName: Map<string, string>;
  textStylesByKey: Map<string, string>;
  effectStylesByName: Map<string, string>;
  effectStylesByKey: Map<string, string>;
}

interface VariableCatalog {
  byName: Map<string, string>;
  byKey: Map<string, string>;
}

let cancelRequested = false;

figma.showUI(__html__, { width: 460, height: 680, themeColors: true });

function post(message: MainToUiMessage) {
  figma.ui.postMessage(message);
}

// ---------------------------------------------------------------------------
// Config (clientStorage) - persisted once per machine/account, no need to
// re-paste the token or the library URLs on every run.
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<StoredConfig> {
  const raw = (await figma.clientStorage.getAsync(CONFIG_KEY)) as StoredConfig | undefined;
  return raw ?? { token: null, base: null, targets: [] };
}

async function saveConfig(cfg: StoredConfig): Promise<void> {
  await figma.clientStorage.setAsync(CONFIG_KEY, cfg);
}

function extractFileKey(url: string): string | null {
  const match = url.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

async function figmaRest(token: string, path: string): Promise<any> {
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { "X-Figma-Token": token },
  });
  if (!res.ok) {
    throw new Error(`Figma REST API ${path} -> HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchFileName(token: string, fileKey: string): Promise<string> {
  try {
    const meta = await figmaRest(token, `/files/${fileKey}/meta`);
    return meta?.file?.name ?? meta?.name ?? fileKey;
  } catch {
    return fileKey;
  }
}

async function fetchRestCatalog(token: string, fileKey: string): Promise<RestCatalog> {
  const catalog: RestCatalog = {
    componentsByName: new Map(),
    componentsByKey: new Map(),
    componentsByBareVariant: new Map<string, string[]>(),
    textStylesByName: new Map(),
    textStylesByKey: new Map(),
    effectStylesByName: new Map(),
    effectStylesByKey: new Map(),
  };

  const [componentsRes, stylesRes] = await Promise.all([
    figmaRest(token, `/files/${fileKey}/components`),
    figmaRest(token, `/files/${fileKey}/styles`),
  ]);

  const allComponents = componentsRes.meta?.components ?? [];
  let resolvedPrefixCount = 0;

  for (const c of allComponents) {
    // Le nom du component set parent d'un variant est directement dans
    // containing_frame.containingComponentSet.name (objet {name, nodeId}),
    // pas dans un champ "component_set_id" a plat (n'existe pas) ni via un
    // second appel /component_sets a recouper par id (inutile: le nom est
    // deja fourni ici). containingStateGroup est l'equivalent deprecated.
    const setName =
      c.containing_frame?.containingComponentSet?.name ?? c.containing_frame?.containingStateGroup?.name;
    const bareVariant = canonicalVariantName(c.name);
    const fullName = setName ? `${setName}/${bareVariant}` : bareVariant;
    if (setName) resolvedPrefixCount++;
    catalog.componentsByName.set(fullName, c.key);
    catalog.componentsByKey.set(c.key, fullName);
    // Filet de securite (voir usage cote matching) : on garde TOUTES les
    // clefs candidates pour une meme chaine de variante sans prefixe, pour
    // pouvoir detecter une ambiguite et refuser de deviner au hasard entre
    // deux composants differents qui partagent les memes valeurs de variant.
    const bucket = catalog.componentsByBareVariant.get(bareVariant);
    if (bucket) bucket.push(c.key);
    else catalog.componentsByBareVariant.set(bareVariant, [c.key]);
  }

  for (const s of stylesRes.meta?.styles ?? []) {
    if (s.style_type === "TEXT") {
      catalog.textStylesByName.set(s.name, s.key);
      catalog.textStylesByKey.set(s.key, s.name);
    } else if (s.style_type === "EFFECT") {
      catalog.effectStylesByName.set(s.name, s.key);
      catalog.effectStylesByKey.set(s.key, s.name);
    }
  }

  post({
    type: "log",
    level: "info",
    message: `Catalog ${fileKey}: ${allComponents.length} components (${resolvedPrefixCount} attached to a component set), ${stylesRes.meta?.styles?.length ?? 0} styles.`,
  });

  return catalog;
}

// ---------------------------------------------------------------------------
// Variable catalog - fully covered by the Plugin API, no REST/token needed.
// ---------------------------------------------------------------------------

async function fetchVariableCatalog(libraryName: string | undefined): Promise<VariableCatalog> {
  const catalog: VariableCatalog = { byName: new Map(), byKey: new Map() };
  if (!libraryName) return catalog;

  const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  const mine = collections.filter((c) => c.libraryName === libraryName);

  for (const col of mine) {
    const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
    for (const v of vars) {
      const fullName = `${col.name}/${v.name}`;
      catalog.byName.set(fullName, v.key);
      catalog.byKey.set(v.key, fullName);
    }
  }

  return catalog;
}

// ---------------------------------------------------------------------------
// Import caches - avoid re-importing the same remote asset for every instance.
// ---------------------------------------------------------------------------

const componentImportCache = new Map<string, Promise<ComponentNode>>();
const variableImportCache = new Map<string, Promise<Variable>>();
const styleImportCache = new Map<string, Promise<BaseStyle>>();

function importComponentCached(key: string): Promise<ComponentNode> {
  let p = componentImportCache.get(key);
  if (!p) {
    p = figma.importComponentByKeyAsync(key);
    componentImportCache.set(key, p);
  }
  return p;
}

function importVariableCached(key: string): Promise<Variable> {
  let p = variableImportCache.get(key);
  if (!p) {
    p = figma.variables.importVariableByKeyAsync(key);
    variableImportCache.set(key, p);
  }
  return p;
}

function importStyleCached(key: string): Promise<BaseStyle> {
  let p = styleImportCache.get(key);
  if (!p) {
    p = figma.importStyleByKeyAsync(key);
    styleImportCache.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function getScopeRoots(scope: SwapScope): readonly SceneNode[] {
  if (scope === "selection" && figma.currentPage.selection.length > 0) {
    return figma.currentPage.selection;
  }
  return figma.currentPage.children;
}

function collectInstances(node: BaseNode, out: InstanceNode[]) {
  if (node.type === "INSTANCE") out.push(node as InstanceNode);
  if ("children" in node) {
    for (const child of (node as ChildrenMixin).children) collectInstances(child, out);
  }
}

function collectAll(node: SceneNode, out: SceneNode[]) {
  out.push(node);
  if ("children" in node) {
    for (const child of (node as unknown as ChildrenMixin).children) collectAll(child as SceneNode, out);
  }
}

// Les noms de variantes sont des chaines "Prop1=Val1, Prop2=Val2, ..." dont
// l'ORDRE depend de l'ordre de creation des proprietes dans le fichier
// source. Deux fichiers independants (ex. Mealz DS vs UI Kit d'un client)
// peuvent definir les memes proprietes dans un ordre different pour un
// composant par ailleurs identique. On normalise en triant les paires
// "propriete=valeur" alphabetiquement avant de comparer, pour ne pas rater
// un match a cause du seul ordre (la comparaison reste sensible aux noms de
// propriete/valeurs eux-memes, comme le swap natif).
function canonicalVariantName(name: string): string {
  const parts = name.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => p.includes("="))) {
    parts.sort((a, b) => a.localeCompare(b));
    return parts.join(", ");
  }
  return name.trim();
}

function componentFullName(main: ComponentNode): string {
  const parent = main.parent;
  const variantName = canonicalVariantName(main.name);
  if (parent && parent.type === "COMPONENT_SET") return `${parent.name}/${variantName}`;
  return variantName;
}

function describeScope(scope: SwapScope, roots: readonly SceneNode[]): string {
  if (scope === "page") return `Whole page "${figma.currentPage.name}"`;
  if (roots.length === 1) return `Selection: "${roots[0].name}"`;
  return `Selection: ${roots.length} elements`;
}

// ---------------------------------------------------------------------------
// Progress reporting (throttled so we don't flood the UI bridge)
// ---------------------------------------------------------------------------

let swapStartTime = 0;
let lastProgressSent = 0;

function reportProgress(phase: SwapCategory, done: number, total: number) {
  const now = Date.now();
  if (now - lastProgressSent < 80 && done < total) return;
  lastProgressSent = now;
  post({ type: "progress", phase, done, total, elapsedMs: now - swapStartTime });
}

// ---------------------------------------------------------------------------
// Phase 2 helpers - variables
// ---------------------------------------------------------------------------

async function resolveTargetVariable(
  alias: VariableAlias | undefined | null,
  sourceCat: VariableCatalog,
  targetCat: VariableCatalog,
  counts: SwapCounts,
  unmatched: UnmatchedEntry[],
  nodeName: string,
  collectionMap?: Map<string, string>,
): Promise<Variable | null> {
  if (!alias || !alias.id) return null;
  const variable = await figma.variables.getVariableByIdAsync(alias.id);
  if (!variable || !variable.remote) return null;
  if (!sourceCat.byKey.has(variable.key)) return null; // pas une variable de la library source

  const fullName = sourceCat.byKey.get(variable.key)!;
  const targetKey = targetCat.byKey.has(variable.key) ? variable.key : targetCat.byName.get(fullName);

  if (!targetKey) {
    unmatched.push({ category: "variables", name: fullName, nodeName });
    return null;
  }

  const targetVariable = await importVariableCached(targetKey);
  counts.variables++;
  // On note quelle collection source correspond a quelle collection cible :
  // sert ensuite a remapper les modes explicites (voir remapExplicitVariableModes).
  if (collectionMap && variable.variableCollectionId && targetVariable.variableCollectionId) {
    collectionMap.set(variable.variableCollectionId, targetVariable.variableCollectionId);
  }
  return targetVariable;
}

async function processNodeVariables(
  node: SceneNode,
  sourceCat: VariableCatalog,
  targetCat: VariableCatalog,
  counts: SwapCounts,
  unmatched: UnmatchedEntry[],
  collectionMap: Map<string, string>,
) {
  const bv = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables;
  if (!bv) return;
  const anyNode = node as any;

  for (const field of Object.keys(bv)) {
    const value = bv[field];

    if (field === "fills" || field === "strokes") {
      const paints: Paint[] | undefined = anyNode[field];
      if (!Array.isArray(paints)) continue;
      let changed = false;
      const newPaints = await Promise.all(
        paints.map(async (paint) => {
          if (paint.type !== "SOLID" || !paint.boundVariables?.color) return paint;
          const targetVar = await resolveTargetVariable(
            paint.boundVariables.color,
            sourceCat,
            targetCat,
            counts,
            unmatched,
            node.name,
            collectionMap,
          );
          if (!targetVar) return paint;
          changed = true;
          return figma.variables.setBoundVariableForPaint(paint as SolidPaint, "color", targetVar);
        }),
      );
      if (changed) {
        if (field === "fills" && typeof anyNode.setFillsAsync === "function") {
          await anyNode.setFillsAsync(newPaints);
        } else if (field === "strokes" && typeof anyNode.setStrokesAsync === "function") {
          await anyNode.setStrokesAsync(newPaints);
        } else {
          anyNode[field] = newPaints;
        }
      }
    } else if (field === "effects") {
      const effects: Effect[] | undefined = anyNode.effects;
      if (!Array.isArray(effects)) continue;
      let changed = false;
      const newEffects = await Promise.all(
        effects.map(async (effect) => {
          const effectBoundVars = (effect as unknown as { boundVariables?: Record<string, VariableAlias> }).boundVariables;
          if (!effectBoundVars) return effect;
          let updated = effect;
          for (const key of Object.keys(effectBoundVars)) {
            const alias = effectBoundVars[key];
            const targetVar = await resolveTargetVariable(alias, sourceCat, targetCat, counts, unmatched, node.name, collectionMap);
            if (targetVar) {
              updated = figma.variables.setBoundVariableForEffect(updated, key as VariableBindableEffectField, targetVar);
              changed = true;
            }
          }
          return updated;
        }),
      );
      if (changed) anyNode.effects = newEffects;
    } else if (field === "layoutGrids") {
      const grids: LayoutGrid[] | undefined = anyNode.layoutGrids;
      if (!Array.isArray(grids)) continue;
      let changed = false;
      const newGrids = await Promise.all(
        grids.map(async (grid) => {
          if (!grid.boundVariables) return grid;
          let updated = grid;
          for (const key of Object.keys(grid.boundVariables)) {
            const alias = (grid.boundVariables as Record<string, VariableAlias>)[key];
            const targetVar = await resolveTargetVariable(alias, sourceCat, targetCat, counts, unmatched, node.name, collectionMap);
            if (targetVar) {
              updated = figma.variables.setBoundVariableForLayoutGrid(updated, key as VariableBindableLayoutGridField, targetVar);
              changed = true;
            }
          }
          return updated;
        }),
      );
      if (changed) anyNode.layoutGrids = newGrids;
    } else if (field === "componentProperties") {
      if (node.type !== "INSTANCE") continue;
      const props = value as Record<string, VariableAlias>;
      const updates: { [propertyName: string]: string | boolean | VariableAlias } = {};
      for (const propName of Object.keys(props)) {
        const targetVar = await resolveTargetVariable(props[propName], sourceCat, targetCat, counts, unmatched, node.name, collectionMap);
        if (targetVar) updates[propName] = figma.variables.createVariableAlias(targetVar);
      }
      if (Object.keys(updates).length) (node as InstanceNode).setProperties(updates);
    } else if (field === "textRangeFills") {
      unmatched.push({ category: "variables", name: "(multi-color text)", nodeName: node.name });
    } else {
      const alias = value as VariableAlias;
      const targetVar = await resolveTargetVariable(alias, sourceCat, targetCat, counts, unmatched, node.name, collectionMap);
      if (targetVar) {
        try {
          anyNode.setBoundVariable(field, targetVar);
        } catch {
          // Champ non re-bindable sur ce type de node : on ignore proprement.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2b - remap explicit variable modes (ex. "Dark" applique sur un
// frame/instance). Rebinder une variable ne suffit pas : le node peut avoir
// choisi explicitement un mode sur la collection SOURCE
// (node.explicitVariableModes[sourceCollectionId] = sourceModeId). Une fois
// la variable rattachee a la collection CIBLE, cette entree devient
// orpheline et Figma retombe sur le mode par defaut de la collection cible.
//
// node.explicitVariableModes peut pointer vers un ancien proxy local de la
// collection remote, different du proxy local utilise par la variable
// reellement bindee sur ce meme node, meme si les deux designent la MEME
// collection distante (ex. "Aliases"). On ne se fie donc pas aux ids
// locaux : on repart du NOM de la collection source (stable) et on va
// chercher directement dans la library CIBLE la collection de meme nom,
// exactement comme pour variables/composants.
// ---------------------------------------------------------------------------

async function remapExplicitVariableModes(
  allNodes: SceneNode[],
  targetLibraryName: string | undefined,
): Promise<number> {
  if (!targetLibraryName) return 0;

  const byCollectionId = new Map<string, { node: SceneNode; modeId: string }[]>();
  for (const node of allNodes) {
    const anyNode = node as any;
    const explicit = anyNode.explicitVariableModes as Record<string, string> | undefined;
    if (!explicit) continue;
    for (const [colId, modeId] of Object.entries(explicit)) {
      const list = byCollectionId.get(colId) ?? [];
      list.push({ node, modeId });
      byCollectionId.set(colId, list);
    }
  }
  if (byCollectionId.size === 0) return 0;

  let targetLibCollections: { key: string; name: string; libraryName: string }[] = [];
  try {
    targetLibCollections = (await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).filter(
      (c) => c.libraryName === targetLibraryName,
    );
  } catch {
    return 0;
  }

  let remapped = 0;
  for (const [colId, entries] of byCollectionId.entries()) {
    let srcCol: VariableCollection | null;
    try {
      srcCol = await figma.variables.getVariableCollectionByIdAsync(colId);
    } catch {
      srcCol = null;
    }
    if (!srcCol || !srcCol.remote) continue;

    const targetLibCol = targetLibCollections.find((c) => c.name.trim().toLowerCase() === srcCol!.name.trim().toLowerCase());
    if (!targetLibCol) continue;

    // L'API teamLibrary n'expose pas les modes d'une collection distante tant
    // qu'aucune de ses variables n'a ete importee dans ce fichier : on
    // importe donc n'importe laquelle de ses variables pour materialiser un
    // proxy local et pouvoir lire tgtCol.modes.
    let targetVars;
    try {
      targetVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(targetLibCol.key);
    } catch {
      continue;
    }
    if (targetVars.length === 0) continue;

    let anyTargetVar: Variable;
    try {
      anyTargetVar = await importVariableCached(targetVars[0].key);
    } catch {
      continue;
    }
    const tgtCol = await figma.variables.getVariableCollectionByIdAsync(anyTargetVar.variableCollectionId);
    if (!tgtCol) continue;

    const modeIdMap = new Map<string, string>();
    for (const m of srcCol.modes) {
      const match = tgtCol.modes.find((tm) => tm.name.trim().toLowerCase() === m.name.trim().toLowerCase());
      if (match) modeIdMap.set(m.modeId, match.modeId);
    }

    for (const { node, modeId } of entries) {
      const targetModeId = modeIdMap.get(modeId);
      if (!targetModeId) continue;
      try {
        (node as any).setExplicitVariableModeForCollection(tgtCol, targetModeId);
        remapped++;
      } catch {
        // Champ non re-bindable sur ce type de node : on ignore proprement.
      }
    }
  }

  return remapped;
}

// ---------------------------------------------------------------------------
// Phase 3 - text styles
// ---------------------------------------------------------------------------

async function processTextStyle(
  node: TextNode,
  sourceCat: RestCatalog,
  targetCat: RestCatalog,
  counts: SwapCounts,
  unmatched: UnmatchedEntry[],
) {
  let segments;
  try {
    segments = node.getStyledTextSegments(["textStyleId"]);
  } catch {
    return;
  }

  for (const seg of segments) {
    const styleId = seg.textStyleId;
    if (!styleId) continue;
    const style = await figma.getStyleByIdAsync(styleId);
    if (!style || !style.remote) continue;
    if (!sourceCat.textStylesByKey.has(style.key)) continue;

    const fullName = sourceCat.textStylesByKey.get(style.key)!;
    const targetKey = targetCat.textStylesByKey.has(style.key) ? style.key : targetCat.textStylesByName.get(fullName);

    if (!targetKey) {
      unmatched.push({ category: "textStyles", name: fullName, nodeName: node.name });
      continue;
    }

    const targetStyle = await importStyleCached(targetKey);
    await node.setRangeTextStyleIdAsync(seg.start, seg.end, targetStyle.id);
    counts.textStyles++;
  }
}

// ---------------------------------------------------------------------------
// Phase 4 - effect styles
// ---------------------------------------------------------------------------

async function processEffectStyle(
  node: SceneNode,
  sourceCat: RestCatalog,
  targetCat: RestCatalog,
  counts: SwapCounts,
  unmatched: UnmatchedEntry[],
) {
  const anyNode = node as any;
  const styleId = anyNode.effectStyleId as string | undefined;
  if (!styleId || typeof styleId !== "string") return;

  const style = await figma.getStyleByIdAsync(styleId);
  if (!style || !style.remote) return;
  if (!sourceCat.effectStylesByKey.has(style.key)) return;

  const fullName = sourceCat.effectStylesByKey.get(style.key)!;
  const targetKey = targetCat.effectStylesByKey.has(style.key) ? style.key : targetCat.effectStylesByName.get(fullName);

  if (!targetKey) {
    unmatched.push({ category: "effectStyles", name: fullName, nodeName: node.name });
    return;
  }

  const targetStyle = await importStyleCached(targetKey);
  if (typeof anyNode.setEffectStyleIdAsync === "function") {
    await anyNode.setEffectStyleIdAsync(targetStyle.id);
    counts.effectStyles++;
  }
}

// ---------------------------------------------------------------------------
// Phase 1 - components (toujours en premier, et en ordre BOTTOM-UP : les
// instances les plus profondes (ex. Button nichee dans Product Card) sont
// swappees avant leurs parents, pour eviter que la reconciliation interne de
// Figma declenchee par le swap du parent n'invalide notre reference a
// l'enfant avant qu'on ait pu la traiter.)
// ---------------------------------------------------------------------------

async function processComponents(
  roots: readonly SceneNode[],
  sourceCat: RestCatalog,
  targetCat: RestCatalog,
  counts: SwapCounts,
  unmatched: UnmatchedEntry[],
): Promise<void> {
  const instances: InstanceNode[] = [];
  for (const root of roots) collectInstances(root, instances);
  instances.reverse(); // bottom-up : descendants avant ancetres

  let done = 0;
  for (const instance of instances) {
    if (cancelRequested) break;
    done++;
    if (instance.removed) {
      reportProgress("components", done, instances.length);
      continue;
    }
    const main = await instance.getMainComponentAsync();
    reportProgress("components", done, instances.length);
    if (!main || !main.remote) continue;
    if (!sourceCat.componentsByKey.has(main.key)) continue; // pas un composant de la library source

    const fullName = componentFullName(main);
    let targetKey = targetCat.componentsByKey.has(main.key) ? main.key : targetCat.componentsByName.get(fullName);
    if (!targetKey) {
      // Filet de securite : UNIQUEMENT si le rattachement au component set a
      // echoue ET que la chaine de variante sans prefixe designe un candidat
      // UNIQUE dans la library cible. Sinon (0 ou 2+ candidats, ex. Button vs
      // Button Icon qui partagent les memes valeurs Type/Size/State), on
      // refuse de deviner : un mauvais swap silencieux est pire qu'un swap
      // manque.
      const candidates = targetCat.componentsByBareVariant.get(canonicalVariantName(main.name));
      if (candidates && candidates.length === 1) targetKey = candidates[0];
    }

    if (!targetKey) {
      unmatched.push({ category: "components", name: fullName, nodeName: instance.name });
      continue;
    }

    try {
      const targetComponent = await importComponentCached(targetKey);
      instance.swapComponent(targetComponent);
      counts.components++;
    } catch (e) {
      unmatched.push({ category: "components", name: fullName, nodeName: instance.name });
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function runSwap(msg: Extract<UiToMainMessage, { type: "run-swap" }>) {
  cancelRequested = false;
  swapStartTime = Date.now();
  lastProgressSent = 0;

  const cfg = await loadConfig();
  if (!cfg.token) {
    post({ type: "error", message: "No Figma token saved. Add it in the Configuration tab." });
    return;
  }
  if (!cfg.base) {
    post({ type: "error", message: "No reference library set." });
    return;
  }

  const target = cfg.targets.find((t) => t.id === msg.targetId);
  if (!target) {
    post({ type: "error", message: "Target library not found." });
    return;
  }

  const [fileKeySource, fileKeyTarget] =
    msg.direction === "BaseToTarget" ? [cfg.base.fileKey, target.fileKey] : [target.fileKey, cfg.base.fileKey];
  // "variableLibraryName" is only an override. By default, always fall back
  // to the real file name so variables are considered automatically as soon
  // as a reference/target library is configured - no separate manual step
  // required for the common case where the published library name matches
  // the file name.
  const [varLibSource, varLibTarget] =
    msg.direction === "BaseToTarget"
      ? [cfg.base.variableLibraryName || cfg.base.fileName, target.variableLibraryName || target.fileName]
      : [target.variableLibraryName || target.fileName, cfg.base.variableLibraryName || cfg.base.fileName];

  post({ type: "log", level: "info", message: "Loading catalogs (components, styles, variables)…" });

  let sourceCatalog: RestCatalog;
  let targetCatalog: RestCatalog;
  try {
    [sourceCatalog, targetCatalog] = await Promise.all([
      fetchRestCatalog(cfg.token, fileKeySource),
      fetchRestCatalog(cfg.token, fileKeyTarget),
    ]);
  } catch (e) {
    post({ type: "error", message: `Failed to load REST catalogs: ${e instanceof Error ? e.message : e}` });
    return;
  }

  const [sourceVarCatalog, targetVarCatalog] = await Promise.all([
    fetchVariableCatalog(varLibSource),
    fetchVariableCatalog(varLibTarget),
  ]);

  const roots = getScopeRoots(msg.scope);
  const counts: SwapCounts = { components: 0, variables: 0, textStyles: 0, effectStyles: 0 };
  const unmatched: UnmatchedEntry[] = [];
  // sourceCollectionId -> targetCollectionId, alimente au fil des variables
  // effectivement rebindees. Sert a remapper les modes explicites ensuite.
  const collectionMap = new Map<string, string>();

  post({ type: "log", level: "info", message: "Swapping components…" });
  await processComponents(roots, sourceCatalog, targetCatalog, counts, unmatched);

  const allNodes: SceneNode[] = [];
  for (const root of roots) collectAll(root, allNodes);

  if (!cancelRequested) {
    if (sourceVarCatalog.byKey.size === 0) {
      // Matching a variable requires its key to be found in the SOURCE
      // catalog first (see resolveTargetVariable). If no variable library
      // is configured on the source side, every single variable is skipped
      // silently, which used to show up as an unexplained "0" with nothing
      // in the unmatched list. Surface it clearly instead.
      unmatched.push({
        category: "variables",
        name: `(no variables found for "${varLibSource}" - make sure this library is enabled in this file's Assets > Libraries panel, or set an override name in Configuration if its published name differs from the file name)`,
        nodeName: "-",
      });
    } else {
      post({ type: "log", level: "info", message: "Swapping variables…" });
      let done = 0;
      for (const node of allNodes) {
        if (cancelRequested) break;
        await processNodeVariables(node, sourceVarCatalog, targetVarCatalog, counts, unmatched, collectionMap);
        done++;
        reportProgress("variables", done, allNodes.length);
      }

      if (!cancelRequested) {
        post({ type: "log", level: "info", message: "Remapping variable modes…" });
        const modesRemapped = await remapExplicitVariableModes(allNodes, varLibTarget);
        if (modesRemapped > 0) {
          post({
            type: "log",
            level: "info",
            message: `${modesRemapped} explicit variable mode override(s) (e.g. Dark) remapped to the target library.`,
          });
        }
      }
    }
  }

  if (!cancelRequested) {
    post({ type: "log", level: "info", message: "Swapping text styles…" });
    const textNodes = allNodes.filter((n) => n.type === "TEXT") as TextNode[];
    let done = 0;
    for (const t of textNodes) {
      if (cancelRequested) break;
      await processTextStyle(t, sourceCatalog, targetCatalog, counts, unmatched);
      done++;
      reportProgress("textStyles", done, textNodes.length);
    }
  }

  if (!cancelRequested) {
    post({ type: "log", level: "info", message: "Swapping effects…" });
    let done = 0;
    for (const node of allNodes) {
      if (cancelRequested) break;
      await processEffectStyle(node, sourceCatalog, targetCatalog, counts, unmatched);
      done++;
      reportProgress("effectStyles", done, allNodes.length);
    }
  }

  post({ type: "done", counts, unmatched, elapsedMs: Date.now() - swapStartTime });
  figma.notify(
    `Swap done: ${counts.components} components, ${counts.variables} variables, ${counts.textStyles} text styles, ${counts.effectStyles} effects.`,
  );
}

// ---------------------------------------------------------------------------
// UI messaging
// ---------------------------------------------------------------------------

async function sendInit() {
  const cfg = await loadConfig();
  let libNames: string[] = [];
  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    libNames = Array.from(new Set(collections.map((c) => c.libraryName))).sort();
  } catch {
    // teamlibrary indisponible (permissions ou aucune library de variables activee)
  }
  post({
    type: "init",
    config: { hasToken: !!cfg.token, base: cfg.base, targets: cfg.targets },
    enabledVariableLibraries: libNames,
    hasSelection: figma.currentPage.selection.length > 0,
  });
}

async function handleSetBase(msg: Extract<UiToMainMessage, { type: "set-base" }>) {
  const cfg = await loadConfig();
  if (!cfg.token) {
    post({ type: "base-error", message: "Add a token before setting the reference library." });
    return;
  }
  const fileKey = extractFileKey(msg.fileUrl);
  if (!fileKey) {
    post({ type: "base-error", message: "Invalid Figma file URL (expected: figma.com/design/... or /file/...)." });
    return;
  }

  let fileName: string;
  try {
    await fetchRestCatalog(cfg.token, fileKey);
    fileName = await fetchFileName(cfg.token, fileKey);
  } catch (e) {
    post({
      type: "base-error",
      message: `Could not access this file with this token (check permissions and the file_content:read scope): ${
        e instanceof Error ? e.message : e
      }`,
    });
    return;
  }

  const base: BaseLibrary = { fileKey, fileUrl: msg.fileUrl, fileName, variableLibraryName: msg.variableLibraryName };
  cfg.base = base;
  await saveConfig(cfg);
  post({ type: "base-set", base });
}

async function handleAddTarget(msg: Extract<UiToMainMessage, { type: "add-target" }>) {
  const cfg = await loadConfig();
  if (!cfg.token) {
    post({ type: "target-error", message: "Add a token before configuring a target library." });
    return;
  }

  const fileKey = extractFileKey(msg.fileUrl);
  if (!fileKey) {
    post({ type: "target-error", message: "Invalid Figma file URL (expected: figma.com/design/... or /file/...)." });
    return;
  }

  let fileName: string;
  try {
    await fetchRestCatalog(cfg.token, fileKey);
    fileName = await fetchFileName(cfg.token, fileKey);
  } catch (e) {
    post({
      type: "target-error",
      message: `Could not access this file with this token (check permissions and the file_content:read scope): ${
        e instanceof Error ? e.message : e
      }`,
    });
    return;
  }

  const target: TargetLibrary = {
    id: `target_${Date.now()}`,
    fileKey,
    fileUrl: msg.fileUrl,
    fileName,
    label: msg.label || fileName,
    variableLibraryName: msg.variableLibraryName,
  };

  cfg.targets.push(target);
  await saveConfig(cfg);
  post({ type: "target-added", target });
}

figma.ui.onmessage = async (msg: UiToMainMessage) => {
  try {
    switch (msg.type) {
      case "ui-ready":
        await sendInit();
        break;
      case "save-token": {
        const cfg = await loadConfig();
        cfg.token = msg.token;
        await saveConfig(cfg);
        post({ type: "token-saved" });
        break;
      }
      case "clear-token": {
        const cfg = await loadConfig();
        cfg.token = null;
        await saveConfig(cfg);
        await sendInit();
        break;
      }
      case "set-base":
        await handleSetBase(msg);
        break;
      case "clear-base": {
        const cfg = await loadConfig();
        cfg.base = null;
        await saveConfig(cfg);
        await sendInit();
        break;
      }
      case "add-target":
        await handleAddTarget(msg);
        break;
      case "delete-target": {
        const cfg = await loadConfig();
        cfg.targets = cfg.targets.filter((t) => t.id !== msg.id);
        await saveConfig(cfg);
        post({ type: "target-deleted", id: msg.id });
        break;
      }
      case "get-scope-info": {
        const roots = getScopeRoots(msg.scope);
        const nodes: SceneNode[] = [];
        for (const r of roots) collectAll(r, nodes);
        post({ type: "scope-info", scope: msg.scope, count: nodes.length, label: describeScope(msg.scope, roots) });
        break;
      }
      case "run-swap":
        await runSwap(msg);
        break;
      case "cancel-swap":
        cancelRequested = true;
        break;
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
