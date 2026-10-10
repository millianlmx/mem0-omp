// Preuves du MODÈLE d'action (S-4, S-7) : le journal borné, en attente → pris en
// charge, refus au motif verbatim, garde du texte blanc et remise à zéro du
// formulaire de lancement.
//
// Une commande est POSTÉE au service : l'entrée entre en attente, puis prend
// l'accusé rendu par la réponse HTTP. Le test attend `model.commandTask` de la
// même façon que le dépôt attend `controller.pumpCommands()` : aucune tâche de
// fond ne tourne à vide.

@testable import OMPConsole
@testable import ConsoleCore
import Foundation
import Testing

private let t0: Double = 1_700_000_000_000
private let fixedClock = StoreClock { t0 }

@MainActor
private func makeModel(
    _ fixture: StoreFixture,
    salt: String = "abcd",
    post: @escaping @Sendable (String, [String: Any]) async throws -> ServiceCommandAck
        = { _, _ in ServiceCommandAck(id: "x", repo: "", kind: nil, state: .taken, reason: nil, at: t0) },
    pilot: @escaping @Sendable (String) async throws -> Void = { _ in }
) -> ActionsModel {
    ActionsModel(
        writer: PipelineWriter(stateDir: fixture.root, post: post, pilot: pilot),
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

/// Un enregistreur d'appels au service : les commandes POSTÉES, les dépôts
/// « pilotés », et l'accusé (ou l'échec) que chaque appel rend.
private final class ServiceRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var posts: [(repo: String, body: [String: Any])] = []
    private(set) var pilots: [String] = []
    var ack = ServiceCommandAck(id: "x", repo: "", kind: nil, state: .taken, reason: nil, at: t0)
    var postFailure: Error?
    var pilotFailure: Error?

    func post(_ repo: String, _ body: [String: Any]) throws -> ServiceCommandAck {
        lock.lock(); defer { lock.unlock() }
        posts.append((repo, body))
        if let postFailure { throw postFailure }
        return ack
    }

    func pilot(_ repo: String) throws {
        lock.lock(); defer { lock.unlock() }
        pilots.append(repo)
        if let pilotFailure { throw pilotFailure }
    }
}

/// Une porte : le POST reste EN VOL tant qu'elle n'est pas ouverte, ce qui permet
/// d'observer l'entrée « envoyé au pilote » avant que la réponse n'arrive.
private final class PostGate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if opened {
                lock.unlock()
                continuation.resume()
                return
            }
            waiting.append(continuation)
            lock.unlock()
        }
    }

    func open() {
        lock.lock()
        opened = true
        let continuations = waiting
        waiting = []
        lock.unlock()
        for continuation in continuations { continuation.resume() }
    }
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
func commandGoesToTaken() async throws {
    let fixture = StoreFixture()
    let model = makeModel(fixture, post: { repo, body in
        ServiceCommandAck(
            id: body["id"] as? String ?? "x", repo: repo, kind: "verdict",
            state: .taken, reason: nil, at: t0
        )
    })

    model.validate(cardAction(repoRoot: fixture.root, inbox: nil))
    let entry = try #require(model.journal.first)
    #expect(entry.id == "console-1700000000000-abcd")
    #expect(entry.state == .awaitingAck)
    #expect(ActionsText.journalLine(for: entry) == "\(ActionsText.specsLabel) · alpha · \(ActionsText.awaitingAck)")

    // La réponse du service porte l'accusé : l'entrée bascule alors.
    await model.commandTask?.value
    #expect(model.journal.first?.state == .taken)
    #expect(ActionsText.journalLine(for: try #require(model.journal.first))
        == "\(ActionsText.specsLabel) · alpha · \(ActionsText.taken)")
}

@MainActor
@Test("reponses-et-jalons/AC-9 : l'accusé refusé affiche le motif du pilote, verbatim")
func commandRefusalIsVerbatim() async throws {
    let fixture = StoreFixture()
    let motif = "sans objet : la feature n'attend pas le jalon v"
    let model = makeModel(fixture, post: { repo, body in
        ServiceCommandAck(
            id: body["id"] as? String ?? "x", repo: repo, kind: "verdict",
            state: .refused, reason: motif, at: t0
        )
    })

    model.validate(cardAction(repoRoot: fixture.root, inbox: nil))
    await model.commandTask?.value

    #expect(model.journal.first?.state == .refused(reason: motif))
    #expect(ActionsText.journalLine(for: try #require(model.journal.first))
        == "\(ActionsText.specsLabel) · alpha · refusée : \(motif)")
}

@MainActor
@Test("reponses-et-jalons/AC-10 : sans accusé l'entrée reste envoyée, sans prise en charge")
func awaitingWithoutAckStays() async throws {
    let fixture = StoreFixture()
    let gate = PostGate()
    let model = makeModel(fixture, post: { repo, body in
        await gate.wait()
        return ServiceCommandAck(
            id: body["id"] as? String ?? "x", repo: repo, kind: "verdict",
            state: .taken, reason: nil, at: t0
        )
    })

    model.accept(cardAction(repoRoot: fixture.root, inbox: nil))

    // La requête est EN VOL : l'entrée reste en attente, jamais « prise en charge ».
    let entry = try #require(model.journal.first)
    #expect(entry.state == .awaitingAck)
    #expect(ActionsText.journalLine(for: entry) == "\(ActionsText.reviewLabel) · alpha · \(ActionsText.awaitingAck)")

    // L'accusé ne vient que de la réponse : tant qu'elle n'est pas là, rien ne bascule.
    gate.open()
    await model.commandTask?.value
    #expect(model.journal.first?.state == .taken)
}

@MainActor
@Test("reponses-et-jalons/AC-10 : un échec d'envoi de commande ne laisse AUCUNE entrée en attente")
func commandFailureIsAFailureLine() async throws {
    let fixture = StoreFixture()
    // Le service est injoignable : le POST lève, aucune entrée ne reste en attente.
    let model = makeModel(fixture, post: { _, _ in throw ServiceClientError.unavailable })

    model.validate(cardAction(repoRoot: fixture.root, inbox: nil))
    await model.commandTask?.value

    guard case .failed(let reason)? = model.journal.first?.state else {
        Issue.record("l'échec d'envoi doit produire une entrée d'échec")
        return
    }
    #expect(reason == "service arrêté")
    #expect(ActionsText.journalLine(for: try #require(model.journal.first))
        == "\(ActionsText.specsLabel) · alpha · échec : service arrêté")
}

@MainActor
@Test("reponses-et-jalons/AC-7 : le formulaire de lancement poste une commande launch puis se vide")
func launchWritesAndResets() async throws {
    let fixture = StoreFixture()
    let recorder = ServiceRecorder()
    let model = makeModel(fixture, post: { repo, body in try recorder.post(repo, body) })

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

    await model.commandTask?.value
    let body = try #require(recorder.posts.first?.body)
    #expect(body["kind"] as? String == "launch")
    #expect(body["title"] as? String == "Ma feature")
    #expect(body["description"] as? String == "l'intention")
    #expect(body["repo"] as? String == realpathOr(fixture.root))
    #expect(body["deps"] == nil, "aucune dépendance n'est postée")
    #expect(body["modelReqSpecs"] == nil, "aucun modèle n'est écrit")
    #expect(body["modelImplReview"] == nil)
    // Une commande est POSTÉE au service, jamais déposée dans un canal de fichiers :
    // l'app ne crée aucun répertoire `commands` dans le magasin.
    #expect(!FileManager.default.fileExists(atPath: joinPath(fixture.root, "commands")))
}

@MainActor
@Test("reponses-et-jalons/AC-7 : un titre ou une description blancs n'émettent aucun lancement")
func blankLaunchIsNoGesture() {
    let fixture = StoreFixture()
    let model = makeModel(fixture)

    model.launch(title: "   ", description: "l'intention", repoRoot: fixture.root)
    model.launch(title: "titre", description: "  \n", repoRoot: fixture.root)

    #expect(model.journal.isEmpty)
    #expect(model.commandTask == nil)
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
        == "\(ActionsText.textLabel) · depot/alpha · échec : \(reason)")
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
        == "\(ActionsText.textLabel) · depot/alpha · échec : \(reason)")
}

// MARK: - omp-console-redesign (S-7, S-8, S-10)

@MainActor
@Test("omp-console-redesign/AC-5 : une commande reste « envoyé au pilote » tant que la réponse n'est pas arrivée, puis prend l'accusé rendu")
func unacknowledgedCommandIsSignaledThenCaughtUp() async throws {
    let fixture = StoreFixture()
    let gate = PostGate()
    let model = makeModel(fixture, post: { repo, body in
        await gate.wait()
        return ServiceCommandAck(
            id: body["id"] as? String ?? "x", repo: repo, kind: "launch",
            state: .taken, reason: nil, at: t0
        )
    })

    model.launch(title: "export", description: "un besoin", repoRoot: fixture.root)
    let entry = try #require(model.journal.first)
    #expect(entry.state == .awaitingAck)
    #expect(ActionsText.journalLine(for: entry) == "lancement · export · \(ActionsText.awaitingAck)")

    // L'accusé arrive par la réponse : l'entrée est rattrapée.
    gate.open()
    await model.commandTask?.value
    #expect(model.journal.first?.state == .taken)
}

@MainActor
@Test("omp-console-redesign/AC-6 : « Répondre » poste une commande reply exacte, sans solliciter de conducteur")
func replyWritesExactCommandAndSolicitsPilot() async throws {
    let fixture = StoreFixture()
    let recorder = ServiceRecorder()
    let model = makeModel(
        fixture,
        post: { repo, body in try recorder.post(repo, body) },
        pilot: { repo in try recorder.pilot(repo) }
    )
    var waiting = cardAction(repoRoot: fixture.root, inbox: nil, waitKind: .answer)
    waiting.run = nil
    waiting.waitPrompt = "Quel format ?"

    // Texte blanc : aucun POST, aucun geste, aucun conducteur.
    model.replyText = "  \n"
    model.submitReply(waiting)
    #expect(model.journal.isEmpty)
    #expect(model.commandTask == nil)
    #expect(recorder.posts.isEmpty)
    #expect(recorder.pilots.isEmpty)

    model.replyText = "CSV, séparateur point-virgule"
    model.submitReply(waiting)
    #expect(model.replyText.isEmpty, "le champ est vidé après l'envoi")
    let entry = try #require(model.journal.first)
    #expect(entry.kindLabel == ActionsText.answerLabel)
    #expect(entry.targetLabel == "alpha")
    #expect(entry.state == .awaitingAck)

    await model.commandTask?.value
    let body = try #require(recorder.posts.first?.body)
    #expect(Set(body.keys) == ["version", "id", "sentAt", "repo", "kind", "slug", "text"])
    #expect((body["version"] as? NSNumber)?.intValue == 1)
    #expect(body["id"] as? String == "console-1700000000000-abcd")
    #expect((body["sentAt"] as? NSNumber)?.doubleValue == t0)
    #expect(body["repo"] as? String == realpathOr(fixture.root))
    #expect(body["kind"] as? String == "reply")
    #expect(body["slug"] as? String == "alpha")
    #expect(body["text"] as? String == "CSV, séparateur point-virgule")
    #expect(recorder.pilots.isEmpty, "poster une commande ne sollicite pas le conducteur")
}

@MainActor
@Test("omp-console-redesign/AC-5 : un conducteur qui ne démarre pas fait échouer l'entrée, « Reprendre » journalise son résultat")
func conductorFailureFailsPendingEntryAndResumeJournals() async throws {
    let fixture = StoreFixture()
    let recorder = ServiceRecorder()
    recorder.pilotFailure = ServiceClientError.unavailable
    let model = makeModel(
        fixture,
        post: { repo, body in try recorder.post(repo, body) },
        pilot: { repo in try recorder.pilot(repo) }
    )
    let motif = "pilote : service arrêté"

    model.resume(cardAction(repoRoot: fixture.root, inbox: nil))
    await model.commandTask?.value
    #expect(model.journal.first?.kindLabel == ActionsText.resumeLabel)
    #expect(model.journal.first?.state == .failed(reason: motif))

    // « Reprendre » : aucune commande, une entrée « reprise » qui dit le résultat.
    recorder.pilotFailure = nil
    model.resume(cardAction(repoRoot: fixture.root, inbox: nil))
    await model.commandTask?.value
    #expect(model.journal.first?.state == .taken)
    #expect(recorder.pilots == [realpathOr(fixture.root), realpathOr(fixture.root)])
    #expect(recorder.posts.isEmpty, "« Reprendre » ne poste aucune commande")

    // Arrêter un lot ne sollicite JAMAIS le conducteur.
    model.stopLot(cardAction(repoRoot: fixture.root, inbox: nil))
    await model.commandTask?.value
    #expect(recorder.pilots.count == 2)
    #expect(recorder.posts.count == 1, "l'arrêt, lui, poste une commande stop")
}

@MainActor
@Test("accueil-en-cours-melange-pause-et-compte/AC-4 : « Reprendre » une feature en échec poste une commande relaunch exacte et journalise « reprise · <slug> »")
func relaunchPostsExactCommand() async throws {
    let fixture = StoreFixture()
    let recorder = ServiceRecorder()
    let model = makeModel(
        fixture,
        post: { repo, body in try recorder.post(repo, body) },
        pilot: { repo in try recorder.pilot(repo) }
    )

    let id = try #require(model.relaunch(cardAction(repoRoot: fixture.root, inbox: nil, featureState: .failed)))
    #expect(id == "console-1700000000000-abcd")
    let entry = try #require(model.journal.first)
    #expect(entry.id == id, "l'entrée de journal porte l'identifiant de la commande")
    #expect(entry.kindLabel == ActionsText.resumeLabel)
    #expect(entry.targetLabel == "alpha")
    #expect(entry.state == .awaitingAck)

    await model.commandTask?.value
    #expect(model.journal.first?.state == .taken)
    let post = try #require(recorder.posts.first)
    #expect(post.repo == realpathOr(fixture.root))
    let body = post.body
    #expect(Set(body.keys) == ["version", "id", "sentAt", "repo", "kind", "slug"])
    #expect((body["version"] as? NSNumber)?.intValue == 1)
    #expect(body["id"] as? String == id)
    #expect((body["sentAt"] as? NSNumber)?.doubleValue == t0)
    #expect(body["repo"] as? String == realpathOr(fixture.root))
    #expect(body["kind"] as? String == "relaunch")
    #expect(body["slug"] as? String == "alpha")
    #expect(recorder.pilots.isEmpty, "relancer ne sollicite pas le conducteur")

    // Une feature BLOQUÉE se relance de la même façon.
    #expect(model.relaunch(cardAction(repoRoot: fixture.root, inbox: nil, featureState: .blocked)) != nil)
    await model.commandTask?.value
    #expect(recorder.posts.count == 2)
    #expect(recorder.posts.last?.body["kind"] as? String == "relaunch")
}

@MainActor
@Test("accueil-en-cours-melange-pause-et-compte/AC-4 : une relance refusée par le service est journalisée « refusée » au motif verbatim")
func relaunchRefusalIsJournalled() async throws {
    let fixture = StoreFixture()
    let motif = "relance possible sur une feature bloquée, échouée ou annulée"
    let model = makeModel(fixture, post: { repo, body in
        ServiceCommandAck(
            id: body["id"] as? String ?? "x", repo: repo, kind: "relaunch",
            state: .refused, reason: motif, at: t0
        )
    })

    model.relaunch(cardAction(repoRoot: fixture.root, inbox: nil, featureState: .failed))
    await model.commandTask?.value

    let entry = try #require(model.journal.first)
    #expect(entry.state == .refused(reason: motif))
    #expect(ActionsText.journalLine(for: entry) == "\(ActionsText.resumeLabel) · alpha · refusée : \(motif)")
}

@MainActor
@Test("accueil-en-cours-melange-pause-et-compte/AC-4 : sans slug, sans dépôt ou hors échec/blocage, la relance ne fait RIEN")
func relaunchGuardsLeaveNoTrace() {
    let fixture = StoreFixture()
    let recorder = ServiceRecorder()
    let model = makeModel(
        fixture,
        post: { repo, body in try recorder.post(repo, body) },
        pilot: { repo in try recorder.pilot(repo) }
    )
    var noRepo = cardAction(repoRoot: fixture.root, inbox: nil, featureState: .failed)
    noRepo.repoRoot = nil

    #expect(model.relaunch(cardAction(repoRoot: fixture.root, inbox: nil, slug: nil, featureState: .failed)) == nil)
    #expect(model.relaunch(noRepo) == nil)
    for state in [LotFeatureState.pending, .running, .waiting, .done, .cancelled] {
        #expect(model.relaunch(cardAction(repoRoot: fixture.root, inbox: nil, featureState: state)) == nil)
    }
    #expect(model.relaunch(cardAction(repoRoot: fixture.root, inbox: nil, featureState: nil)) == nil)
    #expect(model.journal.isEmpty)
    #expect(model.commandTask == nil)
    #expect(recorder.posts.isEmpty)
}
