// Preuves de la feuille Contrat (S-4 … S-7) : les textes exacts, la relecture à
// chaque ouverture, les états d'absence, et la politique de feuille de la racine.
//
// La feuille ne se rend pas en test : la preuve est le CONTENU de la valeur
// (`ContractSheet.content`, sections complètes dans l'ordre des titres) et les
// textes rendus par `ContractText` — aucun test ne dépend d'un rendu SwiftUI.

import Foundation
import Testing

@testable import OMPConsole
@testable import ConsoleCore

// --- fixtures ----------------------------------------------------------------

/// Un worktree jetable portant un contrat réel sous `.omp/pipeline/`.
private final class ContractSheetFixture {
    let root: String

    init() {
        root = canonicalPath(
            (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-console-sheet-\(UUID().uuidString)")
        )
        try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(atPath: root)
    }

    /// Écrit (ou réécrit) le contrat de ce worktree, et rend son chemin.
    @discardableResult
    func writeContract(_ text: String) -> String {
        let directory = joinPath(root, ".omp/pipeline")
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let path = joinPath(directory, "contract.md")
        try? Data(text.utf8).write(to: URL(fileURLWithPath: path))
        return path
    }
}

/// Une carte littérale portant un moment de validation et un worktree réel.
private func sheetCard(
    phase: PipelinePhase = .req,
    waitKind: LotWaitKind? = .answer,
    state: LotFeatureState? = .waiting,
    worktree: String?
) -> KanbanCard {
    KanbanCard(
        id: "feature:cle:contrat", column: .jalonSpecs, repo: "depot", title: "contrat", state: "attend",
        phase: phase, models: nil, prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: [],
        action: KanbanCardAction(
            repoRoot: "/tmp/contract-display/depot",
            worktree: worktree,
            slug: "contrat",
            waitKind: waitKind,
            featureState: state,
            run: nil
        )
    )
}

/// Le contrat de référence : les quatre sections requises, plus la documentation.
private let sheetContract = """
## Besoins

B-1 : lire le contrat depuis la demande.

## Critères d'acceptation

AC-1 (B-1) : Given une carte, When j'ouvre, Then je lis.

## Documentation

La doc externe.

## Spécifications

S-1 : une feuille par moment.

## Lots

BR-1 — type: archi.
"""

// MARK: - AC-1 : les mots de la feuille et l'ouverture « besoins »

@Test("contract-display-omp-console/AC-1 : les mots de la feuille — geste, titre, sous-titre de besoin, fermeture")
func sheetWordsForBesoins() {
    #expect(ContractText.open == "Lire le contrat")
    #expect(ContractText.close == "Fermer")
    #expect(ContractText.title(slug: "contrat-display-omp-console") == "Contrat — contrat-display-omp-console")
    #expect(ContractText.subtitle(.besoins) == "À valider : Besoins et Critères d'acceptation.")
}

@MainActor
@Test("contract-display-omp-console/AC-1 : ouvrir depuis une carte en attente de réponse lit Besoins et Critères, dans l'ordre")
func openingBesoinsSheetReadsBothSections() throws {
    let fixture = ContractSheetFixture()
    let expectedPath = fixture.writeContract(sheetContract)
    let model = ContractModel()

    model.open(sheetCard(worktree: fixture.root))
    let sheet = try #require(model.sheet)
    #expect(sheet.slug == "contrat")
    #expect(sheet.moment == .besoins)
    #expect(sheet.path == joinPath(fixture.root, FilesModel.contractRelativePath))
    #expect(sheet.path == expectedPath)
    #expect(sheet.id == "contrat.besoins")

    guard case let .sections(sections) = sheet.content else {
        Issue.record("un contrat présent doit rendre des sections")
        return
    }
    #expect(sections.map(\.title) == ["Besoins", "Critères d'acceptation"])
    #expect(sections.allSatisfy { $0.text != nil })
    #expect(sections[0].text?.contains("B-1") == true)
    #expect(sections[1].text?.contains("AC-1 (B-1)") == true)

    // Une carte sans moment n'ouvre rien, ne lève rien, ne change aucun état.
    model.close()
    model.open(sheetCard(phase: .impl, waitKind: nil, state: .running, worktree: fixture.root))
    #expect(model.sheet == nil)
}

// MARK: - AC-2 : l'ouverture « specs »

@Test("contract-display-omp-console/AC-2 : le sous-titre des specs dit les deux sections à valider")
func sheetWordsForSpecs() {
    #expect(ContractText.subtitle(.specs) == "À valider : Spécifications et Lots.")
}

@MainActor
@Test("contract-display-omp-console/AC-2 : ouvrir depuis une carte en attente de specs lit Spécifications et Lots")
func openingSpecsSheetReadsBothSections() throws {
    let fixture = ContractSheetFixture()
    fixture.writeContract(sheetContract)
    let model = ContractModel()

    model.open(sheetCard(phase: .specs, waitKind: .specs, state: .waiting, worktree: fixture.root))
    let sheet = try #require(model.sheet)
    #expect(sheet.moment == .specs)
    #expect(sheet.id == "contrat.specs")
    guard case let .sections(sections) = sheet.content else {
        Issue.record("un contrat présent doit rendre des sections")
        return
    }
    #expect(sections.map(\.title) == ["Spécifications", "Lots"])
    #expect(sections[0].text?.contains("S-1") == true)
    #expect(sections[1].text?.contains("BR-1") == true)
    // `## Documentation` est hors périmètre : jamais lue ni montrée.
    #expect(!sections.contains { $0.title == "Documentation" })
}

// MARK: - AC-3 : chaque ouverture relit le fichier

@MainActor
@Test("contract-display-omp-console/AC-3 : deux ouvertures relisent le fichier — le contenu affiché est la version actuelle")
func eachOpeningRereadsTheFile() throws {
    let fixture = ContractSheetFixture()
    fixture.writeContract("## Besoins\n\npremier jet\n")
    let card = sheetCard(worktree: fixture.root)
    let model = ContractModel()

    model.open(card)
    let first = try #require(model.sheet)
    guard case let .sections(firstSections) = first.content else {
        Issue.record("un contrat présent doit rendre des sections")
        return
    }
    #expect(firstSections[0].text?.contains("premier jet") == true)

    model.close()
    #expect(model.sheet == nil)

    fixture.writeContract("## Besoins\n\nversion deux\n")
    model.open(card)
    let second = try #require(model.sheet)
    #expect(second != first)
    guard case let .sections(secondSections) = second.content else {
        Issue.record("un contrat présent doit rendre des sections")
        return
    }
    #expect(secondSections[0].text?.contains("version deux") == true)
    #expect(secondSections[0].text?.contains("premier jet") == false)
}

// MARK: - AC-4 : absence et illisibilité, dites en toutes lettres

@Test("contract-display-omp-console/AC-4 : les quatre messages d'absence et d'illisibilité, mot pour mot")
func absenceMessagesAreExact() {
    #expect(ContractText.missingFile
        == "Aucun contrat pour cette feature : le fichier `.omp/pipeline/contract.md` n'existe pas encore.")
    #expect(ContractText.notText(bytes: 12)
        == "Contrat illisible : le fichier n'est pas du texte UTF-8 (12 octets).")
    #expect(ContractText.unreadable(reason: "Permission denied")
        == "Contrat illisible : Permission denied")
    #expect(ContractText.sectionMissing(title: "Lots")
        == "La section `## Lots` est absente du contrat.")
}

@MainActor
@Test("contract-display-omp-console/AC-4 : contrat absent ⇒ la feuille le dit (`.missing`), jamais un état vide")
func missingContractIsNamed() throws {
    let fixture = ContractSheetFixture()  // aucun fichier écrit
    let model = ContractModel()

    model.open(sheetCard(worktree: fixture.root))
    let sheet = try #require(model.sheet)
    #expect(sheet.content == .missing)
    #expect(sheet.path == joinPath(fixture.root, FilesModel.contractRelativePath))

    // Un contrat binaire est dit « pas du texte », pas « absent ».
    let directory = joinPath(fixture.root, ".omp/pipeline")
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    try Data([0x41, 0x00, 0x42]).write(to: URL(fileURLWithPath: joinPath(directory, "contract.md")))
    model.close()
    model.open(sheetCard(worktree: fixture.root))
    #expect(model.sheet?.content == .unreadable(.notText(bytes: 3)))
}

@MainActor
@Test("contract-display-omp-console/AC-4 : une section absente d'un fichier présent garde sa place, les autres s'affichent")
func missingSectionKeepsItsPlace() throws {
    let fixture = ContractSheetFixture()
    fixture.writeContract("## Besoins\n\nB-1 : présent.\n")
    let model = ContractModel()

    model.open(sheetCard(worktree: fixture.root))
    let sheet = try #require(model.sheet)
    guard case let .sections(sections) = sheet.content else {
        Issue.record("un contrat présent doit rendre des sections")
        return
    }
    #expect(sections.map(\.title) == ["Besoins", "Critères d'acceptation"])
    #expect(sections[0].text?.contains("B-1 : présent.") == true)
    #expect(sections[1].text == nil)
    #expect(ContractText.sectionMissing(title: sections[1].title)
        == "La section `## Critères d'acceptation` est absente du contrat.")
}

// MARK: - S-7 : la politique de feuille de la racine

@Test("contract-display-omp-console/AC-1 : la politique présente la feuille Contrat et sa remise à nil la referme")
func policyPresentsAndClosesTheContract() {
    let available = OmpStatus.available(URL(fileURLWithPath: "/usr/local/bin/omp"))
    let missing = OmpStatus.missing
    let sheet = ContractSheet(slug: "contrat", moment: .besoins, path: "/w/.omp/pipeline/contract.md", content: .missing)
    func policy(omp: OmpStatus, contract: ContractSheet?) -> MainSheet? {
        MainSheetPolicy.sheet(
            omp: omp, setup: .ready, setupDismissed: false, board: .loading, welcomeSeen: true,
            welcomeRequested: true, launchFormShown: true, answerCardID: "carte", contract: contract
        )
    }
    // Le contrat rend `.contract(<valeur>)` — et passe avant bienvenue, nouvelle
    // feature et « Répondre ».
    #expect(policy(omp: available, contract: sheet) == .contract(sheet))
    #expect(policy(omp: available, contract: nil) == .welcome, "sans demande, la politique reprend son cours")
    // La préparation (composant OMP manquant) passe avant le contrat.
    #expect(policy(omp: missing, contract: sheet) == .setup)
}

@Test("contract-display-omp-console/AC-2 : la feuille Contrat a son identité propre — deux moments, deux feuilles")
func contractSheetIdentityFollowsSlugAndMoment() {
    let besoins = ContractSheet(slug: "contrat", moment: .besoins, path: "/w/contract.md", content: .missing)
    let specs = ContractSheet(slug: "contrat", moment: .specs, path: "/w/contract.md", content: .missing)
    #expect(besoins.id == "contrat.besoins")
    #expect(specs.id == "contrat.specs")
    #expect(MainSheet.contract(besoins).id == "contract.contrat.besoins")
    #expect(MainSheet.contract(besoins) != .contract(specs))
}
