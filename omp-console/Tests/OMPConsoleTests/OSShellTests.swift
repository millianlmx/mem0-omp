// La coque de l'« OS agentique » et « Comprendre », la logique pure (ConsoleUI/OS) : où
// « Comprendre » se présente selon la largeur de la fenêtre (le correctif du plantage des
// fenêtres étroites), ses trois vues, la porte lue dans la raison du serveur, le résumé en
// trois blocs, le routage sans bascule d'interface (sections classiques, liens, ⌘1…⌘5,
// palette), les outils, et la feuille « Nouveau fil… » (dépôts permis, titre tiré de la phrase).

import ConsoleClient
import ConsoleCore
@testable import ConsoleUI
import Foundation
import Testing

private func run(state: String, step: String? = nil, reason: String? = nil, verdict: HarnessVerdict? = nil) -> HarnessRun {
    HarnessRun(id: "r", repo: "demo", slug: "r", title: "Export", request: "Exporter", state: state, step: step, verdict: verdict, reason: reason)
}

private func verdict(_ summary: String, blockers: [String] = [], risks: [String] = [], unverified: [String] = []) -> HarnessVerdict {
    HarnessVerdict(risk: "low", summary: summary, blockers: blockers, risks: risks, files: [], unverified: unverified, confidence: "strong")
}

@Suite("Coque et Comprendre")
@MainActor
struct OSShellTests {
    // MARK: Inspecteur ou feuille

    @Test("sous 1 250 pt « Comprendre » est une feuille, au-delà un inspecteur", arguments: [
        (CGFloat(760), OSUnderstandPlacement.sheet), (900, .sheet), (1000, .sheet), (1100, .sheet), (1200, .sheet), (1249, .sheet),
        (1250, .inspector), (1300, .inspector), (1500, .inspector),
    ])
    func placementFollowsTheWidth(width: CGFloat, expected: OSUnderstandPlacement) {
        #expect(OSShellLayout.placement(width: width) == expected)
        #expect(OSShellLayout(width: width).placement == expected)
    }

    @Test("la barre latérale, le détail et le panneau tiennent dans toute fenêtre qui porte le panneau")
    func columnsAlwaysFit() {
        #expect(OSShellLayout.windowMin == OSShellLayout.sidebarMin + OSShellLayout.detailMin, "la fenêtre la plus étroite est la somme des colonnes")
        for width in stride(from: OSShellLayout.inspectorThreshold, through: 2600, by: 7) {
            let panel = OSShellLayout.inspectorWidth(width: width)
            #expect(panel >= OSShellLayout.inspectorNarrowest, "le panneau garde de quoi se lire (\(width))")
            #expect(panel <= OSShellLayout.inspectorWidest)
            // Le pire cas : la barre latérale au plus large ; le détail garde son minimum.
            #expect(OSShellLayout.sidebarMax + OSShellLayout.detailMin + panel <= width, "la somme déborde à \(width)")
        }
        #expect(OSShellLayout.inspectorWidth(width: 2600) == OSShellLayout.inspectorWidest)
        #expect(OSShellLayout.inspectorWidth(width: OSShellLayout.inspectorThreshold) >= OSShellLayout.inspectorNarrowest)
    }

    @Test("la disposition ne change qu'au franchissement d'un pas, pas à chaque point")
    func layoutChangesBySteps() {
        #expect(OSShellLayout(width: 1301) == OSShellLayout(width: 1309))
        #expect(OSShellLayout(width: 900) == OSShellLayout(width: 1100), "en feuille, la largeur du panneau ne compte pas")
        #expect(OSShellLayout(width: 1260) != OSShellLayout(width: 1400))
    }

    // MARK: Trois vues

    @Test("« Comprendre » a trois vues ; la variable de recette lit aussi les anciens noms")
    func threeLevels() {
        #expect(OSLevel.allCases == [.summary, .proofs, .journal])
        #expect(OSLevel(recipe: "summary") == .summary)
        #expect(OSLevel(recipe: "Résumé") == .summary)
        #expect(OSLevel(recipe: "Preuves") == .proofs)
        #expect(OSLevel(recipe: "journal") == .journal)
        for old in ["story", "raw", "Récit", "Brut"] { #expect(OSLevel(recipe: old) == .journal, "\(old)") }
        #expect(OSLevel(recipe: "ailleurs") == nil)
    }

    // MARK: La porte

    @Test("la revue à valider dit ses chiffres : lignes du changement et plafond, sous les deux gabarits du serveur")
    func gateReadsTheDiff() {
        let current = OSGate.causes(state: "awaiting_human", step: nil, reason: "validation humaine : diff de 412 lignes (> 300)")
        #expect(current == [.diff(lines: 412, limit: 300)])
        let older = OSGate.causes(state: "awaiting_human", step: nil, reason: "validation humaine : diff de 412 lignes au-delà de review.maxDiffLines (300)")
        #expect(older == [.diff(lines: 412, limit: 300)])
        #expect(OSGateCause.diff(lines: 412, limit: 300).text == OSText.gateDiff(lines: 412, limit: 300))
        #expect(OSGateCause.diff(lines: 412, limit: nil).text == OSText.gateDiff(lines: 412))
    }

    @Test("plusieurs motifs d'une revue se lisent chacun ; la suite d'une liste n'est pas un motif de plus")
    func gateReadsEveryReason() {
        let reason = "validation humaine : 2 bloquant(s) ; risque medium ; suite complète rouge ; critère(s) non vérifié(s) : AC-1 ; AC-2 ; verdict faible ; autonomie « tout me demander »"
        #expect(OSGate.causes(state: "awaiting_human", step: nil, reason: reason) == [
            .blockers(2), .risk("medium"), .testsRed, .criteriaUnverified, .weakVerdict, .askLevel,
        ])
        #expect(OSGate.causes(state: "awaiting_human", step: nil, reason: "validation humaine requise") == [.reviewRequired])
        #expect(OSGate.causes(state: "awaiting_human", step: nil, reason: "validation humaine : 1 escalade(s) ouverte(s) ; suite complète non lancée sur cet arbre") == [.openQuestions, .testsNotRun])
    }

    @Test("les specs à valider disent leur porte : première tâche d'un projet, geste irréversible, découpage")
    func gateReadsSpecs() {
        let reason = "specs à valider avant /impl : découpage proposé ; geste irréversible (schema, deletion) ; première feature d'un projet"
        #expect(OSGate.causes(state: "awaiting_human", step: "specs", reason: reason) == [.split, .irreversible(["schema", "deletion"]), .firstOfProject])
        #expect(OSGate.causes(state: "awaiting_human", step: "specs", reason: "specs à valider avant /impl") == [.specsAlways])
        #expect(OSGate.causes(state: "awaiting_human", step: "specs", reason: "specs à valider avant /impl : modules vides ; autonomie « tout me demander »") == [.noModules, .askLevel])
        #expect(OSGateCause.irreversible(["deletion"]).text == OSText.gateIrreversible(OSText.irreversibleDeletion))
        #expect(OSGateCause.irreversible(["inconnue"]).text == OSText.gateIrreversible("inconnue"), "une catégorie inconnue reste lisible")
    }

    @Test("budget, arbitrage, plafond de corrections et question ont leur phrase")
    func gateReadsTheOtherWaits() {
        #expect(OSGate.causes(state: "awaiting_human", step: "impl", reason: "budget dépassé : 5.21 $ pour un plafond de 5.00 $ — relance la feature pour continuer") == [.budget(spent: 5.21, ceiling: 5)])
        #expect(OSGate.causes(state: "awaiting_human", step: nil, reason: "plafond de corrections atteint (3) avec 2 bloquant(s)") == [.fixCap(fixes: 3, blockers: 2)])
        #expect(OSGate.causes(state: "awaiting_human", step: "fix", reason: "le correcteur conteste les bloquants une seconde fois : faux positif") == [.contest])
        #expect(OSGate.causes(state: "escalated", step: "impl", reason: nil) == [.question])
        #expect(OSGate.causes(state: "escalated", step: "specs", reason: "2 décision(s) irréversible(s) à trancher") == [.irreversibleDecisions(2)])
    }

    @Test("un motif inconnu reste lisible ; une panne garde le texte du serveur ; hors attente, aucune porte")
    func gateFallsBackReadably() {
        let unknown = OSGate.causes(state: "awaiting_human", step: nil, reason: "validation humaine : un motif tout neuf")
        #expect(unknown == [.other("un motif tout neuf")])
        #expect(unknown.first?.text == "Un motif tout neuf.")
        let failure = OSGate.causes(state: "awaiting_human", step: "impl", reason: "/impl a échoué 3 fois (timeout), relances épuisées : délai dépassé")
        #expect(failure == [.failure("/impl a échoué 3 fois (timeout), relances épuisées : délai dépassé")])
        #expect(failure.first?.text == OSText.gateFailure)
        #expect(failure.first?.detail == "/impl a échoué 3 fois (timeout), relances épuisées : délai dépassé")
        for state in ["running", "queued", "merged", "failed", "cancelled", "merging"] {
            #expect(OSGate.causes(state: state, step: "review", reason: "validation humaine : risque high").isEmpty, "\(state)")
        }
    }

    // MARK: Le résumé en trois blocs

    @Test("le résumé : la première phrase du verdict, la porte, puis bloquants, risques et non vérifié")
    func summaryHasThreeBlocks() {
        let summary = OSSummary(run: run(
            state: "awaiting_human", reason: "validation humaine : diff de 412 lignes (> 300)",
            verdict: verdict(
                "## Verdict\n\n**L'export CSV est en place.** Les 12 tests passent. Reste la v1.2 à documenter.",
                blockers: ["colonne date vide"], risks: ["encodage"], unverified: ["gros fichiers"]
            )
        ))
        #expect(summary.done == "L'export CSV est en place.", "le titre Markdown est passé, la mise en forme tombe")
        #expect(summary.why == [.diff(lines: 412, limit: 300)])
        #expect(summary.doubts == [
            OSDoubt(kind: .blocker, text: "colonne date vide"), OSDoubt(kind: .risk, text: "encodage"), OSDoubt(kind: .unverified, text: "gros fichiers"),
        ])
    }

    @Test("ce qui a été fait tient en UNE phrase, sans mise en forme, coupée sur un mot")
    func firstSentenceOnly() {
        #expect(OSSummary.firstSentence("**L'export CSV est en place.** Les 12 tests passent.") == "L'export CSV est en place.")
        #expect(OSSummary.firstSentence("- Passe la v1.2 en production. Rien d'autre.") == "Passe la v1.2 en production.")
        #expect(OSSummary.firstSentence("\n\n  Une seule ligne sans point") == "Une seule ligne sans point")
        #expect(OSSummary.firstSentence("# Verdict") == "Verdict", "un texte qui n'est qu'un titre rend ce titre")
        #expect(OSSummary.firstSentence("") == "")
        let long = OSSummary.firstSentence(String(repeating: "mot ", count: 120))
        #expect(long.count <= OSSummary.sentenceLimit + 1)
        #expect(long.hasSuffix("…"))
    }

    @Test("sans revue rendue : une phrase de l'app selon l'état, et aucun bloc de doutes")
    func summaryWithoutVerdict() {
        let specs = OSSummary(run: run(state: "awaiting_human", step: "specs", reason: "specs à valider avant /impl : première feature d'un projet"))
        #expect(specs.done == OSText.doneSpecs)
        #expect(specs.why == [.firstOfProject])
        #expect(specs.doubts == nil)
        #expect(OSSummary(run: run(state: "escalated")).done == OSText.doneQuestion)
        #expect(OSSummary(run: run(state: "running")).done == OSText.doneWorking)
        #expect(OSSummary(run: run(state: "failed")).done == OSText.doneNothing)
        let delivered = OSSummary(run: run(state: "merged", verdict: verdict("Le filtre est livré.")))
        #expect(delivered.done == "Le filtre est livré.")
        #expect(delivered.why.isEmpty, "un fil livré n'attend personne")
        #expect(delivered.doubts == [], "une revue sans réserve : le bloc dit « rien de signalé »")
    }

    // MARK: Une seule interface

    @Test("chaque section classique mène à un écran de la nouvelle interface")
    func classicSectionsRouteIntoTheNewShell() {
        #expect(OSRouter.route(section: .inbox) == .triage)
        #expect(OSRouter.route(section: .runs) == .screen(OSWorkspace.now))
        #expect(OSRouter.route(section: .runs, opensRun: true) == nil, "la coque ouvre le fil de la tâche demandée")
        #expect(OSRouter.route(section: .memory) == .screen(OSTool.memory.selection))
        #expect(OSRouter.route(section: .terminal) == .screen(OSTool.terminal.selection))
        #expect(OSRouter.route(section: .files) == .screen(OSTool.files.selection))
        #expect(OSRouter.route(section: .workstation) == .screen(OSTool.workstation.selection))
        #expect(OSRouter.route(section: .workstation, pendingAtPoste: true) == .triage, "un envoi à approuver s'ouvre au tri")
        // Aucune section n'est sans écran : rien n'oblige à changer d'interface.
        for section in ConsoleSection.allCases where section != .runs {
            #expect(OSRouter.route(section: section) != nil, "\(section)")
        }
    }

    @Test("les pages de Système : vigie et planifications aux Automatismes, paliers au Savoir, le reste en outil")
    func systemPagesRoute() {
        #expect(OSRouter.route(section: .system, page: .vigie) == .screen(OSWorkspace.automations))
        #expect(OSRouter.route(section: .system, page: .schedules) == .screen(OSWorkspace.automations))
        #expect(OSRouter.route(section: .system, page: .autonomy) == .screen(OSWorkspace.knowledge))
        #expect(OSRouter.route(section: .system, page: .stats) == .screen(OSTool.health.selection))
        #expect(OSRouter.route(section: .system, page: .admin) == .screen(OSTool.admin.selection))
        #expect(OSRouter.route(section: .system, page: .server) == .screen(OSTool.server.selection))
        #expect(OSRouter.route(section: .system) == .screen(OSTool.health.selection))
    }

    @Test("⌘1…⌘5 : Maintenant, À vous, Propositions, Automatismes, Savoir")
    func shortcutsOpenTheFiveScreens() {
        #expect(OSScreen.allCases.map(\.key) == ["1", "2", "3", "4", "5"])
        #expect(OSScreen.allCases.map(\.route) == [
            .screen(OSWorkspace.now), .triage, .screen(OSWorkspace.proposals), .screen(OSWorkspace.automations), .screen(OSWorkspace.knowledge),
        ])
        #expect(OSRouter.route(host: "now") == .screen(OSWorkspace.now))
        #expect(OSRouter.route(host: "decisions") == .triage)
        #expect(OSRouter.route(host: "memory") == nil, "un lien de section classique passe par la racine")
    }

    @Test("un écran que ce serveur ne sert pas, ou hors de portée du jeton, retombe sur « Maintenant »")
    func unreachableScreensFallBack() {
        let proposals = OSRoute.screen(OSWorkspace.proposals)
        #expect(OSRouter.resolve(proposals, proposalsServed: true, isAdmin: false) == proposals)
        #expect(OSRouter.resolve(proposals, proposalsServed: false, isAdmin: false) == .screen(OSWorkspace.now))
        let admin = OSRoute.screen(OSTool.admin.selection)
        #expect(OSRouter.resolve(admin, proposalsServed: true, isAdmin: true) == admin)
        #expect(OSRouter.resolve(admin, proposalsServed: true, isAdmin: false) == .screen(OSWorkspace.now))
        #expect(OSRouter.resolve(.triage, proposalsServed: false, isAdmin: false) == .triage)
    }

    @Test("les outils : sept écrans classiques, l'Administration pour un administrateur seulement ; leur sélection se relit")
    func tools() {
        #expect(OSTool.allCases == [.memory, .workstation, .health, .admin, .server, .terminal, .files])
        #expect(OSTool.available(isAdmin: true) == OSTool.allCases)
        #expect(OSTool.available(isAdmin: false) == [.memory, .workstation, .health, .server, .terminal, .files])
        for tool in OSTool.allCases {
            #expect(OSTool(selection: tool.selection) == tool)
            #expect(OSWorkspace.spaceId(of: tool.selection) == nil, "un outil n'est pas la page d'un espace")
        }
        #expect(OSTool(selection: OSWorkspace.now) == nil)
        #expect(OSTool(selection: "r:a") == nil)
        #expect(OSTool(selection: nil) == nil)
    }

    // MARK: Palette

    private let items = [
        HarnessPaletteItem(title: "Demande", symbol: "sparkles", command: .intake),
        HarnessPaletteItem(title: "Mémoire", symbol: "brain", command: .section(.memory)),
        HarnessPaletteItem(title: "Vigie", symbol: "binoculars", command: .system(.vigie)),
        HarnessPaletteItem(title: "Nouvelle feature…", symbol: "plus", command: .newFeature),
        HarnessPaletteItem(title: "Export CSV", symbol: "square.stack.3d.up", command: .run("r1")),
    ]
    private let screens = [
        ConsolePaletteScreen(id: "now", title: "Maintenant", symbol: "dot.radiowaves.left.and.right"),
        ConsolePaletteScreen(id: OSTool.memory.selection, title: "Mémoire", symbol: "brain"),
    ]

    @Test("dans la nouvelle interface, la palette propose ses écrans à la place des sections classiques")
    func paletteOffersTheShellScreens() {
        let rows = PaletteRow.rows(items: items, screens: screens, query: "", search: false)
        #expect(rows.map(\.title) == ["Demande", "Maintenant", "Mémoire", OSText.newThread, "Export CSV"])
        #expect(rows.contains(.item(items[1])) == false, "plus de commande vers une section classique")
        #expect(rows.contains(.item(items[2])) == false, "ni vers une page de Système")
        let typed = PaletteRow.rows(items: [items[4]], screens: screens, query: "mem", search: false)
        #expect(typed.map(\.title) == ["Mémoire", "Export CSV"], "l'écran que la saisie retient passe en tête")
        let searching = PaletteRow.rows(items: [items[4]], screens: screens, query: "mem", search: true)
        #expect(searching.map(\.title) == ["Export CSV"], "⌘F ne cherche que les fils et la mémoire")
    }

    @Test("sans écran de coque (interface classique, iPhone), la palette est celle d'avant")
    func paletteWithoutScreensIsUnchanged() {
        #expect(PaletteRow.rows(items: items, screens: [], query: "", search: false) == items.map(PaletteRow.item))
    }

    // MARK: Nouveau fil

    private let declared = [HarnessRepo(name: "demo"), HarnessRepo(name: "acme-web"), HarnessRepo(name: "acme-api")]

    @Test("sans espace, la feuille propose tous les dépôts et le premier ; avec, les siens et le préféré")
    func launchScope() {
        let everywhere = LaunchScope()
        #expect(everywhere.permitted(declared).map(\.name) == ["demo", "acme-web", "acme-api"])
        #expect(everywhere.repo(chosen: "", among: declared) == "demo")
        #expect(everywhere.repo(chosen: "acme-api", among: declared) == "acme-api")
        let acme = LaunchScope(repos: ["acme-api", "acme-web"], preferred: "acme-api")
        #expect(acme.permitted(declared).map(\.name) == ["acme-web", "acme-api"], "l'ordre du serveur")
        #expect(acme.repo(chosen: "", among: declared) == "acme-api", "le dépôt préféré")
        #expect(acme.repo(chosen: "demo", among: declared) == "acme-api", "un dépôt d'un autre espace n'est jamais gardé")
        #expect(acme.repo(chosen: "acme-web", among: declared) == "acme-web")
        #expect(LaunchScope(repos: ["acme-web"], preferred: "demo").repo(chosen: "", among: declared) == "acme-web", "un préféré hors de l'espace est ignoré")
        #expect(LaunchScope(repos: ["inconnu"]).repo(chosen: "demo", among: declared) == nil)
        #expect(everywhere.repo(chosen: "", among: []) == nil)
    }

    @Test("le titre d'un fil est la première ligne de sa phrase, coupée sur un mot")
    func launchTitle() {
        #expect(LaunchPhrase.title(of: "  Ajoute l'export CSV\n\navec les dates  ") == "Ajoute l'export CSV")
        #expect(LaunchPhrase.title(of: "") == "")
        let long = LaunchPhrase.title(of: String(repeating: "mot ", count: 60))
        #expect(long.count <= LaunchPhrase.titleLimit + 1)
        #expect(long.hasSuffix("…"))
        #expect(!long.contains("  "))
    }
}
