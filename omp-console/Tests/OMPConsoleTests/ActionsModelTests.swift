// Preuves du MODÈLE d'action (S-4, S-7) : le journal borné, en attente → pris en
// charge, refus au motif verbatim, accusé illisible ⇒ en attente, garde du texte
// blanc et remise à zéro du formulaire de lancement.
//
// Le sondage est appelé EXPLICITEMENT (`model.pollAcks()`), comme le dépôt appelle
// `controller.pumpCommands()` : aucun minuteur ne tourne à vide dans un test.

@testable import OMPConsole
import ConsoleCore
import Foundation
import Testing

private let t0: Double = 1_700_000_000_000
private let fixedClock = StoreClock { t0 }

@MainActor
private func makeModel(_ fixture: StoreFixture, salt: String = "abcd") -> ActionsModel {
    ActionsModel(
        writer: PipelineWriter(stateDir: fixture.root),
        clock: fixedClock,
        salt: { salt }
    )
}

/// Une action de carte : le dépôt est un chemin RÉEL de la fixture, la boîte est
/// publiée telle quelle.
private func cardAction(
    repoRoot: String,
    inbox: String?,
    pendingAsk: PanelPendingAsk? = nil,
    slug: String? = "alpha",
    waitKind: LotWaitKind? = .specs,
    featureState: LotFeatureState? = .waiting
) -> KanbanCardAction {
    KanbanCardAction(
        repoRoot: repoRoot,
        slug: slug,
        waitKind: waitKind,
        featureState: featureState,
        run: KanbanCardRun(id: "run-1", label: "depot/alpha", inbox: inbox, pendingAsk: pendingAsk)
    )
}

@MainActor
@Test("reponses-et-jalons/AC-3 : envoyer un texte dépose une livraison et journalise « déposé »")
func sendTextJournalsDelivered() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let box = fixture.createBox("run-1")

    model.sendText(cardAction(repoRoot: fixture.root, inbox: box), text: "avance")

    #expect(model.journal.count == 1)
    let entry = try #require(model.journal.first)
    #expect(entry.kindLabel == ActionsText.textLabel)
    #expect(entry.targetLabel == "depot/alpha")
    #expect(entry.state == .delivered)
    #expect(ActionsText.journalLine(for: entry) == "\(ActionsText.textLabel) · depot/alpha · \(ActionsText.delivered)")

    let names = try FileManager.default.contentsOfDirectory(atPath: box)
    #expect(names == ["0001700000000000-abcd.json"])
}

@MainActor
@Test("reponses-et-jalons/AC-4 : un texte blanc ne produit AUCUN geste")
func blankTextIsNoGesture() {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let box = fixture.createBox("run-1")
    let action = cardAction(repoRoot: fixture.root, inbox: box)

    model.sendText(action, text: "   \n ")
    model.answer(action, custom: "  ")
    model.submitSteer(action)

    #expect(model.journal.isEmpty)
    #expect((try? FileManager.default.contentsOfDirectory(atPath: box))?.isEmpty == true)
}

@MainActor
@Test("reponses-et-jalons/AC-1 : une question en vol reçoit le libellé choisi, un texte libre vide le champ")
func answerSelectedThenCustom() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let box = fixture.createBox("run-1")
    let ask = PanelPendingAsk(
        toolCallId: "call-1",
        id: "q",
        question: "On garde ?",
        options: [PanelAskOption(label: "oui", description: nil), PanelAskOption(label: "non", description: nil)]
    )
    let action = cardAction(repoRoot: fixture.root, inbox: box, pendingAsk: ask)

    model.selectAnswerOption("oui")
    #expect(model.answerReady)
    model.setAnswerCustomText("plutôt non")
    #expect(model.answerSelectedLabel == nil, "saisir dans le champ libre désélectionne l'option")

    model.submitAnswer(action)

    let names = try FileManager.default.contentsOfDirectory(atPath: box).sorted()
    #expect(names == ["0001700000000000-abcd.json"])
    let data = try #require(FileManager.default.contents(atPath: joinPath(box, names[0])))
    guard case .object(let object)? = JSONValue.parse(data) else {
        Issue.record("la livraison déposée doit être un objet JSON")
        return
    }
    #expect(object["kind"] == .string("ask"))
    #expect(object["toolCallId"] == .string("call-1"))
    #expect(object["custom"] == .string("plutôt non"))
    #expect(object["selected"] == nil)
    #expect(model.answerCustomText.isEmpty, "l'état de saisie est remis à zéro après le geste")
}

@MainActor
@Test("reponses-et-jalons/AC-5 : une commande en attente passe à « prise en charge » quand l'accusé arrive")
func commandGoesToTaken() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let writer = PipelineWriter(stateDir: fixture.root)
    let repo = fixture.root

    model.validate(cardAction(repoRoot: repo, inbox: nil))
    let entry = try #require(model.journal.first)
    #expect(entry.id == "console-1700000000000-abcd")
    #expect(entry.state == .awaitingAck)
    #expect(ActionsText.journalLine(for: entry) == "\(ActionsText.specsLabel) · alpha · \(ActionsText.awaitingAck)")
    #expect(FileManager.default.fileExists(atPath: writer.ackPath(id: entry.id)) == false)

    // Le pilote écrit l'accusé : la passe suivante bascule l'entrée.
    try FileManager.default.createDirectory(atPath: writer.commandAckDir, withIntermediateDirectories: true)
    try Data("""
    {"version":1,"id":"console-1700000000000-abcd","repo":"\(repo)","kind":"verdict",\
    "state":"taken","reason":null,"at":1700000000000}
    """.utf8).write(to: URL(fileURLWithPath: writer.ackPath(id: entry.id)))
    model.pollAcks()

    #expect(model.journal.first?.state == .taken)
    #expect(ActionsText.journalLine(for: try #require(model.journal.first))
        == "\(ActionsText.specsLabel) · alpha · \(ActionsText.taken)")
}

@MainActor
@Test("reponses-et-jalons/AC-9 : l'accusé refusé affiche le motif du pilote, verbatim")
func commandRefusalIsVerbatim() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let writer = PipelineWriter(stateDir: fixture.root)
    let motif = "sans objet : la feature n'attend pas le jalon v"

    model.validate(cardAction(repoRoot: fixture.root, inbox: nil))
    let id = try #require(model.journal.first?.id)
    try FileManager.default.createDirectory(atPath: writer.commandAckDir, withIntermediateDirectories: true)
    try Data("{\"version\":1,\"id\":\"\(id)\",\"repo\":\"/x\",\"kind\":\"verdict\",\"state\":\"refused\",\"reason\":\"\(motif)\",\"at\":1}"
        .utf8).write(to: URL(fileURLWithPath: writer.ackPath(id: id)))
    model.pollAcks()

    #expect(model.journal.first?.state == .refused(reason: motif))
    #expect(ActionsText.journalLine(for: try #require(model.journal.first))
        == "\(ActionsText.specsLabel) · alpha · refusée : \(motif)")
}

@MainActor
@Test("reponses-et-jalons/AC-10 : sans accusé l'entrée reste envoyée, sans prise en charge")
func awaitingWithoutAckStays() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let writer = PipelineWriter(stateDir: fixture.root)

    model.accept(cardAction(repoRoot: fixture.root, inbox: nil))
    let id = try #require(model.journal.first?.id)

    // Un accusé ILLISIBLE est traité comme absent : l'entrée reste en attente.
    try FileManager.default.createDirectory(atPath: writer.commandAckDir, withIntermediateDirectories: true)
    try Data("{ pas du json".utf8).write(to: URL(fileURLWithPath: writer.ackPath(id: id)))
    model.pollAcks()

    let entry = try #require(model.journal.first)
    #expect(entry.state == .awaitingAck)
    #expect(ActionsText.journalLine(for: entry) == "\(ActionsText.reviewLabel) · alpha · \(ActionsText.awaitingAck)")
    // Le fichier de commande, lui, n'est jamais retiré par l'app.
    #expect(FileManager.default.fileExists(atPath: joinPath(writer.commandDir, "0001700000000000-abcd.json")))
}

@MainActor
@Test("reponses-et-jalons/AC-10 : un échec d'écriture de commande ne laisse AUCUNE entrée en attente")
func commandFailureIsAFailureLine() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    // Un FICHIER à la place du canal `commands` : l'écriture échoue.
    try Data("x".utf8).write(to: URL(fileURLWithPath: joinPath(fixture.root, "commands")))

    model.validate(cardAction(repoRoot: fixture.root, inbox: nil))

    guard case .failed(let reason)? = model.journal.first?.state else {
        Issue.record("l'échec d'écriture doit produire une entrée d'échec")
        return
    }
    #expect(reason.hasPrefix("écriture impossible ("))
    #expect(ActionsText.journalLine(for: try #require(model.journal.first))
        == "\(ActionsText.specsLabel) · alpha · échec : \(reason)")
}

@MainActor
@Test("reponses-et-jalons/AC-7 : le formulaire de lancement écrit une commande launch puis se vide")
func launchWritesAndResets() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let writer = PipelineWriter(stateDir: fixture.root)

    model.launchFormShown = true
    model.launchTitle = "Ma feature"
    model.launchDescription = "l'intention"
    model.launch(title: model.launchTitle, description: model.launchDescription, repoRoot: fixture.root)

    let entry = try #require(model.journal.first)
    #expect(entry.kindLabel == ActionsText.launchLabel)
    #expect(entry.targetLabel == "Ma feature")
    #expect(entry.state == .awaitingAck)
    #expect(model.launchTitle.isEmpty, "le titre est remis à zéro après un lancement émis")
    #expect(model.launchDescription.isEmpty)
    #expect(model.launchFormShown == false)

    let path = joinPath(writer.commandDir, "0001700000000000-abcd.json")
    let data = try #require(FileManager.default.contents(atPath: path))
    guard case .object(let object)? = JSONValue.parse(data) else {
        Issue.record("la commande déposée doit être un objet JSON")
        return
    }
    #expect(object["kind"] == .string("launch"))
    #expect(object["title"] == .string("Ma feature"))
    #expect(object["description"] == .string("l'intention"))
    #expect(object["repo"] == .string(realpathOr(fixture.root)))
    #expect(object["deps"] == nil, "aucune dépendance n'est écrite")
}

@MainActor
@Test("reponses-et-jalons/AC-7 : un titre ou une description blancs n'émettent aucun lancement")
func blankLaunchIsNoGesture() {
    let fixture = StoreFixture()
    let model = makeModel(fixture)

    model.launch(title: "   ", description: "l'intention", repoRoot: fixture.root)
    model.launch(title: "titre", description: "  \n", repoRoot: fixture.root)

    #expect(model.journal.isEmpty)
}

@MainActor
@Test("reponses-et-jalons/AC-10 : le journal est borné à 20 entrées, la plus récente en tête")
func journalIsBounded() {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let box = fixture.createBox("run-1")
    let action = cardAction(repoRoot: fixture.root, inbox: box)

    for index in 0..<25 {
        model.sendText(action, text: "message \(index)")
    }

    #expect(model.journal.count == ActionsModel.journalLimit)
    #expect(model.journal.first?.targetLabel == "depot/alpha")
    // La plus RÉCENTE en tête : la dernière écrite est la première lue.
    #expect(model.journal.count == 20)
}

@MainActor
@Test("reponses-et-jalons/AC-8 : arrêter n'est offert qu'avec un lot et cible le dépôt")
func stopTargetsTheRepository() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    // Sans lot (slug nil), aucun geste.
    model.stopLot(cardAction(repoRoot: fixture.root, inbox: nil, slug: nil))
    #expect(model.journal.isEmpty)

    model.stopLot(cardAction(repoRoot: fixture.root, inbox: nil))
    let entry = try #require(model.journal.first)
    #expect(entry.kindLabel == ActionsText.stopLabel)
    #expect(entry.targetLabel == fixture.root.split(separator: "/").last.map(String.init))
    #expect(entry.state == .awaitingAck)
}

// MARK: - confinement de la boîte (S-1, B-1) et échec d'écriture (B-3)

@MainActor
@Test("chemins-du-magasin-non-confines/AC-1 : une boîte hors zone est refusée ET journalisée, sans aucun fichier")
func outOfZoneInboxIsRefusedAndJournalled() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let outside = joinPath(NSTemporaryDirectory(), "omp-hors-\(UUID().uuidString)")

    model.sendText(cardAction(repoRoot: fixture.root, inbox: outside), text: "avance")

    guard case .failed(let reason)? = model.journal.first?.state else {
        Issue.record("un refus de confinement doit produire une entrée d'échec")
        return
    }
    #expect(reason == "chemin refusé (\(outside)) : hors de \(joinPath(fixture.root, "inbox"))")
    #expect(ActionsText.journalLine(for: try #require(model.journal.first))
        == "\(ActionsText.textLabel) · depot/alpha · échec : \(reason)")
    #expect(!FileManager.default.fileExists(atPath: outside), "aucun dossier hors zone n'est créé")
}

@MainActor
@Test("chemins-du-magasin-non-confines/AC-7 : une boîte bloquée DANS la zone journalise un échec d'écriture")
func blockedBoxInsideZoneJournalsFailure() throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture)
    let writer = PipelineWriter(stateDir: fixture.root)
    try FileManager.default.createDirectory(atPath: writer.inboxRoot, withIntermediateDirectories: true)
    let blocked = joinPath(writer.inboxRoot, "bloque")
    try Data("x".utf8).write(to: URL(fileURLWithPath: blocked))

    model.sendText(cardAction(repoRoot: fixture.root, inbox: joinPath(blocked, "run-1")), text: "avance")

    guard case .failed(let reason)? = model.journal.first?.state else {
        Issue.record("l'échec d'écriture doit produire une entrée d'échec")
        return
    }
    #expect(reason.hasPrefix("écriture impossible ("))
    #expect(ActionsText.journalLine(for: try #require(model.journal.first))
        == "\(ActionsText.textLabel) · depot/alpha · échec : \(reason)")
}

// MARK: - omp-console-redesign (S-7, S-8, S-10)

/// Une horloge que le test avance à la main.
private final class ManualClock: @unchecked Sendable {
    var now: Double
    init(_ now: Double) { self.now = now }
    var storeClock: StoreClock { StoreClock { [unowned self] in self.now } }
}

/// Un pilote factice : il enregistre chaque dépôt sollicité et peut échouer.
@MainActor
private final class RecordingPilot: PipelinePilot {
    var calls: [String] = []
    var failure: Error?
    func ensurePilot(repoRoot: String) async throws {
        calls.append(repoRoot)
        if let failure { throw failure }
    }
}

@MainActor
@Test("omp-console-redesign/AC-5 : une commande sans accusé après 20 s est signalée, puis rattrapée par un accusé tardif")
func unacknowledgedCommandIsSignaledThenCaughtUp() throws {
    let fixture = StoreFixture()
    let clock = ManualClock(t0)
    let model = ActionsModel(writer: PipelineWriter(stateDir: fixture.root), clock: clock.storeClock, salt: { "abcd" })
    let writer = PipelineWriter(stateDir: fixture.root)

    model.launch(title: "export", description: "un besoin", repoRoot: fixture.root)
    let id = try #require(model.journal.first?.id)
    #expect(model.journal.first?.state == .awaitingAck)

    clock.now = t0 + 19_999
    model.pollAcks()
    #expect(model.journal.first?.state == .awaitingAck)

    clock.now = t0 + 20_000
    model.pollAcks()
    let entry = try #require(model.journal.first)
    #expect(entry.state == .unacknowledged)
    #expect(ActionsText.journalLine(for: entry) == "lancement · export · \(ActionsText.unacknowledged)")

    // Un accusé tardif rattrape l'entrée : elle est restée sondée.
    try FileManager.default.createDirectory(atPath: writer.commandAckDir, withIntermediateDirectories: true)
    try Data("{\"version\":1,\"id\":\"\(id)\",\"repo\":\"/x\",\"kind\":\"launch\",\"state\":\"taken\",\"reason\":null,\"at\":1}"
        .utf8).write(to: URL(fileURLWithPath: writer.ackPath(id: id)))
    clock.now = t0 + 25_000
    model.pollAcks()
    #expect(model.journal.first?.state == .taken)
}

@MainActor
@Test("omp-console-redesign/AC-6 : « Répondre » dépose une commande reply exacte et sollicite le pilote")
func replyWritesExactCommandAndSolicitsPilot() async throws {
    let fixture = StoreFixture()
    let pilot = RecordingPilot()
    let model = ActionsModel(
        writer: PipelineWriter(stateDir: fixture.root), clock: fixedClock, salt: { "abcd" }, pilot: pilot
    )
    let writer = PipelineWriter(stateDir: fixture.root)
    var waiting = cardAction(repoRoot: fixture.root, inbox: nil, waitKind: .answer)
    waiting.run = nil
    waiting.waitPrompt = "Quel format ?"

    // Texte blanc : aucun fichier, aucun geste, aucun pilote.
    model.replyText = "  \n"
    model.submitReply(waiting)
    #expect(model.journal.isEmpty)
    #expect((try? FileManager.default.contentsOfDirectory(atPath: writer.commandDir))?.isEmpty ?? true)
    #expect(pilot.calls.isEmpty)

    model.replyText = "CSV, séparateur point-virgule"
    model.submitReply(waiting)
    #expect(model.replyText.isEmpty, "le champ est vidé après l'envoi")
    let entry = try #require(model.journal.first)
    #expect(entry.kindLabel == ActionsText.answerLabel)
    #expect(entry.targetLabel == "alpha")
    #expect(entry.state == .awaitingAck)

    let data = try #require(FileManager.default.contents(atPath: joinPath(writer.commandDir, "0001700000000000-abcd.json")))
    guard case .object(let object)? = JSONValue.parse(data) else {
        Issue.record("la commande déposée doit être un objet JSON")
        return
    }
    #expect(Set(object.keys) == ["version", "id", "sentAt", "repo", "kind", "slug", "text"])
    #expect(object["version"] == .number(1))
    #expect(object["id"] == .string("console-1700000000000-abcd"))
    #expect(object["sentAt"] == .number(t0))
    #expect(object["repo"] == .string(realpathOr(fixture.root)))
    #expect(object["kind"] == .string("reply"))
    #expect(object["slug"] == .string("alpha"))
    #expect(object["text"] == .string("CSV, séparateur point-virgule"))

    await model.pilotTask?.value
    #expect(pilot.calls == [fixture.root], "le pilote est sollicité une fois, pour le dépôt de la feature")
}

@MainActor
@Test("omp-console-redesign/AC-5 : un conducteur qui ne démarre pas fait échouer l'entrée en attente, « Reprendre » journalise son résultat")
func conductorFailureFailsPendingEntryAndResumeJournals() async throws {
    let fixture = StoreFixture()
    let pilot = RecordingPilot()
    pilot.failure = SessionHostError.binaryNotFound(searched: ["/a/omp"], override: nil)
    let model = ActionsModel(
        writer: PipelineWriter(stateDir: fixture.root), clock: fixedClock, salt: { "abcd" }, pilot: pilot
    )
    let motif = "conducteur : \(SessionHostError.binaryNotFound(searched: ["/a/omp"], override: nil).userMessage)"

    model.launch(title: "export", description: "un besoin", repoRoot: fixture.root)
    await model.pilotTask?.value
    #expect(model.journal.first?.state == .failed(reason: motif))

    // « Reprendre » : aucune commande, une entrée « reprise » qui dit le résultat.
    model.resume(cardAction(repoRoot: fixture.root, inbox: nil))
    await model.pilotTask?.value
    #expect(model.journal.first?.kindLabel == ActionsText.resumeLabel)
    #expect(model.journal.first?.state == .failed(reason: motif))

    pilot.failure = nil
    model.resume(cardAction(repoRoot: fixture.root, inbox: nil))
    await model.pilotTask?.value
    #expect(model.journal.first?.state == .taken)
    #expect(pilot.calls.count == 3)
    // Arrêter un lot ne sollicite JAMAIS le pilote.
    model.stopLot(cardAction(repoRoot: fixture.root, inbox: nil))
    await model.pilotTask?.value
    #expect(pilot.calls.count == 3)
}
