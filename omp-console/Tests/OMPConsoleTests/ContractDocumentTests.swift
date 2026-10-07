// Preuves du socle de la feuille Contrat (S-1 … S-4) : le moment de validation
// d'une carte, le découpage VERBATIM par section, le chemin depuis le worktree et
// la lecture du fichier.
//
// Aucune vue n'est rendue : tout passe par des fonctions pures, plus de VRAIS
// fichiers sous `NSTemporaryDirectory()` (absent, binaire, vide, interdit) — une
// doublure ne prouverait pas la traduction de `FilesReader`.

import Foundation
import Testing

@testable import OMPConsole
@testable import ConsoleCore

// --- fixtures ----------------------------------------------------------------

/// Un répertoire jetable de contrats, sous `NSTemporaryDirectory()`.
private final class ContractFixture {
    let root: String

    init() {
        root = canonicalPath(
            (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-console-contract-\(UUID().uuidString)")
        )
        try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(atPath: root)
    }

    @discardableResult
    func write(_ name: String, _ contents: String) -> String {
        let path = joinPath(root, name)
        try? Data(contents.utf8).write(to: URL(fileURLWithPath: path))
        return path
    }

    @discardableResult
    func writeBytes(_ name: String, _ bytes: [UInt8]) -> String {
        let path = joinPath(root, name)
        try? Data(bytes).write(to: URL(fileURLWithPath: path))
        return path
    }
}

/// Une carte littérale : seul ce que S-1 regarde (le maillon, l'action).
private func contractCard(
    id: String = "feature:cle:contrat",
    phase: PipelinePhase? = .req,
    action: KanbanCardAction? = nil
) -> KanbanCard {
    KanbanCard(
        id: id, column: .jalonSpecs, repo: "depot", title: "contrat", state: "attend",
        phase: phase, models: nil, prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: [],
        action: action
    )
}

/// L'action d'une feature de lot, worktree compris (`nil` = worktree vide).
private func contractAction(
    slug: String? = "contrat",
    waitKind: LotWaitKind? = nil,
    state: LotFeatureState? = nil,
    pendingAsk: PanelPendingAsk? = nil,
    worktree: String? = "/tmp/contract-display/arbre"
) -> KanbanCardAction {
    KanbanCardAction(
        repoRoot: "/tmp/contract-display/depot",
        worktree: worktree,
        slug: slug,
        waitKind: waitKind,
        featureState: state,
        run: pendingAsk.map {
            KanbanCardRun(id: "run-1", label: "depot/contrat", inbox: "/box", pendingAsk: $0)
        }
    )
}

/// Le contrat de référence : deux fois `## Spécifications` et `## Lots` (la
/// dernière occurrence fait foi), un `### …` interne, et `## Lots` cité dans un
/// paragraphe de `## Documentation`.
private let sampleContract = """
# Contrat

## Besoins

B-1 : afficher le contrat.

## Critères d'acceptation

AC-1 (B-1) : Given un contrat, When je l'ouvre, Then je le lis.

## Documentation

La chaîne `## Lots` citée dans un paragraphe ne compte pas.

## Spécifications

S-1 : premier jet.

## Lots

BR-1 — type: archi — premier jet.

## Spécifications

S-1 : version deux.
### Détail interne

S-2 : suite.

## Lots

BR-2 — type: ui.

## Revue

RAS.
"""

// MARK: - AC-1 : le moment « besoins » et les sections de req

@Test("contract-display-omp-console/AC-1 : le moment « besoins » — collecte req en vol, feature en attente de réponse, et les cas sans moment")
func besoinsMomentAndTheNilCases() {
    // 1. Une feature en attente de réponse, maillon req ⇒ besoins.
    #expect(ContractDocument.moment(for: contractCard(
        phase: .req, action: contractAction(waitKind: .answer, state: .waiting)
    )) == .besoins)
    // 2. Une collecte req dont la question `ask` est EN VOL ⇒ besoins.
    let ask = PanelPendingAsk(toolCallId: "call-1", id: "q", question: "On garde ?", options: [])
    #expect(ContractDocument.moment(for: contractCard(
        phase: .req, action: contractAction(state: .running, pendingAsk: ask)
    )) == .besoins)
    // 3. Une feature en attente de specs ⇒ specs.
    #expect(ContractDocument.moment(for: contractCard(
        phase: .specs, action: contractAction(waitKind: .specs, state: .waiting)
    )) == .specs)
    // 4. Une attente de réponse hors maillon req ⇒ aucun moment.
    #expect(ContractDocument.moment(for: contractCard(
        phase: .impl, action: contractAction(waitKind: .answer, state: .waiting)
    )) == nil)
    // 5. Une attente de revue ⇒ jamais un moment.
    #expect(ContractDocument.moment(for: contractCard(
        phase: .review, action: contractAction(waitKind: .review, state: .waiting)
    )) == nil)
    // 6. Une feature `pending` n'a pas de worktree ⇒ aucun moment, ni en chaîne vide.
    #expect(ContractDocument.moment(for: contractCard(
        phase: .req, action: contractAction(state: .pending, worktree: nil)
    )) == nil)
    #expect(ContractDocument.moment(for: contractCard(
        phase: .req, action: contractAction(state: .pending, worktree: "")
    )) == nil)
    // Une carte sans action n'a jamais de moment.
    #expect(ContractDocument.moment(for: contractCard(action: nil)) == nil)
    // La liste ET l'ordre d'affichage du moment « besoins ».
    #expect(ContractDocument.titles(for: .besoins) == ["Besoins", "Critères d'acceptation"])
}

@Test("contract-display-omp-console/AC-1 : les sections « Besoins » et « Critères d'acceptation » se lisent verbatim")
func besoinsSectionsAreVerbatim() {
    let besoins = ContractDocument.section(in: sampleContract, title: "Besoins")
    #expect(besoins.title == "Besoins")
    // De la ligne du titre INCLUSE à la ligne qui précède le titre suivant — la
    // ligne vide qui précède ce titre en fait partie.
    #expect(besoins.text == "## Besoins\n\nB-1 : afficher le contrat.\n\n")

    let criteria = ContractDocument.section(in: sampleContract, title: "Critères d'acceptation")
    #expect(criteria.text == "## Critères d'acceptation\n\nAC-1 (B-1) : Given un contrat, When je l'ouvre, Then je le lis.\n\n")

    // `## Lots` cité DANS un paragraphe ne coupe pas la section qui le cite.
    let documentation = ContractDocument.section(in: sampleContract, title: "Documentation")
    #expect(documentation.text == "## Documentation\n\nLa chaîne `## Lots` citée dans un paragraphe ne compte pas.\n\n")

    // Titre absent, fichier vide ⇒ `nil`, jamais un texte deviné.
    #expect(ContractDocument.section(in: sampleContract, title: "Absente").text == nil)
    #expect(ContractDocument.section(in: "", title: "Besoins").text == nil)

    // Les espaces de bord du titre sont tolérés ; le texte reste VERBATIM.
    #expect(ContractDocument.section(in: "  ## Besoins  \ncorps", title: "Besoins").text == "  ## Besoins  \ncorps")
}

@Test("contract-display-omp-console/AC-1 : la lecture rend Besoins et Critères d'acceptation en entier, titre compris")
func readingRendersBesoinsAndCriteria() {
    let fixture = ContractFixture()
    #expect(ContractDocument.path(worktree: "/w/arbre") == "/w/arbre/.omp/pipeline/contract.md")

    let path = fixture.write("contract.md", sampleContract)
    guard case let .sections(sections) = ContractDocument.read(path: path, moment: .besoins, fileManager: .default)
    else {
        Issue.record("un contrat textuel doit rendre des sections")
        return
    }
    #expect(sections.map(\.title) == ["Besoins", "Critères d'acceptation"])
    #expect(sections[0].text == "## Besoins\n\nB-1 : afficher le contrat.\n\n")
    #expect(sections[1].text?.contains("Then je le lis.") == true)
    // Rien n'est rogné : la section va jusqu'au caractère qui précède le titre suivant.
    #expect(sections[0].text?.hasSuffix("\n\n") == true)

    // Fichier vide ⇒ une entrée par titre requis, texte `nil` — jamais un vide muet.
    let empty = fixture.write("vide.md", "")
    #expect(ContractDocument.read(path: empty, moment: .besoins, fileManager: .default) == .sections([
        ContractSection(title: "Besoins", text: nil),
        ContractSection(title: "Critères d'acceptation", text: nil),
    ]))

    // Aucune borne de taille : plus de 100 000 caractères sont rendus en entier.
    let big = "## Besoins\n\n" + String(repeating: "x", count: 120_000) + "\n"
    let bigPath = fixture.write("gros.md", big)
    guard case let .sections(bigSections) = ContractDocument.read(path: bigPath, moment: .besoins, fileManager: .default)
    else {
        Issue.record("un gros contrat textuel doit rendre des sections")
        return
    }
    #expect(bigSections[0].text == big)
    #expect(bigSections[1].text == nil)
}

// MARK: - AC-2 : le moment « specs » et ses sections

@Test("contract-display-omp-console/AC-2 : le moment « specs » — feature en attente de validation, jamais une revue")
func specsMomentAndReviewIsNeverOne() {
    #expect(ContractDocument.moment(for: contractCard(
        phase: .specs, action: contractAction(waitKind: .specs, state: .waiting)
    )) == .specs)
    #expect(ContractDocument.moment(for: contractCard(
        phase: .review, action: contractAction(waitKind: .review, state: .waiting)
    )) == nil)
    #expect(ContractDocument.titles(for: .specs) == ["Spécifications", "Lots"])
}

@Test("contract-display-omp-console/AC-2 : les sections « Spécifications » et « Lots » se lisent verbatim, la dernière occurrence faisant foi")
func specsSectionsAreVerbatim() {
    let specs = ContractDocument.section(in: sampleContract, title: "Spécifications")
    // La DERNIÈRE occurrence, jusqu'à la ligne qui précède `## Lots` — un `### …`
    // interne ne coupe pas.
    #expect(specs.text == "## Spécifications\n\nS-1 : version deux.\n### Détail interne\n\nS-2 : suite.\n\n")

    let lots = ContractDocument.section(in: sampleContract, title: "Lots")
    #expect(lots.text == "## Lots\n\nBR-2 — type: ui.\n\n")

    // Un titre qui n'est pas une ligne entière ne compte pas (`## Spécification`
    // sans « s » ne matche pas « ## Spécifications »).
    #expect(ContractDocument.section(in: sampleContract, title: "Spécification").text == nil)
}

@Test("contract-display-omp-console/AC-2 : la lecture rend Spécifications et Lots en entier")
func readingRendersSpecsAndLots() {
    let fixture = ContractFixture()
    let path = fixture.write("contract.md", sampleContract)
    guard case let .sections(sections) = ContractDocument.read(path: path, moment: .specs, fileManager: .default)
    else {
        Issue.record("un contrat textuel doit rendre des sections")
        return
    }
    #expect(sections.map(\.title) == ["Spécifications", "Lots"])
    #expect(sections[0].text == "## Spécifications\n\nS-1 : version deux.\n### Détail interne\n\nS-2 : suite.\n\n")
    #expect(sections[1].text == "## Lots\n\nBR-2 — type: ui.\n\n")
}

// MARK: - AC-3 : chaque lecture relit le fichier

@Test("contract-display-omp-console/AC-3 : chaque lecture relit le fichier — un contrat modifié se lit à jour")
func readingAlwaysRereadsTheFile() {
    let fixture = ContractFixture()
    let path = fixture.write("contract.md", "## Besoins\n\npremier jet\n")
    guard case let .sections(first) = ContractDocument.read(path: path, moment: .besoins, fileManager: .default)
    else {
        Issue.record("un contrat textuel doit rendre des sections")
        return
    }
    #expect(first[0].text?.contains("premier jet") == true)

    fixture.write("contract.md", "## Besoins\n\nversion deux\n")
    guard case let .sections(second) = ContractDocument.read(path: path, moment: .besoins, fileManager: .default)
    else {
        Issue.record("un contrat textuel doit rendre des sections")
        return
    }
    #expect(second[0].text?.contains("version deux") == true)
    #expect(second != first, "une relecture rend le contenu courant, jamais un cache")
}

// MARK: - AC-4 : absence et illisibilité

@Test("contract-display-omp-console/AC-4 : contrat absent, binaire, illisible ou répertoire — jamais un contenu vide")
func absentBinaryAndUnreadableAreNamed() throws {
    let fixture = ContractFixture()

    // Absent.
    let absent = joinPath(fixture.root, "jamais-ecrit.md")
    #expect(ContractDocument.read(path: absent, moment: .besoins, fileManager: .default) == .missing)

    // Un répertoire ⇒ `missing` (règle de `FilesReader`).
    let directory = joinPath(fixture.root, "dossier.md")
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    #expect(ContractDocument.read(path: directory, moment: .besoins, fileManager: .default) == .missing)

    // Non textuel : NUL d'abord, UTF-8 invalide ensuite.
    let withNul = fixture.writeBytes("binaire.md", [0x41, 0x00, 0x42])
    #expect(ContractDocument.read(path: withNul, moment: .besoins, fileManager: .default)
        == .unreadable(.notText(bytes: 3)))
    let invalid = fixture.writeBytes("latin1.md", [0xE9, 0xE8])
    #expect(ContractDocument.read(path: invalid, moment: .specs, fileManager: .default)
        == .unreadable(.notText(bytes: 2)))

    // Erreur système : le message du système est conservé, jamais avalé.
    let forbidden = fixture.write("interdit.md", "## Besoins\n")
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: forbidden)
    let content = ContractDocument.read(path: forbidden, moment: .besoins, fileManager: .default)
    if case let .unreadable(.error(reason)) = content {
        #expect(!reason.isEmpty)
    } else {
        Issue.record("un fichier sans droits de lecture doit être « illisible », pas \(content)")
    }
}

// MARK: - Le worktree porté par la carte (S-3, BR-1)

@Test("contract-display-omp-console/AC-1 : une carte de lot porte le worktree de sa feature, une feature sans worktree n'en porte pas")
func lotCardsCarryTheirWorktree() {
    let fixture = StoreFixture()
    let repoRoot = "/tmp/contract-display/depot"
    let repoKey = KanbanRepoKey.key(forRoot: repoRoot)
    fixture.publish(.lots, "\(repoKey).json", object: lotObject(
        id: repoKey, repoRoot: repoRoot,
        features: [
            lotFeatureObject(slug: "lancee", worktree: "/tmp/contract-display/arbre"),
            lotFeatureObject(slug: "a-venir", state: "pending", phase: "req", worktree: ""),
        ]
    ))
    fixture.publish(.projects, "\(repoKey).json", object: projectObject(
        repoKey: repoKey, repoRoot: repoRoot,
        segments: [["name": "S", "features": [projectFeatureObject(slug: "projet-seul")]]],
        current: 0
    ))

    let board = kanbanBoard(fixture)
    let launched = board.cards.first { $0.title == "lancee" }
    #expect(launched?.action?.worktree == "/tmp/contract-display/arbre")
    // Le chemin du contrat dérive de ce worktree, jamais d'un second littéral.
    if let worktree = launched?.action?.worktree {
        #expect(ContractDocument.path(worktree: worktree) == "/tmp/contract-display/arbre/.omp/pipeline/contract.md")
    }
    // `pending` (worktree `""`) et carte de projet seule : aucun worktree.
    #expect(board.cards.first { $0.title == "a-venir" }?.action?.worktree == nil)
    #expect(board.cards.first { $0.title == "projet-seul" }?.action?.worktree == nil)
}
