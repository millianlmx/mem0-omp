// Panneau : le composant plein écran.
import * as fs from "node:fs";
import * as path from "node:path";
import { realpathOr } from "./git.ts";
import { AUDIT_RELAY_MILESTONE_REFUSAL, AUDIT_RELAY_REFUSAL, LOT_EDITOR_MAX, lotCancelRefusal, lotReplyRefusal, lotStateCancellable, lotStateTerminal, rowReply } from "./lot.ts";
import type { LotFeature } from "./lot.ts";
import type { AddFeatureInput, LotPanelActions } from "./lotController.ts";
import { DEFAULT_MODEL_CHOICE, featureModelOf, filterModelChoices } from "./models.ts";
import { applyExpanded, buildSessionComponents, cursorGlyph, disposeAssembly, entryKey, evictEntries, toolUi } from "./panelHost.ts";
import type { HostComponent, PanelTheme, PanelTui, SessionAssembly } from "./panelHost.ts";
import { PANEL_REFRESH_MS, buildPanelRows, clampSelection, hasLiveWriter, isLotFeature, liveWriterPid, lotModeRows, lotModeText, moveSelection, noSessionNotice, panelBudget, panelHeight, panelIndexForKey, panelRowAt, panelRowCount, panelSelectionKey, parseSgrMouse, readPanelModel, rowCwd, rowLabel, rowPhase, rowSessionFile, rowStateLabel, staleGestureNotice } from "./panelRows.ts";
import type { LotPanelMode, PanelGesture, PanelGlyphs, PanelModel, PanelRow, PanelRowRef, SgrMouseEvent } from "./panelRows.ts";
import { SESSION_VIEW_MAX_ENTRIES, extendSessionTail, readSessionTail } from "./panelSession.ts";
import type { SessionEntryLike, SessionTail } from "./panelSession.ts";
import { END_KEYS, EXPAND_KEY, FAST_SCROLL_LINES, HOME_KEYS, SHIFT_DOWN_KEYS, SHIFT_UP_KEYS, WHEEL_SCROLL_LINES, componentLabel, defaultSchedule, inputZone, panelSelections, readOnlyReason, sameZoneSource, unreadableLine, viewFooter, viewZoneRows, zoneScrollOf } from "./panelView.ts";
import type { HostKeybinding, PanelComponent, PanelKeybindings, PanelView, PipelinesPanelDeps, ViewInputZone, ViewTranscript, ViewZone } from "./panelView.ts";
import { LIST_MODE_MAX_LINES, PANEL_NOTICE_MAX_LINES, ROW_PADDING_X, VIEW_ZONE_MAX_LINES, WINDOW_FOLLOW, serviceRow, textWindow } from "./panelWidth.ts";
import type { TextWindow } from "./panelWidth.ts";
import type { WorktreeFate } from "./runs.ts";
import { asStringOrNull, deleteHistoryEntry, dropInbox, panelInboxDirFor, panelInboxDirOf, pidAlive, writeDelivery } from "./store.ts";
import type { PanelDelivery } from "./store.ts";



/**
 * Fabrique du composant, au contrat `Component` de la TUI : `render(width)` rend
 * des rangs ≤ `width`, `dispose` arrête la minuterie. Le premier rendu est déjà
 * peuplé (lecture synchrone bornée : il n'y a pas d'état « chargement »), et un
 * magasin vide n'empêche pas le panneau de s'afficher.
 */
export function pipelinesPanelFactory(deps: PipelinesPanelDeps) {
  return (
    tui: PanelTui,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (result?: unknown) => void,
  ): PanelComponent => {
    // Le kit de l'hôte est la SEULE source du rendu (S-1). Un panneau monté sans
    // lui (chemin de refus de `openPanel`) ne rend rien : une ligne le dit, et
    // aucune touche n'agit — jamais un second rendu, jamais une exception.
    const kit = deps.components;
    if (!kit) {
      return {
        render: () => ["[pipeline] panneau indisponible : composants de l'hôte absents (OMP)"],
        handleInput: () => {},
        refresh: () => {},
        dispose: () => {},
      };
    }
    const glyphs: PanelGlyphs = { cursor: cursorGlyph(theme) };
    const ui = toolUi(tui);
    const now = deps.now ?? (() => Date.now());
    const schedule = deps.schedule ?? defaultSchedule;

    /**
     * Rend un composant de l'hôte en ISOLANT son échec (S-1 « Cas limites ») : la
     * vue monte ces composants sur le JSONL d'un AUTRE process (résultat d'outil
     * malformé, `details` d'une autre version), donc un `throw` ne sort pas de
     * l'overlay — il devient le rang d'erreur du composant fautif, à sa place, et
     * le reste de l'écran reste peint.
     */
    const renderComponent = (component: HostComponent, label: string, width: number): string[] => {
      try {
        return [...component.render(width)];
      } catch (error) {
        return [unreadableLine(label, error, width)];
      }
    };
    /** La clé de la sélection mémorisée : une racine de dépôt, un état (S-5). */
    const selectionKey = deps.repoRoot ?? "";
    let notice: string | null = null;
    let mode: LotPanelMode = { kind: "browse" };
    // La VUE repart toujours de la liste : elle ne se quitte que par Échap, donc un
    // panneau fermé n'a jamais été fermé depuis la vue (S-5).
    let view: PanelView = { kind: "list" };
    /**
     * Les BROUILLONS de la vue, par RANG (S-7) : `Échap` rend la liste SANS les
     * détruire — rouvrir la vue du même rang restitue le tampon dans un éditeur
     * libre, et une livraison réussie l'oublie. En mémoire du composant monté
     * seulement, comme `panelSelections` : aucun fichier, aucun partage.
     */
    const drafts = new Map<string, string>();
    /** La clé d'un brouillon : le slug de la feature, sinon son fichier de session, sinon son libellé. */
    const draftKey = (row: PanelRowRef): string =>
      isLotFeature(row) ? row.slug : (rowSessionFile(model, row) ?? row.label);
    /**
     * La largeur du DERNIER rendu : les touches qui fenêtrent un texte (S-2,
     * `PageUp`/`PageDown` du champ comme de la zone) mesurent le même repli que le
     * rendu qu'elles viennent de peindre, sans relire la géométrie du terminal.
     */
    let lastWidth = 0;
    /**
     * La VERSION du rendu : elle change dès que quelque chose change (contenu,
     * pliage, zone, sélection, horloge du panneau) et JAMAIS sinon — c'est elle qui
     * autorise le composant à rendre le MÊME tableau, condition du « sans
     * clignotement » de S-5.
     */
    let version = 0;
    /** Le dernier rendu mémoïsé : sa clé, ses lignes, et la cible de chacune (S-7). */
    let renderedKey = "";
    let renderedLines: string[] = [];
    /** Les rangs du DERNIER rendu, une entrée par LIGNE rendue : le clic y résout la sienne. */
    let drawn: (PanelRow | null)[] = [];
    let model = readPanelModel({
      stateDir: deps.stateDir,
      repoRoot: deps.repoRoot,
      notice,
      mode,
      now: now(),
    });
    // La CLÉ de rang mémorisée se résout sur le modèle FRAIS (PANEL-3) : l'index de la
    // ligne qui la porte, ou la voisine bornée si elle a disparu.
    model = { ...model, selection: panelIndexForKey(model, panelSelections.get(selectionKey), 0) };

    /** Fige la sélection courante : c'est sa CLÉ que le prochain montage restaurera (PANEL-3). */
    const remember = () => {
      const key = panelSelectionKey(model);
      if (key !== null) panelSelections.set(selectionKey, key);
    };


    /**
     * Les boîtes où CE panneau a déposé une livraison (S-9), par DOSSIER et par CLÉ
     * DE RANG (VIEW-3) : quand le run qui les consommait disparaît du magasin, ses
     * livraisons non consommées reviennent à l'utilisateur — notice, et texte reposé
     * dans le brouillon de SON rang. Sans la clé, le reste d'une boîte d'alpha
     * atterrissait dans la zone de beta et partait au mauvais maillon. On ne surveille
     * que ce qu'on a écrit, et jamais la boîte d'une feature de LOT : le pilote la
     * récupère lui-même (`takeInbox`/`queueLeftovers`) pour le maillon suivant.
     */
    const watchedBoxes = new Map<string, string>();
    /**
     * Les `toolCallId` d'`ask` DÉJÀ répondus (VIEW-10) : tant que le maillon n'a pas
     * republié sa question, la zone ne se rebinde pas sur une question répondue — sans
     * quoi un second `Entrée` renvoyait la même option, et un texte libre partait
     * comme réponse à une question déjà close. Vidé quand la vue rebâtit sur une
     * autre session (VIEW-1) : les appels d'un maillon ne valent que pour lui.
     */
    const answeredAsks = new Set<string>();

    /**
     * Le fichier de session que la VUE suit pour un rang (VIEW-1, VIEW-5) : celui du
     * run VIVANT apparié quand il y en a un (c'est lui qui écrit), sinon — pour une
     * feature du lot — la session de son DERNIER run, QUEL QUE SOIT SON SORT
     * (`lastRunSessionFile`) : `feature.sessionFile` ne retient que les succès, donc
     * une feature échouée montrait la conversation du dernier maillon réussi au lieu
     * du run qui a planté.
     */
    const viewSessionFile = (row: PanelRowRef): string | null => {
      if (!isLotFeature(row)) return asStringOrNull(row.sessionFile);
      return (
        asStringOrNull(model.live[row.slug]?.sessionFile) ??
        asStringOrNull(row.lastRunSessionFile) ??
        asStringOrNull(row.sessionFile)
      );
    };

    /**
     * Le rang vise-t-il la session COURANTE de ce process (VIEW-8) ? Y répondre
     * ferait relancer `--resume` sur la session ouverte ici même : deux écrivains sur
     * le même JSONL, et le tour de l'utilisateur avorté. La question se pose sur
     * TOUS les fichiers qu'une écriture atteindrait (le run vivant, la session de la
     * feature, celle du dernier run).
     */
    const ownSession = (files: Array<string | null>): boolean => {
      const current = deps.currentSessionFile ?? null;
      if (current === null) return false;
      const real = realpathOr(current);
      return files.some((file) => file !== null && realpathOr(file) === real);
    };

    /**
     * Le motif du refus d'écrire dans un worktree OCCUPÉ (VIEW-2) : un run VIVANT d'un
     * autre process y travaille (quel que soit son fichier de session), ou c'est le
     * worktree d'une feature de lot non terminale. Deux agents dans le même arbre
     * éditent les mêmes fichiers ET publient le même fichier d'entrée
     * (`running/<runningIdFor(cwd)>.json`) : ils s'écrasent, et l'un des deux efface
     * la boîte, le `pendingAsk` et la session vus par le panneau.
     */
    const busyWorktreeReason = (cwd: string | null): string | null => {
      if (cwd === null || cwd === "") return null;
      const real = realpathOr(cwd);
      for (const entry of [...model.running, ...Object.values(model.live)]) {
        if (entry.owner.pid === process.pid || !pidAlive(entry.owner.pid)) continue;
        if (realpathOr(entry.cwd) === real) return "un maillon du lot travaille dans ce worktree";
      }
      const feature = features().find((candidate) => candidate.worktree !== "" && realpathOr(candidate.worktree) === real);
      if (feature && !lotStateTerminal(feature.state)) return "un maillon du lot travaille dans ce worktree";
      return null;
    };
    /** Les clés des entrées qui ne sont plus chargées : `merged` moins les `keep` dernières (VIEW-11). */
    const evictedKeys = (merged: SessionEntryLike[], keep: number): string[] =>
      merged.slice(0, Math.max(0, merged.length - keep)).map(entryKey);

    const collectLeftovers = (): boolean => {
      if (watchedBoxes.size === 0) return false;
      const live = [...model.running, ...Object.values(model.live)]
        .filter((entry) => pidAlive(entry.owner.pid))
        .map((entry) => panelInboxDirOf(entry));
      let changed = false;
      for (const [dir, key] of [...watchedBoxes]) {
        if (!fs.existsSync(dir)) {
          watchedBoxes.delete(dir); // boîte consommée et retirée par son run
          continue;
        }
        if (live.includes(dir)) continue; // le run vit encore : ses messages l'attendent
        watchedBoxes.delete(dir);
        const texts = dropInbox(dir);
        if (texts.length === 0) continue;
        const last = (texts[texts.length - 1] as string).slice(0, LOT_EDITOR_MAX);
        // Le reste appartient à SON rang (VIEW-3) : il va dans ses brouillons, et il
        // ne se pose dans la zone ouverte que si c'est bien le rang affiché.
        drafts.set(key, last);
        const row = view.kind === "session" ? rowForView() : undefined;
        if (
          view.kind === "session" &&
          row !== undefined &&
          draftKey(row) === key &&
          view.zone.kind === "input" &&
          view.zone.toolCallId === null
        ) {
          view = { ...view, zone: { ...view.zone, buffer: last, free: true } };
        }
        notice = `message non transmis — le run est terminé (${texts.length})`;
        changed = true;
      }
      return changed;
    };

    /**
     * Relit la transcription de la vue (S-5, S-8) : le lecteur ne lit que les
     * octets NOUVEAUX quand le fichier n'a fait que grandir, l'assembleur ne
     * construit que les entrées qu'il ne connaît pas encore, et une réécriture
     * (identité ou sondes changées) repart de zéro. Rend `true` si l'écran change.
     */
    const readTranscript = (): boolean => {
      if (view.kind !== "session") return false;
      const transcript = view.transcript;
      if (transcript.sessionFile === null) return false;
      const read = readSessionTail(transcript.sessionFile, transcript.tail);
      const reset = read.mode === "reset";
      const merged = [...transcript.entries, ...read.entries];
      // Borne du cache d'entrées (S-8) : le plus ancien est évincé le premier, et
      // ce qui n'est plus chargé est ANNONCÉ (`… début tronqué`), jamais coupé en
      // silence. L'assemblage suit la MÊME borne (VIEW-11) : les composants des
      // entrées évincées sont retirés et LIBÉRÉS, sans quoi 601 entrées faisaient
      // 601 composants pour une borne annoncée de 500.
      const evicted = merged.length > SESSION_VIEW_MAX_ENTRIES;
      const entries = reset ? read.entries : evicted ? merged.slice(merged.length - SESSION_VIEW_MAX_ENTRIES) : merged;
      const truncated = read.truncated || evicted;
      const more = read.more && entries.length < SESSION_VIEW_MAX_ENTRIES;
      const changed =
        reset ||
        read.entries.length > 0 ||
        read.error !== transcript.error ||
        truncated !== transcript.truncated ||
        more !== transcript.more;
      if (!changed) return false;
      if (reset) disposeAssembly(transcript.assembly); // le fichier est réécrit : l'assemblage d'avant est abandonné
      const previous = reset ? null : transcript.assembly;
      if (evicted && previous) evictEntries(previous, evictedKeys(merged, entries.length));
      view = {
        ...view,
        transcript: {
          ...transcript,
          tail: read.tail,
          entries,
          truncated,
          more,
          error: read.error,
          // Les comptes de lignes ne repartent QUE si le préfixe de l'assemblage a
          // bougé (réécriture, éviction) : en ajout, les composants déjà mesurés
          // gardent leur compte, et seuls les nouveaux sont mesurés (VIEW-11).
          counts: reset || evicted ? [] : transcript.counts,
          countsWidth: reset || evicted ? 0 : transcript.countsWidth,
          assembly: buildSessionComponents(entries, {
            components: kit,
            ui,
            cwd: transcript.cwd,
            previous,
            // `ctrl+o` survit à une réécriture (VIEW-12) : l'état global de pliage
            // appartient à la vue, pas à l'assemblage qu'elle remplace.
            expanded: transcript.assembly?.expanded,
          }),
        },
      };
      return true;
    };

    /**
     * La vue suit l'instant présent : son rang peut avancer, se terminer, changer
     * de section, et sa transcription grandir (S-5). Rend `true` si l'écran change
     * — c'est ce qui évite de repeindre un cadre identique.
     */
    const followView = (): boolean => {
      if (view.kind !== "session") return false;
      let changed = false;
      const row = rowForView();
      if (row) {
        // La CHAÎNE a changé de maillon (VIEW-1) : chaque maillon d'un lot est un run
        // SANS `--resume`, donc un fichier de session NEUF. La vue restait collée à
        // celui de l'ouverture — titre « /impl », corps de la revue — et la
        // progression du fix n'apparaissait jamais sans Échap + Entrée. On rebâtit
        // sur le fichier courant ; le même calcul rattache une vue ouverte AVANT que
        // le run ait publié sa session.
        const file = viewSessionFile(row);
        if (file !== view.transcript.sessionFile) {
          disposeAssembly(view.transcript.assembly);
          answeredAsks.clear(); // une autre session : d'autres appels `ask`
          view = {
            ...view,
            transcript: {
              sessionFile: file,
              cwd: rowCwd(row) ?? view.transcript.cwd,
              tail: null,
              entries: [],
              truncated: false,
              more: false,
              error: null,
              assembly: null,
              counts: [],
              countsWidth: 0,
              followBottom: true,
              offsetLines: 0,
              link:
                file === null
                  ? null
                  : `nouveau maillon /${rowPhase(model, row)} — session ${path.basename(file)}`,
            },
          };
          changed = true;
        }
        const label = rowLabel(row);
        const phase = rowPhase(model, row);
        const state = rowStateLabel(model, row);
        const live = hasLiveWriter(model, row);
        if (label !== view.label || phase !== view.phase || state !== view.state || live !== view.live) {
          view = { ...view, label, phase, state, live };
          changed = true;
        }
      }
      // La question peut avoir changé (nouvelle réponse, nouveau maillon) : la
      // zone suit l'état frais — mais jamais sous les doigts d'un aperçu, et
      // jamais au prix du tampon tant que la source n'a pas bougé (S-11).
      if (refreshZone()) changed = true;
      if (readTranscript()) changed = true;
      return changed;
    };

    /**
     * Le rafraîchissement : le magasin est relu, et une vue ouverte suit l'instant
     * présent — son rang peut avancer, se terminer, changer de section, et sa
     * transcription est relue (au plus une fois par seconde pour l'affichage,
     * plus les relectures demandées par une touche : S-5).
     */
    const paint = () => {
      model = readPanelModel({
        stateDir: deps.stateDir,
        repoRoot: deps.repoRoot,
        selection: model.selection,
        notice,
        mode,
        now: now(),
      });
      // La sélection suit la CLÉ du rang, jamais son index (PANEL-3) : une entrée
      // d'historique qui arrive en tête ne doit pas déplacer le curseur sur sa voisine.
      model = { ...model, selection: panelIndexForKey(model, panelSelections.get(selectionKey), model.selection) };
      // Un lot dont le pilote est MORT se reprend (PANEL-4) : sans ça, le panneau
      // affichait un lot qui travaille (horloge comprise) alors que plus personne ne
      // conduit la chaîne.
      if (model.driver?.kind === "dead") deps.lot?.adopt?.();
      // Un APERÇU qui décrit un état périmé se referme (PANEL-9) : entre l'ouverture et
      // l'`Entrée`, la liste s'est relue et le pilote a pu agir — un aperçu périmé fait
      // croire que le geste fera ce qu'il annonce.
      if (mode.kind === "confirm") {
        const stale = staleGestureNotice(mode.gesture, model.lot ?? null);
        if (stale !== null) {
          mode = { kind: "browse" };
          notice = stale;
          // Le modèle porte le mode et la notice que le RENDU peint : le refermer ici
          // sans le corriger laisserait l'aperçu périmé à l'écran.
          model = { ...model, mode, notice };
        }
      }
      // La LISTE change à chaque battement : son horloge (le temps écoulé) bouge à
      // la seconde. La VUE, elle, ne se repeint que si quelque chose a changé —
      // c'est la condition du « sans clignotement » (S-5).
      const changed = view.kind === "list" ? true : followView();
      // Les restes de boîte modifient la vue (brouillon reposé, notice) APRÈS le
      // calcul de `changed` (VIEW-3) : sans leur propre incrément de version, le
      // rendu mémoïsé laissait l'écran inchangé alors que la zone avait changé.
      const leftovers = collectLeftovers();
      if (changed || leftovers) version += 1;
    };
    const redraw = () => {
      paint();
      tui.requestRender?.();
    };
    const showNotice = (message: string) => {
      notice = message;
      paint();
      tui.requestRender?.();
    };
    const setMode = (next: LotPanelMode) => {
      mode = next;
      notice = null;
      paint();
      tui.requestRender?.();
    };
    const isKey = (data: string, keybinding: HostKeybinding) => keybindings?.matches?.(data, keybinding) === true;

    // Le lot occupe la TÊTE de la liste sélectionnable : les rangs machine suivent.
    const features = (): LotFeature[] => model.lot?.features ?? [];
    const selectedFeature = (): LotFeature | undefined => {
      const index = model.selection;
      return index >= 0 && index < features().length ? features()[index] : undefined;
    };
    /** Le rang sélectionné, quelle que soit sa section — la seule façon d'atteindre une feature appariée. */
    const selectedRow = (): PanelRowRef | undefined => panelRowAt(model, model.selection);
    /** Le rang qui porte ce fichier de session : la vue le suit d'un rendu à l'autre. */
    const rowForSession = (file: string): PanelRowRef | undefined => {
      for (let i = 0; i < panelRowCount(model); i++) {
        const row = panelRowAt(model, i);
        if (row && rowSessionFile(model, row) === file) return row;
      }
      return undefined;
    };
    /**
     * Le rang que la vue suit d'un rendu à l'autre : son SLUG quand c'est une feature
     * du lot (il survit à une session qui apparaît), sinon l'`id` de son entrée du
     * magasin (VIEW-13 — un run vivant qui n'a pas encore publié de fichier n'a aucune
     * session à nommer), puis son cwd, puis son fichier de session. Un rang disparu de
     * la liste ne fait pas tomber la vue.
     */
    const rowForView = (): PanelRowRef | undefined => {
      if (view.kind !== "session") return undefined;
      const { slug } = view;
      if (slug !== null) {
        const feature = features().find((candidate) => candidate.slug === slug);
        if (feature) return feature;
      }
      const store = [...model.running, ...model.history];
      const id = view.rowId;
      if (id !== null) {
        const found = store.find((entry) => entry.id === id);
        if (found) return found;
      }
      const sessionFile = view.transcript.sessionFile;
      if (sessionFile !== null) {
        const found = rowForSession(sessionFile);
        if (found) return found;
      }
      const cwd = view.rowCwd;
      if (cwd !== null && cwd !== "") {
        const real = realpathOr(cwd);
        return store.find((entry) => realpathOr(entry.cwd) === real);
      }
      return undefined;
    };
    /** La zone d'une question `ask` DÉJÀ répondue (VIEW-10) : une seule source du texte. */
    const ASK_ANSWERED_REASON = "réponse envoyée — en attente du maillon";

    /**
     * Les annulations EN VOL, par slug (PANEL-10) : `cancel` est un geste long (git,
     * archivage) et la liste se relit chaque seconde — sans cet état, la ligne
     * réannonçait `c annuler` pendant l'attente et un second `c` relançait le geste.
     */
    const cancelling = new Set<string>();

    /**
     * La zone de saisie d'un RANG (S-9), dans cet ordre : la règle du pilote
     * (`rowReply`, appliquée au run vivant publié) pour une feature du lot ; pour
     * tout autre rang, ce que la vue sait de sa session — un run VIVANT ARMÉ
     * accepte une écriture (sa boîte), une session terminée se reprend par un
     * nouveau run, une session vivante sans boîte appartient à son process, et la
     * nôtre se répond directement.
     */
    const zoneFor = (row: PanelRowRef | undefined): ViewZone => {
      if (!row) return { kind: "closed", reason: "session terminée" };
      if (isLotFeature(row)) {
        const slug = row.slug;
        // C'est TA session (VIEW-8) : le pilote relancerait `--resume` sur le JSONL
        // ouvert dans ce process, donc deux écrivains et le tour courant avorté.
        if (ownSession([viewSessionFile(row), row.sessionFile, row.lastRunSessionFile ?? null])) {
          return { kind: "closed", reason: "c'est ta session — réponds-y directement" };
        }
        // Une question confiée à une session /audit ouverte se ferme ici (S-3) :
        // la règle unique décide, le panneau ne fait que lui passer le relais.
        const reply = rowReply(row, { ...(model.live[slug] ?? {}), auditRelay: model.relayed[slug] === true });
        switch (reply.kind) {
          case "reply":
            return inputZone({
              slug,
              phase: reply.phase,
              // Une feature `waiting` répond à un TEXTE : ses options sont des
              // libellés lus dans le `waitPrompt`, sans description (S-5).
              options: reply.options.map((label) => ({ label })),
              queue: false,
              question: reply.question,
              target: { kind: "lot", slug },
            });
          case "ask":
            // Une question DÉJÀ répondue ne se rouvre pas (VIEW-10) : la zone dit
            // qu'une réponse est partie, et attend la question suivante.
            if (answeredAsks.has(reply.toolCallId)) {
              return { kind: "closed", reason: ASK_ANSWERED_REASON };
            }
            return inputZone({
              slug,
              phase: reply.phase,
              options: reply.options,
              queue: false,
              question: reply.question,
              toolCallId: reply.toolCallId,
              target: { kind: "inbox", dir: reply.inbox },
            });
          case "steer":
            return inputZone({
              slug,
              phase: reply.phase,
              options: [],
              queue: false,
              target: { kind: "inbox", dir: reply.inbox },
            });
          case "text":
            return inputZone({
              slug,
              phase: reply.phase,
              options: [],
              queue: false,
              target: { kind: "lot", slug },
            });
          case "queue":
            return inputZone({
              slug,
              phase: reply.phase,
              options: [],
              queue: true,
              target: { kind: "lot", slug },
            });
          case "closed":
            // Le motif de la règle est gardé quand il dit OÙ répondre : la collecte
            // en session, et la question confiée à la session /audit (S-3).
            if ((row.origin === "session" && row.phase === "req") || reply.reason === AUDIT_RELAY_REFUSAL) {
              return { kind: "closed", reason: reply.reason };
            }
            return { kind: "closed", reason: readOnlyReason(model.lot ?? null, row) };
        }
      }
      if ("finalState" in row) {
        const file = rowSessionFile(model, row);
        if (file === null) return { kind: "closed", reason: "session terminée" };
        // Une session DÉJÀ reprise par un run vivant ne se reprend pas une seconde
        // fois : deux process sur un même fichier de session, c'est un conflit
        // d'écriture garanti — même refus qu'un rang vivant (S-9).
        const writer = liveWriterPid(model, row);
        if (writer !== null) {
          return { kind: "closed", reason: `cette session appartient à un autre process (pid ${writer})` };
        }
        // Le WORKTREE est occupé (VIEW-2) : un maillon du lot y travaille — deux
        // agents dans le même arbre, et le même fichier d'entrée publié deux fois.
        // Le refus ne regarde pas le fichier de session : le run du lot en a un
        // AUTRE, donc l'ancienne garde ne le voyait pas.
        const busy = busyWorktreeReason(rowCwd(row));
        if (busy !== null) return { kind: "closed", reason: busy };
        // C'est TA session (VIEW-8) : `--resume` sur le JSONL ouvert ici.
        if (ownSession([file])) return { kind: "closed", reason: "c'est ta session — réponds-y directement" };
        if (!deps.sessionReply) return { kind: "closed", reason: "session terminée" };
        const rowModel = featureModelOf(model.lot ?? null, row.cwd);
        return inputZone({
          slug: row.label,
          phase: row.phase,
          options: [],
          queue: false,
          // Le modèle (S-5 §3) : celui de la feature dont ce rang est le worktree,
          // lu dans le lot du panneau. Hors lot, ou feature sans modèle : la cible
          // est exactement celle d'avant cette feature, sans clé `model`.
          target: {
            kind: "session",
            cwd: row.cwd,
            sessionFile: file,
            label: row.label,
            ...(rowModel === null ? {} : { model: rowModel }),
          },
        });
      }
      if (row.owner.pid === process.pid) return { kind: "closed", reason: "c'est ta session — réponds-y directement" };
      const dir = panelInboxDirOf(row);
      if (dir === null) return { kind: "closed", reason: `cette session appartient à un autre process (pid ${row.owner.pid})` };
      const ask = row.pendingAsk ?? null;
      if (ask) {
        // Une question déjà répondue ne se rouvre pas (VIEW-10) : la zone dit qu'une
        // réponse est partie.
        if (answeredAsks.has(ask.toolCallId)) return { kind: "closed", reason: ASK_ANSWERED_REASON };
        return inputZone({
          slug: row.label,
          phase: row.phase,
          options: ask.options,
          queue: false,
          question: ask.question,
          toolCallId: ask.toolCallId,
          target: { kind: "inbox", dir },
        });
      }
      return inputZone({
        slug: row.label,
        phase: row.phase,
        options: [],
        queue: false,
        target: { kind: "inbox", dir },
      });
    };
    /**
     * Le rafraîchissement de la zone : elle suit l'état frais, jamais le tampon.
     * Rend `true` quand la zone a changé de source — l'aperçu, lui, ne se réécrit
     * jamais sous les doigts (S-11).
     */
    const refreshZone = (): boolean => {
      if (view.kind !== "session" || view.zone.kind === "preview") return false;
      const next = zoneFor(rowForView());
      if (sameZoneSource(view.zone, next)) return false;
      const zone = view.zone;
      let carried = next;
      // Le BROUILLON survit au changement de source (VIEW-4) : un `ask` qui arrive,
      // une boîte qui se publie ou un maillon qui se termine ne doivent pas effacer
      // ce que l'utilisateur est en train de taper. Dans une zone d'éditeur, le
      // tampon est REPORTÉ tel quel ; sinon il est sauvé dans les brouillons du rang,
      // avec une notice qui dit où il est parti.
      if (zone.kind === "input" && zone.buffer !== "") {
        if (next.kind === "input") {
          carried = { ...next, free: true, cursor: next.options.length, buffer: zone.buffer };
        } else {
          const row = rowForView();
          if (row) drafts.set(draftKey(row), zone.buffer);
          notice = "brouillon conservé — la zone a changé de source";
        }
      }
      view = { ...view, zone: carried };
      return true;
    };
    /**
     * La zone de la vue : toute touche qui la change passe par ici (elle efface la
     * notice, qui décrit un rang et non le panneau), et un aperçu ne se réécrit
     * jamais sous les doigts — seule la livraison ou `Échap` en sortent.
     */
    const setZone = (next: ViewZone) => {
      if (view.kind !== "session") return;
      view = { ...view, zone: next };
      notice = null;
      version += 1;
      tui.requestRender?.();
    };
    // Le déplacement efface la notice : elle décrit un rang, pas le panneau.
    const move = (delta: number) => {
      notice = null;
      model = {
        ...model,
        notice: null,
        selection: moveSelection(model.selection, panelRowCount(model), delta),
      };
      remember();
      version += 1;
      tui.requestRender?.();
    };

    const remove = () => {
      // `d` vise le rang SÉLECTIONNÉ, résolu par sa CLÉ (PANEL-3) : calculer l'index
      // d'historique par `selection - features().length` supprimait une autre entrée
      // dès que la liste avait bougé entre le rendu et la touche. La clé vient du
      // MODÈLE courant — `model.selection` est ce que le rendu peint et ce que `move`
      // met à jour —, jamais de `panelSelections`, qui est la mémoire INTER-MONTAGES du
      // dépôt : un montage sans dépôt (clé `""`) y lirait la clé d'un autre panneau.
      const key = panelSelectionKey(model);
      if (key === null || !key.startsWith("hist:")) {
        // Un rang de lot ne se supprime pas : `x` le retire du lot (S-3) — le dire
        // vaut mieux qu'une touche muette. Une sélection vide reste muette.
        if (key !== null) showNotice("seules les entrées d'historique se suppriment");
        return;
      }
      const id = key.slice("hist:".length);
      const entry = model.history.find((candidate) => candidate.id === id);
      if (!entry) return;
      try {
        deleteHistoryEntry(deps.stateDir, entry.id);
      } catch (err) {
        showNotice(`suppression impossible : ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      notice = null;
      redraw();
    };

    /**
     * Une action du lot : elle ne jette jamais. Son motif de refus devient la
     * notice du panneau ; un succès redessine (l'état affiché vient des fichiers).
     * `keep` est le mode de saisie à REPOSER tel quel — S-7 : « chaque action
     * refusée par le modèle (nom invalide, etc.) laisse le mode et affiche le motif
     * dans le rang de notice ». Refermer l'éditeur avant de soumettre ferait
     * retaper les trois champs d'un ajout pour un simple « déjà dans le lot ».
     */
    const act = (run: () => Promise<string | null>, keep?: LotPanelMode) => {
      const settle = (reason: string | null) => {
        if (reason === null) {
          if (keep) setMode({ kind: "browse" }); // un succès ferme la saisie
          else {
            notice = null;
            redraw();
          }
          return;
        }
        if (keep) setMode(keep);
        showNotice(reason);
      };
      void run()
        .then(settle)
        .catch((err: unknown) => settle(err instanceof Error ? err.message : String(err)));
    };

    /**
     * `Entrée` (S-2) : la VUE de session du rang sélectionné — jamais la bascule.
     * Elle s'ouvre quand le rang a un fichier de session OU quand il accepte une
     * écriture (S-1/S-11) : une feature qui attend une réponse reste répondable
     * même si sa session a disparu du disque, et une feature en cours reste
     * joignable par un message. Un rang qui n'a ni l'un ni l'autre garde la
     * notice existante, et rien ne s'ouvre.
     */
    const openView = () => {
      const row = selectedRow();
      if (!row) return;
      const file = rowSessionFile(model, row);
      let zone = zoneFor(row);
      if (file === null && zone.kind === "closed") {
        showNotice(noSessionNotice(row));
        return;
      }
      // Le BROUILLON du rang est reposé (S-7) : la vue rouvre sur ce qui était
      // tapé, dans un éditeur libre — la question du maillon reste peinte au-dessus
      // s'il y en a une (S-5), et `Échap` remonte aux options quand il y en a.
      const draft = drafts.get(draftKey(row));
      if (draft !== undefined && draft !== "" && zone.kind === "input") {
        zone = { ...zone, free: true, buffer: draft };
      }
      // La notice n'est pas effacée : au retour, la liste est celle qu'on a quittée.
      // La transcription s'ouvre ANCRÉE SUR LA FIN (S-5) : le run en cours se voit
      // avancer sans rien toucher, et la première peinture est synchrone — le
      // lecteur part de la fin du fichier, borné (S-8.1).
      view = {
        kind: "session",
        slug: isLotFeature(row) ? row.slug : null,
        rowId: isLotFeature(row) ? null : row.id,
        rowCwd: rowCwd(row),
        label: rowLabel(row),
        phase: rowPhase(model, row),
        state: rowStateLabel(model, row),
        live: hasLiveWriter(model, row),
        transcript: {
          sessionFile: file,
          cwd: rowCwd(row) ?? deps.repoRoot ?? "",
          tail: null,
          entries: [],
          truncated: false,
          more: false,
          error: null,
          assembly: null,
          counts: [],
          countsWidth: 0,
          followBottom: true,
          offsetLines: 0,
          link: null,
        },
        zone,
      };
      version += 1;
      // Première peinture : la lecture est faite MAINTENANT, pas au premier
      // battement — la vue n'a pas d'état « chargement » à montrer.
      followView();
      tui.requestRender?.();
    };

    /**
     * `o` (S-3) : la bascule RÉELLE dans la session du rang, sous deux gardes qui
     * répondent à la même question — le fichier visé est-il VIVANT ? Un run qui
     * l'écrit (deux écrivains sur un fichier de session, c'est une
     * `SessionWriteConflictError` garantie) ou notre propre session courante
     * (`switchSession` avorte le tour courant AVANT de regarder la cible).
     */
    const join = () => {
      const row = selectedRow();
      if (!row) return;
      if (hasLiveWriter(model, row)) {
        showNotice("run en cours — la session s'ouvre en lecture seule (Entrée) ; o attend la fin du maillon");
        return;
      }
      const file = rowSessionFile(model, row);
      const current = deps.currentSessionFile ?? null;
      if (file !== null && current !== null && realpathOr(file) === realpathOr(current)) {
        showNotice("la collecte se déroule dans ta session — réponds-y directement");
        return;
      }
      if (file === null) {
        showNotice(noSessionNotice(row));
        return;
      }
      deps.join({ sessionFile: file }, () => done(), showNotice);
    };

    /**
     * Ce que la vue paie HORS transcription (les deux règles, le titre, la notice,
     * le rang d'état du corps, la fenêtre de zone et le pied), mesuré au dernier
     * rendu : le corps prend ce qui reste de la hauteur, au moins un rang (S-4).
     */
    let viewFixed = 4;

    /**
     * Le rang d'ÉTAT du corps de la vue (S-3) : `nouveau maillon …`, `aucune entrée
     * lisible`, `pas de transcription`, `aucune entrée à afficher`, `… début tronqué`
     * — un au plus, et il se lit EN TÊTE de la transcription, jamais à la place du
     * contenu.
     */
    const bodyStateRow = (innerW: number): PanelRow[] => {
      if (view.kind !== "session") return [];
      const transcript = view.transcript;
      const rows: PanelRow[] = [];
      // La vue a REBÂTI sa transcription sur un fichier neuf (VIEW-1) : elle nomme le
      // maillon qu'elle suit — le titre le dit aussi, mais c'est ici que le
      // changement de session se lit, au moment où il arrive.
      if (transcript.link !== null) rows.push(...serviceRow(transcript.link, "dim", innerW));
      if (transcript.error !== null) {
        rows.push(...serviceRow(`aucune entrée lisible — ${transcript.error}`, "warning", innerW));
        return rows;
      }
      if (transcript.sessionFile === null) {
        rows.push(...serviceRow(`pas de transcription — ${view.state}`, "muted", innerW));
        return rows;
      }
      if (transcript.entries.length === 0) {
        rows.push(...serviceRow("aucune entrée à afficher", "muted", innerW));
        return rows;
      }
      if (transcript.truncated) rows.push(...serviceRow("… début tronqué", "dim", innerW));
      return rows;
    };

    /**
     * Le nombre de rangs de transcription qu'une vue affiche : les deux règles du
     * cadre, le titre, la zone de saisie, la notice, le rang d'état du corps (S-3)
     * et le pied sont payés d'abord. Le défilement s'y tient comme le rendu : un rang
     * de plus et le corps déborderait la hauteur du terminal.
     */
    const viewRoom = (height: number) => Math.max(1, height - viewFixed);

    /** Le nombre total de rangs de la transcription ouverte, à la largeur courante. */
    const transcriptRows = (): number => {
      if (view.kind !== "session") return 0;
      return view.transcript.counts.reduce((total, count) => total + count, 0);
    };

    /**
     * Charge le bloc PRÉCÉDENT de la transcription (S-8), ou `null` s'il n'y a plus
     * rien avant. Les entrées plus anciennes s'assemblent À PART puis se placent
     * DEVANT : l'assemblage incrémental n'ajoute qu'à la fin, et la fenêtre ne
     * relit jamais le fichier pour un simple défilement.
     */
    const loadOlder = (
      transcript: ViewTranscript,
    ): { entries: SessionEntryLike[]; tail: SessionTail | null; truncated: boolean; more: boolean; added: number } | null => {
      const current = view;
      if (current.kind !== "session") return null;
      if (!transcript.more || transcript.tail === null || transcript.sessionFile === null) return null;
      const read = extendSessionTail(transcript.sessionFile, transcript.tail);
      if (read.entries.length === 0) return null;
      const older = buildSessionComponents(read.entries, {
        components: kit,
        ui,
        cwd: transcript.cwd,
        previous: null,
        // Les blocs anciens naissent dans l'état GLOBAL de pliage (VIEW-12) : chargés
        // repliés alors que `ctrl+o` est actif, ils mentaient sur l'état affiché.
        expanded: transcript.assembly?.expanded,
      });
      const width = transcript.countsWidth > 0 ? transcript.countsWidth : 80;
      let added = 0;
      for (const component of older.components) added += component.render(width).length;
      const assembly: SessionAssembly = transcript.assembly
        ? {
            ...transcript.assembly,
            components: [...older.components, ...transcript.assembly.components],
            byEntryId: new Map([...older.byEntryId, ...transcript.assembly.byEntryId]),
            expandables: [...older.expandables, ...transcript.assembly.expandables],
          }
        : older;
      const entries = [...read.entries, ...transcript.entries];
      view = {
        ...current,
        transcript: {
          ...transcript,
          tail: read.tail,
          entries,
          truncated: read.truncated,
          more: read.more && entries.length < SESSION_VIEW_MAX_ENTRIES,
          counts: [],
          countsWidth: 0,
          assembly,
        },
      };
      return { entries, tail: read.tail, truncated: read.truncated, more: read.more, added };
    };

    /**
     * Le défilement de la vue (S-6) : ancré sur les RANGS RENDUS, jamais sur les
     * octets, et borné — aux extrémités, la touche ne fait rien. `delta > 0` va vers
     * le plus récent (comme `ScrollView.scroll` de l'hôte). Descendre jusqu'au bas
     * RÉARME le suivi de queue (S-5) ; remonter le coupe, et la position ne bouge
     * plus quand du contenu arrive.
     */
    const scrollView = (delta: number) => {
      if (view.kind !== "session") return;
      const transcript = view.transcript;
      // Les comptes se REMESURENT avant de calculer la borne (VIEW-9) : une touche
      // traitée entre un changement de contenu et le rendu (rafale de molette dans
      // la même tranche stdin) trouvait `max = 0`, remettait `follow = true` et
      // renvoyait la vue en bas — la position de lecture était perdue.
      ensureCounts(transcript, lastWidth > 0 ? lastWidth : 80);
      const max = Math.max(0, transcriptRows() - viewRoom(panelHeight(tui)));
      const current = transcript.followBottom ? max : Math.min(Math.max(transcript.offsetLines, 0), max);
      const next = Math.min(Math.max(current + delta, 0), max);
      const follow = next >= max;
      // Remonter AU-DELÀ du plus ancien rang chargé charge le bloc précédent, et
      // l'ancre glisse d'autant : le rang qu'on regardait ne bouge pas (S-8).
      if (next === 0 && delta < 0) {
        const older = loadOlder(transcript);
        if (older) {
          // L'ancre est celle du rang REGARDÉ : ce qui vient d'être inséré devant
          // (`added`) plus ce qui restait au-dessus de lui (`next`) — VIEW-9.
          view = { ...view, transcript: { ...view.transcript, offsetLines: older.added + next, followBottom: false } };
          version += 1;
          tui.requestRender?.();
          return;
        }
      }
      if (next === current && follow === transcript.followBottom) return;
      view = { ...view, transcript: { ...transcript, offsetLines: next, followBottom: follow } };
      version += 1;
      tui.requestRender?.();
    };

    /** `Début` (S-6) : le plus ancien rang — et, si besoin, on le CHARGE (S-8). */
    const scrollToTop = () => {
      if (view.kind !== "session") return;
      loadOlder(view.transcript);
      view = { ...view, transcript: { ...view.transcript, offsetLines: 0, followBottom: false } };
      version += 1;
      tui.requestRender?.();
    };

    /** `Fin` (S-6) : le plus récent, et le suivi de queue est réarmé (S-5). */
    const scrollToBottom = () => {
      if (view.kind !== "session") return;
      view = { ...view, transcript: { ...view.transcript, followBottom: true, offsetLines: 0 } };
      version += 1;
      tui.requestRender?.();
    };

    /** Le libellé visé par la zone : la livraison n'envoie JAMAIS la description (S-5). */
    const chosenLabel = (zone: ViewInputZone): string =>
      zone.free || zone.options.length === 0 ? zone.buffer : (zone.options[zone.cursor]?.label ?? "");

    /**
     * L'aperçu d'une livraison — la porte par laquelle passent TOUS les gestes de la
     * vue, sauf la réponse à une question `ask` en vol (`confirmZone`, S-1). Un clic
     * sur une option arrive ici aussi : un clic seul n'écrit rien.
     */
    const openReplyPreview = () => {
      if (view.kind !== "session" || view.zone.kind !== "input") return;
      const zone = view.zone;
      const text = chosenLabel(zone).trim();
      if (text === "") {
        // Rien à envoyer : l'éditeur reste ouvert, tampon intact (S-4).
        showNotice("réponse vide");
        return;
      }
      setZone({ kind: "preview", input: zone, text });
    };

    /**
     * `Entrée` dans la zone (S-1, S-4, S-8) : la réponse à une question `ask` en vol
     * est livrée AU PREMIER `Entrée`, sans aperçu intermédiaire — c'est le seul
     * geste qui perd son aperçu ; tout le reste passe par `openReplyPreview`, la
     * seule porte d'une écriture vers le lot ou vers une session.
     */
    const confirmZone = () => {
      if (view.kind !== "session" || view.zone.kind !== "input") return;
      const zone = view.zone;
      if (zone.toolCallId === null) {
        openReplyPreview();
        return;
      }
      const text = chosenLabel(zone).trim();
      if (text === "") {
        showNotice("réponse vide");
        return;
      }
      deliver({ input: zone, text });
    };

    /**
     * `PageUp`/`PageDown` (S-2) : ils défilent la ZONE quand elle dépasse sa fenêtre
     * (éditeur libre comme aperçu), et la TRANSCRIPTION sinon — le sens d'avant,
     * conservé tant que la zone tient à l'écran. Rend `true` quand la zone a pris la
     * touche.
     */
    const scrollZone = (delta: number): boolean => {
      if (view.kind !== "session" || view.zone.kind === "closed") return false;
      const zone = view.zone;
      const input = zone.kind === "preview" ? zone.input : zone;
      const innerW = Math.max(0, lastWidth - ROW_PADDING_X * 2);
      const { rows } = viewZoneRows(zone, glyphs, innerW);
      const max = VIEW_ZONE_MAX_LINES(panelHeight(tui));
      if (rows.length <= max) return false;
      const top = rows.length - max;
      const current = input.scroll.follow ? top : Math.min(Math.max(input.scroll.offset, 0), top);
      const next = Math.min(Math.max(current + delta, 0), top);
      const scroll: TextWindow = { follow: next >= top, offset: next };
      setZone(zone.kind === "preview" ? { ...zone, input: { ...input, scroll } } : { ...zone, scroll });
      return true;
    };

    /**
     * La livraison confirmée : une seule écriture, puis la zone suit l'état frais.
     * La CIBLE décide du chemin (S-6, S-7, S-9) — une boîte reçoit un fichier de
     * livraison, une session terminée un nouveau run, le lot sa règle d'écriture.
     */
    const deliver = (zone: { input: ViewInputZone; text: string }) => {
      const input = zone.input;
      const text = zone.text;
      const target = input.target;
      const row = rowForView();
      // La zone est reposée AVANT l'appel — deux `Entrée` rapides ne livrent qu'une
      // fois — et VIDE : une livraison réussie oublie le brouillon (S-7), donc le
      // second `Entrée` n'a plus rien à envoyer. Une réponse à une question `ask`
      // (livrée au PREMIER `Entrée`, S-1) FERME la zone (VIEW-10) : la question est
      // répondue, et un second `Entrée` ou un Échap + Entrée ne doit pas renvoyer la
      // même option — le maillon n'a pas encore republié `pendingAsk`. Un refus
      // d'écriture, lui, repose la zone d'origine, tampon compris (`actView`).
      setZone(
        input.toolCallId === null
          ? { ...input, buffer: "" }
          : { kind: "closed", reason: ASK_ANSWERED_REASON },
      );
      /** Une livraison RÉUSSIE oublie le brouillon du rang (S-7). */
      const sent = () => {
        if (row) drafts.delete(draftKey(row));
      };
      /** Une réponse à un `ask` répondue ne se rouvre pas tant que la question vit (VIEW-10). */
      const sentAsk = () => {
        if (input.toolCallId !== null) answeredAsks.add(input.toolCallId);
      };
      if (target.kind === "session") {
        const reply = deps.sessionReply;
        if (!reply) {
          showNotice("session indisponible dans cette session");
          return;
        }
        const inbox = panelInboxDirFor(deps.stateDir, target.cwd);
        actView(async () => {
          const reason = await reply(
            {
              cwd: target.cwd,
              sessionFile: target.sessionFile,
              label: target.label,
              phase: input.phase,
              inbox,
              // Le modèle du rang (S-5 §3) : `--model` suit la cible jusqu'à l'argv.
              // Absent, la cible est celle d'avant cette feature, sans clé `model`.
              ...(target.model ? { model: target.model } : {}),
            },
            text,
          );
          if (reason === null) sent();
          return reason;
        }, input);
        return;
      }
      if (target.kind === "inbox") {
        const delivery: PanelDelivery =
          input.toolCallId === null
            ? { version: 1, kind: "text", text, sentAt: now() }
            : input.free
              ? { version: 1, kind: "ask", toolCallId: input.toolCallId, custom: text, sentAt: now() }
              : { version: 1, kind: "ask", toolCallId: input.toolCallId, selected: text, sentAt: now() };
        actView(
          async () => {
            try {
              writeDelivery(target.dir, delivery);
              sent();
              sentAsk();
              return null;
            } catch (err) {
              return `écriture impossible : ${err instanceof Error ? err.message : String(err)}`;
            }
          },
          input,
          input.toolCallId === null ? "message transmis au maillon" : "réponse transmise au maillon",
        );
        // La boîte surveillée retient à quel RANG elle appartient (VIEW-3) : un reste
        // non consommé revient au brouillon de ce rang, jamais à celui qu'on regarde.
        // Une feature de LOT est exclue : son pilote récupère la boîte lui-même.
        if (!(row !== undefined && isLotFeature(row))) watchedBoxes.set(target.dir, row !== undefined ? draftKey(row) : target.dir);
        return;
      }
      const actions = deps.lot;
      if (!actions) {
        showNotice("lot indisponible dans cette session");
        return;
      }
      actView(async () => {
        const reason = await actions.answer(target.slug, text);
        if (reason === null) sent();
        return reason;
      }, input);
    };

    /**
     * Une livraison depuis la VUE : le cycle de `act`, transposé à la zone de
     * saisie — succès ⇒ la zone se recalcule sur l'état frais (et, quand l'effet
     * n'est pas visible dans la liste, la notice d'accusé s'affiche), refus ⇒ la
     * zone est REPOSÉE telle quelle (tampon compris) PUIS la notice s'affiche.
     * L'ordre est imposé : `setZone` efface la notice.
     */
    const actView = (run: () => Promise<string | null>, keep: ViewZone, success?: string) => {
      const settle = (reason: string | null) => {
        if (reason === null) {
          // La question n'est plus en attente : le modèle est RELU, donc la zone
          // suit l'état frais (éditeur libre, ou lecture seule) au rendu suivant.
          notice = success ?? null;
          redraw();
          return;
        }
        setZone(keep);
        showNotice(reason);
      };
      void run()
        .then(settle)
        .catch((err: unknown) => settle(err instanceof Error ? err.message : String(err)));
    };

    /** La zone d'OPTIONS : `↑`/`↓`/`k`/`j` déplacent le curseur, sans sortir de la liste. */
    const moveCursor = (delta: number) => {
      if (view.kind !== "session" || view.zone.kind !== "input") return;
      const zone = view.zone;
      const count = zone.options.length + 1; // les options, plus « autre »
      // Déplacer le curseur RÉARME la fenêtre sur la fin de l'élément actif (S-4) :
      // ce qu'on vient de sélectionner reste à l'écran.
      setZone({ ...zone, cursor: clampSelection(zone.cursor + delta, count), scroll: WINDOW_FOLLOW });
    };

    /** Un clic sur une ligne d'option : la ligne « autre » passe en éditeur libre. */
    const chooseOption = (index: number) => {
      if (view.kind !== "session" || view.zone.kind !== "input" || view.zone.free) return;
      const zone = view.zone;
      if (index >= zone.options.length) {
        setZone({ ...zone, cursor: zone.options.length, free: true, scroll: WINDOW_FOLLOW });
        return;
      }
      setZone({ ...zone, cursor: index, scroll: WINDOW_FOLLOW });
      openReplyPreview();
    };

    /**
     * `ctrl+o` (S-4) : la bascule est GLOBALE, exactement comme chez l'hôte
     * (« Tool output expansion: enabled/disabled ») — toutes les cartes repliables
     * changent d'état d'un coup, y compris celles qui arriveront ensuite. L'état
     * courant s'applique aux composants déjà construits, et l'assemblage le garde
     * pour les suivants.
     */
    const toggleExpanded = () => {
      if (view.kind !== "session" || !view.transcript.assembly) return;
      const expanded = !view.transcript.assembly.expanded;
      applyExpanded(view.transcript.assembly, expanded);
      // Le défilement n'est PAS réinitialisé : déplier ne déplace pas la fenêtre.
      // Les comptes de lignes, eux, changent (les cartes ne font plus la même
      // hauteur) : ils sont remesurés au rendu suivant.
      view = { ...view, transcript: { ...view.transcript, counts: [], countsWidth: 0 } };
      version += 1;
      tui.requestRender?.();
    };

    /**
     * L'insertion dans un tampon (S-5) : la frappe d'un caractère, le RETOUR
     * ARRIÈRE, et le COLLAGE — un fragment de plus d'un caractère reçu d'un coup.
     * Les marqueurs d'encadrement du collage (`\x1b[200~`, `\x1b[201~`) et les
     * autres séquences d'échappement tombent, les `\r` internes deviennent des
     * sauts de ligne (un message peut être multi-ligne), les contrôles restants
     * une espace. La borne `LOT_EDITOR_MAX` s'applique à TOUTES les portes en
     * gardant le DÉBUT — on ne la dépasse jamais, et ce qui est écarté est DIT.
     */
    const insertInto = (data: string, buffer: string): { buffer: string; truncated: boolean } | null => {
      if (data === "\x7f" || data === "\b") return { buffer: buffer.slice(0, -1), truncated: false };
      if (data.length === 1) {
        return data >= " " && buffer.length < LOT_EDITOR_MAX ? { buffer: buffer + data, truncated: false } : null;
      }
      const pasted = data
        .replace(/\x1b\[20[01]~/g, "")
        .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "")
        .replace(/\x1b[\s\S]/g, "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ");
      if (pasted === "") return null;
      const room = Math.max(0, LOT_EDITOR_MAX - buffer.length);
      return { buffer: buffer + pasted.slice(0, room), truncated: pasted.length > room };
    };

    /**
     * Une insertion bornée dans la zone : la notice de troncature suit l'insertion,
     * et la fenêtre se réarme sur la FIN du tampon (S-2, S-4) — on voit ce qu'on
     * écrit, même après avoir remonté la fenêtre.
     */
    const insertInZone = (zone: ViewInputZone, data: string, next: Partial<ViewInputZone>): void => {
      const inserted = insertInto(data, zone.buffer);
      if (inserted === null) return;
      setZone({ ...zone, scroll: WINDOW_FOLLOW, ...next, buffer: inserted.buffer });
      if (inserted.truncated) showNotice(`message tronqué à ${LOT_EDITOR_MAX} caractères`);
    };

    /**
     * Les gestes du lot accessibles DEPUIS la vue (VIEW-15) : la raison de lecture
     * seule nomme `v`/`y`, et la ligne nomme `R`/`c`/`o` — les traiter ici évite de
     * sortir (Échap) puis de retrouver la ligne. L'aperçu est celui de la LISTE (le
     * même mode `confirm`), rendu PAR-DESSUS la transcription : la vue reste ouverte,
     * donc l'action se lit là où on a lu ce qu'on valide. Rend `true` quand la touche
     * est prise — JAMAIS quand la zone est ouverte, où ces caractères sont du texte.
     */
    const viewGesture = (data: string): boolean => {
      if (view.kind !== "session" || view.zone.kind !== "closed") return false;
      if (data === "o") {
        join();
        return true;
      }
      // Seules les touches de GESTE sont concernées : toute autre touche reste à la
      // vue (défilement, pliage, sortie).
      if (data !== "v" && data !== "y" && data !== "R" && data !== "c" && data !== "l" && data !== "L") return false;
      const row = rowForView();
      if (!row || !isLotFeature(row)) return false;
      const actions = deps.lot;
      if (!actions) return false;
      // Un lot piloté par un AUTRE process se consulte (PANEL-4) : ouvrir un aperçu
      // que le pilote refusera ferait confirmer un geste impossible.
      if (model.driver?.kind === "foreign") {
        showNotice(`lot piloté par pid ${model.driver.pid} — consultation seule`);
        return true;
      }
      const feature = row;
      if (cancelling.has(feature.slug)) {
        showNotice(`annulation en cours — ${feature.slug}`);
        return true;
      }
      // Un jalon confié à la session /audit ne se valide pas ici (S-3) : aucun
      // aperçu, aucun appel au pilote, le geste est consommé.
      if ((data === "v" || data === "y") && model.relayed[feature.slug] === true) {
        showNotice(AUDIT_RELAY_MILESTONE_REFUSAL);
        return true;
      }
      /** L'aperçu d'un geste : c'est lui que `Entrée` exécute, et `Échap` l'abandonne. */
      const preview = (gesture: PanelGesture): boolean => {
        setMode({ kind: "confirm", gesture, back: { kind: "browse" } });
        return true;
      };
      if (data === "v" && feature.state === "waiting" && feature.waitKind === "specs") {
        return preview({ kind: "validate", slug: feature.slug });
      }
      if (data === "y" && feature.state === "waiting" && feature.waitKind === "review") {
        return preview({ kind: "accept", slug: feature.slug });
      }
      if (data === "R" && (feature.state === "blocked" || feature.state === "failed")) {
        return preview({ kind: "relaunch", slug: feature.slug, phase: feature.phase });
      }
      // « L la lance » (la raison d'une feature en attente de ses dépendances) : la
      // touche de lancement du lot, telle que la liste la traite.
      if ((data === "l" || data === "L") && feature.state === "pending") {
        return preview({ kind: "launch" });
      }
      if (data === "c" && lotStateCancellable(feature.state)) {
        // Le devenir du worktree reste un premier pas (`1`/`2`/`3`), l'aperçu le suit.
        setMode({ kind: "cancel", slug: feature.slug });
        return true;
      }
      return false;
    };

    /**
     * Les touches de la VUE (S-2, S-3, S-4, S-6, S-8, S-10). L'aperçu est un état
     * à part — seuls `Entrée` et `Échap` y agissent, comme le mode `cancel` de la
     * liste. `ctrl+o` déplie/replie une entrée dans TOUS les états (ce n'est pas un
     * caractère imprimable : il ne vole rien à l'éditeur). Dans la zone d'options,
     * un caractère imprimable — ou un collage — passe en éditeur libre en
     * l'insérant ; `Échap` remonte de l'éditeur libre aux options s'il y en a, et
     * sort de la vue sinon. La transcription garde son ancrage et ses bornes.
     */
    const handleViewKey = (data: string): void => {
      if (view.kind !== "session") return;
      // `ctrl+o` d'abord, et dans TOUS les états : c'est une touche de contrôle, pas
      // un caractère imprimable — elle ne vole rien à la zone de saisie (S-4).
      if (isKey(data, "app.tools.expand") || data === EXPAND_KEY) {
        toggleExpanded();
        return;
      }
      // Les gestes du lot depuis la vue (VIEW-15) : la zone FERMÉE ne prend aucune
      // frappe, donc `v`/`y`/`o`/`R`/`c`/`l` y sont les touches du RANG, jamais du
      // texte — et une touche annoncée est une touche traitée.
      if (viewGesture(data)) return;
      const zone = view.zone;
      // La fenêtre de la TRANSCRIPTION, payée comme le rendu : les touches de
      // défilement s'y bornent, et la zone lui prend `PageUp`/`PageDown` quand elle
      // déborde (S-2, S-4).
      const page = viewRoom(panelHeight(tui));
      if (zone.kind === "preview") {
        if (isKey(data, "tui.select.cancel")) setZone(zone.input);
        else if (isKey(data, "tui.select.confirm")) deliver(zone);
        else if (isKey(data, "tui.select.pageUp")) scrollZone(-page);
        else if (isKey(data, "tui.select.pageDown")) scrollZone(page);
        return;
      }
      if (isKey(data, "tui.select.cancel")) {
        if (zone.kind === "input" && zone.free && zone.options.length > 0) {
          setZone({ ...zone, free: false });
          return;
        }
        // Sortir de la vue CONSERVE le brouillon (S-7) : `Échap` rend la liste, et
        // rouvrir le même rang restitue le tampon. Un tampon vide l'oublie.
        const row = rowForView();
        if (row) {
          if (zone.kind === "input" && zone.buffer !== "") drafts.set(draftKey(row), zone.buffer);
          else drafts.delete(draftKey(row));
        }
        // Quitter la vue LIBÈRE l'assemblage (VIEW-7) : une carte d'outil sans résultat
        // reste inscrite au ticker de l'hôte, et demanderait un repaint toutes les
        // 80 ms pour toute la vie du process — panneau fermé compris.
        disposeAssembly(view.transcript.assembly);
        view = { kind: "list" };
        version += 1;
        tui.requestRender?.();
        return;
      }
      if (zone.kind === "input") {
        if (!zone.free) {
          if (isKey(data, "tui.select.up") || data === "k") moveCursor(-1);
          else if (isKey(data, "tui.select.down") || data === "j") moveCursor(1);
          else if (isKey(data, "tui.select.confirm")) confirmZone();
          else if (isKey(data, "tui.select.pageUp")) {
            if (!scrollZone(-page)) scrollView(-page);
          } else if (isKey(data, "tui.select.pageDown")) {
            if (!scrollZone(page)) scrollView(page);
          } else if (/^[1-9]$/.test(data)) {
            // `1`..`9` SAUTENT au choix visé : l'aperçu ne s'ouvre que sur `Entrée`
            // ou sur un clic (S-11), et la fenêtre se réarme sur le choix (S-4).
            const index = Number(data) - 1;
            if (index < zone.options.length) setZone({ ...zone, cursor: index, scroll: WINDOW_FOLLOW });
          } else if (data === "a") {
            setZone({ ...zone, cursor: zone.options.length, free: true, scroll: WINDOW_FOLLOW });
          } else {
            // Une frappe — ou un collage — qui n'est pas un choix : elle vaut
            // réponse libre (S-11), et la fenêtre suit le tampon (S-4).
            insertInZone(zone, data, { free: true, cursor: zone.options.length, scroll: WINDOW_FOLLOW });
          }
          return;
        }
        // L'éditeur libre garde le défilement de la transcription : `↑`/`k` et
        // `↓`/`j` remontent le temps, Entrée confirme la réponse (S-11). Les
        // touches de S-6 qui ne sont PAS des caractères (séquences d'échappement :
        // maj+flèches, page haut/bas, début/fin) défilent même ici — elles ne
        // volent aucune frappe —, et `j`/`k` ne défilent que sur un tampon VIDE,
        // comme le lecteur de l'hôte : sinon ce sont des lettres qu'on écrit.
        // `PageUp`/`PageDown` défilent la ZONE quand elle dépasse sa fenêtre, et la
        // transcription sinon (S-2).
        if (isKey(data, "tui.select.confirm")) {
          confirmZone();
          return;
        }
        const fast = Math.min(FAST_SCROLL_LINES, page);
        if (isKey(data, "tui.select.up") || (data === "k" && zone.buffer === "")) {
          scrollView(-1);
          return;
        }
        if (isKey(data, "tui.select.down") || (data === "j" && zone.buffer === "")) {
          scrollView(1);
          return;
        }
        if (SHIFT_UP_KEYS.includes(data)) {
          scrollView(-fast);
          return;
        }
        if (SHIFT_DOWN_KEYS.includes(data)) {
          scrollView(fast);
          return;
        }
        if (isKey(data, "tui.select.pageUp")) {
          if (!scrollZone(-page)) scrollView(-page);
          return;
        }
        if (isKey(data, "tui.select.pageDown")) {
          if (!scrollZone(page)) scrollView(page);
          return;
        }
        if (HOME_KEYS.includes(data)) {
          scrollToTop();
          return;
        }
        if (END_KEYS.includes(data)) {
          scrollToBottom();
          return;
        }
        insertInZone(zone, data, {});
        return;
      }
      // La transcription : les touches de S-6, ancrées sur les RANGS RENDUS. Le
      // défilement rapide vaut 5 rangs, ou la fenêtre quand elle est plus courte.
      const fast = Math.min(FAST_SCROLL_LINES, page);
      if (isKey(data, "tui.select.up") || data === "k") scrollView(-1);
      else if (isKey(data, "tui.select.down") || data === "j") scrollView(1);
      else if (SHIFT_UP_KEYS.includes(data)) scrollView(-fast);
      else if (SHIFT_DOWN_KEYS.includes(data)) scrollView(fast);
      else if (isKey(data, "tui.select.pageUp")) scrollView(-page);
      else if (isKey(data, "tui.select.pageDown")) scrollView(page);
      else if (HOME_KEYS.includes(data) || data === "g") scrollToTop();
      else if (END_KEYS.includes(data) || data === "G") scrollToBottom();
    };

    /**
     * Un rapport de souris est toujours CONSOMMÉ (S-7) : ce n'est jamais du clavier.
     * Dans la liste, le clic gauche prend la ligne visée (`PanelRow.target`, posé par
     * le constructeur de rangs) et la molette vaut ±1 cran ; dans la vue, la molette
     * vaut 3 rangs (le facteur du lecteur plein écran de l'hôte), le clic prend
     * l'option visée, et le clic sur la mention de pliage bascule l'état GLOBAL. Le
     * survol, le relâchement et tout autre bouton ne font RIEN : aucun surlignage,
     * aucun repaint.
     */
    const handleMouse = (event: SgrMouseEvent): void => {
      if (view.kind === "session") {
        if (event.wheel !== null) {
          scrollView(event.wheel * WHEEL_SCROLL_LINES);
          return;
        }
        if (!event.leftClick) return;
        const choice = drawn[event.row]?.choice;
        if (choice === undefined) return;
        if (typeof choice === "number") chooseOption(choice);
        else toggleExpanded();
        return;
      }
      if (mode.kind !== "browse") return;
      if (event.wheel !== null) {
        move(event.wheel);
        return;
      }
      if (!event.leftClick) return;
      const target = drawn[event.row]?.target;
      // Cadre, titre, séparateur, marqueur, notice, pied, rang de remplissage : rien.
      if (target === undefined) return;
      notice = null;
      model = { ...model, notice: null, selection: target };
      remember();
      version += 1;
      tui.requestRender?.();
    };

    /** Le geste d'un aperçu, exécuté sur le pilote — `null` s'il n'y en a pas. */
    const gestureRun = (gesture: PanelGesture): (() => Promise<string | null>) | null => {
      const lot = deps.lot;
      if (!lot) return null;
      switch (gesture.kind) {
        case "launch":
          return () => lot.launch();
        case "remove":
          return () => lot.remove(gesture.slug);
        case "relaunch":
          return () => lot.relaunch(gesture.slug);
        case "validate":
          return () => lot.validate(gesture.slug);
        case "accept":
          return () => lot.accept(gesture.slug);
        case "cancel":
          return () => lot.cancel(gesture.slug, gesture.fate);
        case "add":
          return () => lot.add(gesture.input);
      }
    };

    /**
     * La fenêtre du CONTENU d'un mode de saisie (S-2) : `PageUp`/`PageDown` la
     * remontent jusqu'à sa PREMIÈRE ligne quand elle dépasse `LIST_MODE_MAX_LINES`,
     * et ne font rien sinon (le champ d'un ajout comme la tête d'un aperçu). La
     * mesure est celle du dernier rendu — même texte, même largeur.
     */
    const scrollMode = (delta: number) => {
      if (mode.kind === "browse") return;
      const innerW = Math.max(0, lastWidth - ROW_PADDING_X * 2);
      const parts = lotModeText(mode, model.lot ?? null, innerW, glyphs);
      if (parts === null) return;
      const lines = parts.content.length;
      const max = LIST_MODE_MAX_LINES(panelHeight(tui));
      if (lines <= max) return;
      const top = lines - max;
      const scroll = mode.scroll ?? { follow: true, offset: 0 };
      const current = scroll.follow ? top : Math.min(Math.max(scroll.offset, 0), top);
      const next = Math.min(Math.max(current + delta, 0), top);
      setMode({ ...mode, scroll: { follow: next >= top, offset: next } });
    };

    /**
     * Le champ PRÉCÉDENT d'un ajout (PANEL-12) : le tampon en cours est rangé dans son
     * étape, et celui de l'étape d'avant est RESTITUÉ — `Échap` ne perd plus la saisie.
     */
    const previousAddStep = (mode: Extract<LotPanelMode, { kind: "add" }>): LotPanelMode => {
      if (mode.step === "model") {
        // L'étape « Modèle » rend le champ des DÉPENDANCES avec son tampon (S-3) :
        // la liste capturée reste sur le mode, l'étape se rouvre à l'identique.
        return { kind: "add", step: "deps", draft: { ...mode.draft }, buffer: mode.draft.deps, choices: mode.choices };
      }
      if (mode.step === "deps") {
        return {
          kind: "add",
          step: "description",
          draft: { ...mode.draft, deps: mode.buffer },
          buffer: mode.draft.description,
          choices: mode.choices,
        };
      }
      return {
        kind: "add",
        step: "name",
        draft: { ...mode.draft, description: mode.buffer },
        buffer: mode.draft.name,
        choices: mode.choices,
      };
    };

    /** Les dépendances d'un tampon de champ : des slugs séparés par des virgules. */
    const parseDeps = (text: string): string[] =>
      text
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");

    /** Les modes de saisie et l'aperçu. Rend `true` quand la touche est consommée. */
    const handleMode = (data: string): boolean => {
      if (mode.kind === "browse") return false;
      if (isKey(data, "tui.select.cancel")) {
        // `Échap` dans un AJOUT rend le CHAMP PRÉCÉDENT avec son tampon (PANEL-12) :
        // remonter en consultation faisait perdre les champs déjà saisis.
        if (mode.kind === "add" && mode.step !== "name") {
          setMode(previousAddStep(mode));
          return true;
        }
        // `Échap` quitte l'aperçu en rendant l'état ANTÉRIEUR — le tampon d'un
        // ajout ou d'une réponse est conservé (S-7, S-8).
        setMode(mode.kind === "confirm" ? mode.back : { kind: "browse" });
        return true;
      }
      // `PageUp`/`PageDown` (S-2) : la fenêtre du contenu du mode courant, quand
      // elle déborde. Aucun mode n'utilise ces deux touches autrement.
      const windowPage = LIST_MODE_MAX_LINES(panelHeight(tui));
      if (isKey(data, "tui.select.pageUp")) {
        scrollMode(-windowPage);
        return true;
      }
      if (isKey(data, "tui.select.pageDown")) {
        scrollMode(windowPage);
        return true;
      }
      const lot = deps.lot;
      if (!lot) {
        showNotice("lot indisponible dans cette session");
        setMode({ kind: "browse" });
        return true;
      }
      const confirm = isKey(data, "tui.select.confirm");
      if (mode.kind === "confirm") {
        // L'APERÇU (S-8) : `Entrée` est la SEULE porte par où le geste part — et il
        // part une fois (l'aperçu se referme avant l'appel, une double frappe ne
        // déclenche pas deux actions).
        if (!confirm) return true;
        const run = gestureRun(mode.gesture);
        if (!run) {
          showNotice("lot indisponible dans cette session");
          return true;
        }
        const back = mode.back;
        const gesture = mode.gesture;
        setMode({ kind: "browse" });
        if (gesture.kind === "cancel") {
          // L'annulation est EN VOL tant que le pilote n'a pas rendu (PANEL-10) : la
          // ligne le dit, et un second `c` ne relance pas le geste.
          cancelling.add(gesture.slug);
          act(async () => {
            try {
              return await run();
            } finally {
              cancelling.delete(gesture.slug);
            }
          });
          showNotice(`annulation en cours — ${gesture.slug}`);
          return true;
        }
        // Un ajout refusé rouvre son champ : le motif s'affiche SANS faire retaper
        // les trois champs. Les autres gestes n'ont aucun état à reposer.
        act(run, back.kind === "add" ? back : undefined);
        return true;
      }
      if (mode.kind === "cancel") {
        const fate: WorktreeFate | null = data === "1" ? "keep" : data === "2" ? "archive" : data === "3" ? "delete" : null;
        if (!fate) return true; // toute autre touche est ignorée : 1, 2, 3 ou Échap
        // Le devenir choisi, puis l'aperçu qui dit ce qui va se passer (S-8).
        setMode({
          kind: "confirm",
          gesture: { kind: "cancel", slug: mode.slug, fate },
          back: mode,
        });
        return true;
      }
      // L'ÉTAPE « MODÈLE » (S-3) : une liste navigable et filtrable, clavier seul —
      // la souris n'est traitée par aucun mode. `Entrée` valide le choix AFFICHÉ et
      // ouvre l'aperçu ; `Échap` a déjà rendu le champ des dépendances, plus haut.
      if (mode.step === "model") {
        const shown = filterModelChoices(mode.choices ?? [], mode.query ?? "");
        const last = Math.max(0, shown.length - 1);
        const sel = Math.min(Math.max(mode.sel ?? 0, 0), last);
        // Déplacer le curseur ou filtrer RÉARME l'ancre (S-3) : la fenêtre suit la
        // ligne sélectionnée, et `PageUp`/`PageDown` ne la laissent pas hors champ.
        if (isKey(data, "tui.select.up") || data === "k") {
          setMode({ ...mode, sel: Math.max(0, sel - 1), scroll: undefined });
          return true;
        }
        if (isKey(data, "tui.select.down") || data === "j") {
          setMode({ ...mode, sel: Math.min(last, sel + 1), scroll: undefined });
          return true;
        }
        if (confirm) {
          const chosen = shown[sel] ?? DEFAULT_MODEL_CHOICE;
          const model = chosen.value === "" ? null : chosen.value;
          const input: AddFeatureInput = {
            name: mode.draft.name,
            description: mode.draft.description,
            deps: parseDeps(mode.draft.deps),
            ...(model !== null ? { model } : {}),
          };
          // Le choix n'écrit rien : il ouvre l'aperçu du geste, comme le dernier champ.
          setMode({ kind: "confirm", gesture: { kind: "add", input }, back: mode });
          return true;
        }
        const typed = insertInto(data, mode.query ?? "");
        if (typed !== null) {
          // Toute frappe imprimable est un FILTRE (jamais une touche de geste), et le
          // curseur repart sur la première ligne de la liste filtrée — ancre réarmée.
          setMode({ ...mode, query: typed.buffer, sel: 0, scroll: undefined });
          if (typed.truncated) showNotice(`message tronqué à ${LOT_EDITOR_MAX} caractères`);
        }
        return true;
      }
      if (confirm) {
        const draft = mode.draft;
        if (mode.step === "name") {
          if (mode.buffer.trim() === "") {
            showNotice("nom de feature requis");
            return true;
          }
          setMode({
            kind: "add",
            step: "description",
            draft: { ...draft, name: mode.buffer.trim() },
            buffer: "",
            choices: mode.choices,
          });
          return true;
        }
        if (mode.step === "description") {
          setMode({
            kind: "add",
            step: "deps",
            draft: { ...draft, description: mode.buffer.trim() },
            buffer: "",
            choices: mode.choices,
          });
          return true;
        }
        // Le champ des dépendances ouvre l'étape « Modèle » quand des modèles connus
        // existent (S-3), et l'aperçu sinon : sans modèle connu, le flux d'aujourd'hui.
        const withDeps = { ...draft, deps: mode.buffer };
        if ((mode.choices ?? []).length > 0) {
          setMode({ kind: "add", step: "model", draft: withDeps, buffer: "", choices: mode.choices, sel: 0, query: "" });
          return true;
        }
        const input: AddFeatureInput = {
          name: withDeps.name,
          description: withDeps.description,
          deps: parseDeps(withDeps.deps),
        };
        // Le dernier champ n'écrit rien : il ouvre l'aperçu du geste (S-8).
        setMode({ kind: "confirm", gesture: { kind: "add", input }, back: mode });
        return true;
      }
      const inserted = insertInto(data, mode.buffer);
      if (inserted !== null) {
        setMode({ ...mode, buffer: inserted.buffer });
        if (inserted.truncated) showNotice(`message tronqué à ${LOT_EDITOR_MAX} caractères`);
      }
      return true;
    };

    const handleBrowse = (data: string): void => {
      // Fermer : Échap (`app.interrupt`) ou Ctrl+C, les deux du select.cancel d'OMP.
      if (isKey(data, "tui.select.cancel")) {
        done();
        return;
      }
      if (isKey(data, "tui.select.up") || data === "k") {
        move(-1);
        return;
      }
      if (isKey(data, "tui.select.down") || data === "j") {
        move(1);
        return;
      }
      if (data === "d") {
        remove();
        return;
      }
      if (isKey(data, "tui.select.confirm")) {
        openView();
        return;
      }
      if (data === "o") {
        join();
        return;
      }
      const lot = deps.lot;
      // Toute action du lot exige le pilote : sans lui, le panneau reste en lecture.
      const requireLot = (): LotPanelActions | null => {
        if (!lot) {
          showNotice("lot indisponible dans cette session");
          return null;
        }
        // Un lot piloté par un AUTRE process se consulte (PANEL-4) : le pied n'annonce
        // déjà plus `a ajouter`/`l lancer`, et une touche qui reste ne doit pas ouvrir
        // un aperçu que le pilote refusera.
        if (model.driver?.kind === "foreign") {
          showNotice(`lot piloté par pid ${model.driver.pid} — consultation seule`);
          return null;
        }
        return lot;
      };
      /** Un geste qui change l'état du lot passe par son APERÇU — jamais direct (S-8). */
      const preview = (gesture: PanelGesture) => setMode({ kind: "confirm", gesture, back: { kind: "browse" } });
      if (data === "a") {
        const actions = requireLot();
        if (!actions) return;
        // La liste des modèles connus est capturée ICI, une fois (S-3) : l'étape
        // « Modèle » s'ouvre sur elle, et son absence (aucun modèle connu) laisse le
        // flux à trois champs d'aujourd'hui.
        setMode({
          kind: "add",
          step: "name",
          draft: { name: "", description: "", deps: "", model: null },
          buffer: "",
          choices: deps.modelChoices?.() ?? [],
        });
        return;
      }
      if (data === "l") {
        const actions = requireLot();
        if (actions) preview({ kind: "launch" });
        return;
      }
      if (data === "x") {
        const feature = selectedFeature();
        if (!feature) {
          showNotice("retrait possible sur une feature qui n'a pas démarré");
          return;
        }
        // Le refus arrive AVANT l'aperçu (PANEL-8c) : ouvrir « Retirer alpha du lot ? »
        // pour laisser le pilote refuser ensuite ferait confirmer un geste impossible.
        if (feature.state !== "pending") {
          showNotice(`« ${feature.slug} » a déjà démarré — c pour annuler`);
          return;
        }
        const actions = requireLot();
        if (actions) preview({ kind: "remove", slug: feature.slug });
        return;
      }
      if (data === "v") {
        const feature = selectedFeature();
        if (feature && model.relayed[feature.slug] === true) {
          showNotice(AUDIT_RELAY_MILESTONE_REFUSAL);
          return;
        }
        if (!feature || feature.state !== "waiting" || feature.waitKind !== "specs") {
          showNotice("rien à valider : la feature n'est pas au jalon des specs");
          return;
        }
        const actions = requireLot();
        if (actions) preview({ kind: "validate", slug: feature.slug });
        return;
      }
      if (data === "y") {
        const feature = selectedFeature();
        if (feature && model.relayed[feature.slug] === true) {
          showNotice(AUDIT_RELAY_MILESTONE_REFUSAL);
          return;
        }
        if (!feature || feature.state !== "waiting" || feature.waitKind !== "review") {
          showNotice("rien à accepter : la revue n'est pas propre");
          return;
        }
        const actions = requireLot();
        if (actions) preview({ kind: "accept", slug: feature.slug });
        return;
      }
      if (data === "R") {
        const feature = selectedFeature();
        if (!feature || (feature.state !== "blocked" && feature.state !== "failed")) {
          showNotice("relance possible sur une feature bloquée ou échouée");
          return;
        }
        const actions = requireLot();
        if (actions) preview({ kind: "relaunch", slug: feature.slug, phase: feature.phase });
        return;
      }
      if (data === "c") {
        const feature = selectedFeature();
        if (!feature) {
          showNotice("annulation impossible : sélectionne une feature du lot");
          return;
        }
        if (cancelling.has(feature.slug)) {
          showNotice(`annulation en cours — ${feature.slug}`);
          return;
        }
        // `c` accepte une feature bloquée ou échouée (PANEL-7) : `R` rouvre un crédit
        // de correction entier, ce n'est pas un abandon — le pied annonce donc `c`
        // dessus, et une touche annoncée doit être traitée.
        if (!lotStateCancellable(feature.state)) {
          // Le libellé par état vient du refus PARTAGÉ (`lotCancelRefusal`), jamais du
          // gabarit `la feature est ${lotStateLabel}` qui produisait « la feature est
          // terminé », « la feature est annulé ».
          showNotice(lotCancelRefusal(feature.state));
          return;
        }
        const actions = requireLot();
        // Le devenir du worktree reste un premier pas (`1`/`2`/`3`), l'aperçu le suit.
        if (actions) setMode({ kind: "cancel", slug: feature.slug });
        return;
      }
    };

    const stop = schedule(() => redraw(), PANEL_REFRESH_MS);

    /**
     * Les comptes de lignes par composant, à la largeur courante (S-8) : mesurés une
     * fois, ils servent la fenêtre — c'est ce qui évite de rendre les composants
     * qu'on ne voit pas. Un changement de largeur, un contenu neuf ou une bascule
     * les invalident (ils repartent de zéro).
     */
    const ensureCounts = (transcript: ViewTranscript, width: number): void => {
      const components = transcript.assembly?.components ?? [];
      if (transcript.countsWidth !== width || transcript.counts.length > components.length) {
        transcript.counts = [];
        transcript.countsWidth = width;
      }
      for (let i = transcript.counts.length; i < components.length; i += 1) {
        const component = components[i] as HostComponent;
        transcript.counts.push(renderComponent(component, componentLabel(component, i), width).length);
      }
    };

    /**
     * Les lignes de la FENÊTRE de la transcription (S-5, S-6) : le suivi de queue
     * garde les derniers rangs, une ancre garde ceux qu'on regardait — et seuls les
     * composants de la fenêtre sont rendus.
     */
    const windowLines = (width: number, room: number): string[] => {
      if (view.kind !== "session") return [];
      const transcript = view.transcript;
      const components = transcript.assembly?.components ?? [];
      ensureCounts(transcript, width);
      const total = transcriptRows();
      const max = Math.max(0, total - room);
      const start = transcript.followBottom
        ? max
        : Math.min(Math.max(transcript.offsetLines, 0), max);
      const lines: string[] = [];
      let at = 0;
      for (let i = 0; i < components.length && lines.length < room; i += 1) {
        const count = transcript.counts[i] ?? 0;
        if (at + count <= start) {
          at += count;
          continue;
        }
        const rendered = renderComponent(components[i] as HostComponent, componentLabel(components[i], i), width);
        for (let n = Math.max(0, start - at); n < rendered.length && lines.length < room; n += 1) {
          lines.push(rendered[n] as string);
        }
        at += count;
      }
      return lines;
    };

    /**
     * Un rang → le composant de l'hôte qui le rend (S-1) : `DynamicBorder` pour une
     * règle, `Text` pour tout le reste — colorié par le thème ACTIF, et fond
     * `selectedBg` pour le rang sélectionné (le même jeton que les listes d'OMP).
     */
    const rowComponent = (row: PanelRow): HostComponent => {
      if (row.rule) return new kit.DynamicBorder((text) => kit.theme.fg("border", text));
      const text = new kit.Text(
        row.text,
        ROW_PADDING_X,
        0,
        row.selected === true ? (value) => kit.theme.bg("selectedBg", value) : undefined,
      );
      text.setStyleFn((value) => kit.theme.fg(row.tone, value));
      return text;
    };

    /**
     * La composition d'un écran : ses lignes, et la CIBLE de chaque ligne (S-7) — le
     * clic résout sa cible par la ligne visée, jamais en la devinant.
     */
    type Composition = { lines: string[]; targets: (PanelRow | null)[] };

    /** Les lignes du panneau, composées par les composants de l'hôte (S-1). */
    const renderList = (current: PanelModel, width: number, height: number): Composition => {
      const rows = buildPanelRows(current, {
        width,
        budget: panelBudget(height),
        glyphs,
        now: now(),
        // Le pilote du lot : c'est lui qui fait vivre `a` et `l` au pied (S-7).
        canDrive: deps.lot !== undefined,
      });
      const children: HostComponent[] = [];
      const owner: (PanelRow | null)[] = [];
      let fillAt = -1;
      for (const row of rows) {
        if (row.fill) {
          fillAt = children.length;
          children.push(new kit.Spacer(0));
          owner.push(null);
          continue;
        }
        children.push(rowComponent(row));
        owner.push(row);
      }
      // Le remplissage se mesure sur ce que les composants rendent VRAIMENT (le
      // `Text` replie) : c'est la composition du conteneur, pas un calcul en amont.
      // Un composant qui jette compte le rang d'erreur qui le remplace.
      const counts: number[] = [];
      let used = 0;
      for (let i = 0; i < children.length; i += 1) {
        const count = renderComponent(children[i] as HostComponent, componentLabel(children[i], i), width).length;
        counts.push(count);
        used += count;
      }
      if (fillAt >= 0) {
        const fill = Math.max(0, height - used);
        (children[fillAt] as HostComponent & { setLines(lines: number): void }).setLines(fill);
        counts[fillAt] = fill;
      }
      const container = new kit.Container();
      for (const child of children) container.addChild(child);
      let lines: string[];
      try {
        lines = [...container.render(width)];
      } catch {
        // Un enfant a jeté DANS le conteneur : les rangs sont peints un par un, le
        // fautif remplacé par son rang d'erreur — le panneau reste ouvert, complet.
        lines = [];
        for (let i = 0; i < children.length; i += 1) {
          lines.push(...renderComponent(children[i] as HostComponent, componentLabel(children[i], i), width));
        }
      }
      const targets: (PanelRow | null)[] = [];
      for (let i = 0; i < children.length; i += 1) {
        for (let n = 0; n < (counts[i] ?? 0); n += 1) targets.push(owner[i] ?? null);
      }
      return { lines, targets };
    };

    /**
     * Les lignes de la VUE de session (S-3, S-4) : les deux règles du cadre, le
     * titre (le rang regardé, sa session, la mention de run vivant), la
     * transcription — rendue par les composants de l'hôte, fenêtrée —, la notice
     * (un refus prononcé ici doit être lisible ici), la ZONE DE SAISIE, fenêtrée
     * elle aussi, et le pied. Les états sont rendus EXPLICITEMENT, jamais déduits
     * d'une absence de lignes.
     */
    const renderView = (width: number, height: number): Composition => {
      if (view.kind !== "session") return { lines: [], targets: [] };
      const innerW = Math.max(0, width - ROW_PADDING_X * 2);
      const transcript = view.transcript;
      const title = [`${view.label} · /${view.phase} · ${view.state}`];
      if (transcript.sessionFile !== null) title.push(`session ${path.basename(transcript.sessionFile)}`);
      // Le titre dit le run VIVANT — jamais « lecture seule » (S-6) : une vue dont
      // la zone accepte une écriture ne peut pas s'annoncer en lecture seule, et le
      // mot n'a qu'un endroit, la zone FERMÉE (`readOnlyReason`).
      if (view.live) title.push("run en cours");
      const noticeRows = notice ? serviceRow(notice, "warning", innerW, undefined, PANEL_NOTICE_MAX_LINES) : [];
      // Un geste ouvert depuis la vue (VIEW-15) : c'est son APERÇU qui prend la place
      // de la zone — même texte, mêmes touches que dans la liste —, et son aide qui
      // prend la place du pied. La transcription reste visible derrière.
      const gesture = mode.kind === "browse" ? null : lotModeText(mode, model.lot ?? null, innerW, glyphs);
      // Les rangs de la zone : ceux de la SAISIE (options, éditeur, raison) — avec
      // l'ancre que `viewZoneRows` calcule sur l'élément ACTIF, jamais sur la fin —
      // ou, quand un geste est ouvert depuis la vue, son aperçu, déjà fenêtré.
      const gestureRows = gesture === null ? null : lotModeRows(mode, model.lot ?? null, innerW, height, glyphs);
      const zone =
        gestureRows === null
          ? viewZoneRows(view.zone, glyphs, innerW)
          : { rows: gestureRows, focus: gestureRows.length - 1 };
      // La zone est BORNÉE et défilante (S-2, S-4) : la fenêtre montre des lignes
      // consécutives, ancrée sur l'élément actif, et c'est SA hauteur que la
      // transcription paie (`viewFixed`, juste après). L'aperçu d'un geste, lui, est
      // déjà fenêtré par `lotModeRows` (même borne que la liste).
      const zoneWindow =
        gestureRows === null
          ? textWindow(zone.rows, VIEW_ZONE_MAX_LINES(height), zone.focus, zoneScrollOf(view.zone))
          : gestureRows;
      const state = bodyStateRow(innerW);
      const bodyRows: PanelRow[] = state;
      const head: PanelRow[] = [
        { text: "", tone: "border", rule: "frame" },
        ...serviceRow(title.join(" · "), "accent", innerW),
      ];
      const footer =
        gesture === null ? viewFooter(view.zone, zone.rows.length > zoneWindow.length) : (gesture.help.join(" · "));
      const tail: PanelRow[] = [
        ...noticeRows,
        ...zoneWindow,
        ...serviceRow(
          footer,
          "dim",
          innerW,
          footer.includes("ctrl+o déplier/replier") ? { choice: { kind: "expand" } } : undefined,
        ),
        { text: "", tone: "border", rule: "frame" },
      ];
      // Ce que la vue paie AVANT la transcription : le pied et les deux règles en
      // font partie, et le corps prend ce qui reste — au moins un rang (S-4).
      viewFixed = head.length + bodyRows.length + tail.length;
      const lines: string[] = [];
      const targets: (PanelRow | null)[] = [];
      const pushRow = (row: PanelRow): void => {
        let rendered: string[];
        try {
          rendered = [...rowComponent(row).render(width)];
        } catch (error) {
          // Construction ou rendu d'un rang du panneau : même garantie que pour
          // les composants de la vue (S-1 « Cas limites ») — un rang lisible.
          rendered = [unreadableLine("rang du panneau", error, width)];
        }
        for (const line of rendered) {
          lines.push(line);
          targets.push(row);
        }
      };
      for (const row of head) pushRow(row);
      for (const row of bodyRows) pushRow(row);
      // Le corps : les lignes des composants de la fenêtre, telles quelles — elles
      // portent leur propre mise en forme, et aucune n'est une cible de clic. Un état
      // dit (S-3) est peint EN TÊTE de la transcription, jamais à sa place : une
      // session dont le début a été élagué garde tout son contenu lisible.
      for (const line of windowLines(width, viewRoom(height))) {
        lines.push(line);
        targets.push(null);
      }
      for (const row of tail) pushRow(row);
      return { lines, targets };
    };

    return {
      render(width: number): string[] {
        lastWidth = width;
        const height = panelHeight(tui);
        // La mémoïsation (S-5) : rien n'a changé (contenu, largeur, hauteur,
        // pliage, zone) ⇒ le MÊME tableau, donc aucune repeinture.
        const key = `${version}|${width}|${height}`;
        if (key === renderedKey) return renderedLines;
        let composed: Composition;
        try {
          composed = view.kind === "session" ? renderView(width, height) : renderList(model, width, height);
        } catch (error) {
          // Dernier recours (S-1 « Cas limites ») : une composition qui jette quand
          // même (un constructeur de l'hôte, une mesure de largeur) laisse le
          // panneau OUVERT sur un rang lisible — jamais une sortie de l'overlay.
          composed = { lines: [unreadableLine("panneau", error, width)], targets: [] };
        }
        renderedKey = key;
        renderedLines = composed.lines;
        drawn = composed.targets;
        return renderedLines;
      },
      handleInput(data: string): void {
        // La souris d'abord : un rapport SGR n'est jamais du clavier (S-7). Puis la
        // VUE, avant les modes et la liste : aucune touche du panneau ne l'atteint.
        const mouse = parseSgrMouse(data);
        if (mouse) {
          handleMouse(mouse);
          return;
        }
        if (view.kind === "session") {
          // Un APERÇU de geste ouvert depuis la vue (VIEW-15) prend les touches :
          // c'est le même mode `confirm` que la liste, rendu par-dessus la
          // transcription, donc les mêmes touches l'exécutent et l'abandonnent.
          if (mode.kind !== "browse" && handleMode(data)) return;
          handleViewKey(data);
          return;
        }
        if (handleMode(data)) return;
        handleBrowse(data);
      },
      refresh: redraw,
      dispose(): void {
        stop();
        // Le panneau se ferme : l'assemblage de la vue ouverte est LIBÉRÉ (VIEW-7),
        // comme à Échap — c'est le dernier endroit où ses composants sont atteignables.
        if (view.kind === "session") disposeAssembly(view.transcript.assembly);
      },
    };
  };
}
