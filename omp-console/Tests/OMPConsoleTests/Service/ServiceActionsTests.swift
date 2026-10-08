// Preuves des gestes de carte servis par l'API (BR-6, S-9, S-10) : la commande
// postée, l'accusé affiché (pris en charge ou refusé verbatim), « piloter un
// dépôt » posté, et aucun process lancé.
//
// Aucun réseau : `PipelineWriter` reçoit ses appels POST en injection.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

private let t0: Double = 1_700_000_000_000

/// Un enregistreur d'appels POST : la commande reçue et l'accusé décidé.
private final class CommandRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var posts: [(repo: String, body: [String: Any])] = []
    private(set) var pilots: [String] = []
    var ack: ServiceCommandAck = ServiceCommandAck(
        id: "x", repo: "/tmp/repo", kind: "verdict", state: .taken, reason: nil, at: t0
    )
    var failure: Error?

    func post(_ repo: String, _ body: [String: Any]) throws -> ServiceCommandAck {
        lock.lock(); defer { lock.unlock() }
        posts.append((repo, body))
        if let failure { throw failure }
        return ack
    }

    func pilot(_ repo: String) {
        lock.lock(); defer { lock.unlock() }
        pilots.append(repo)
    }
}

@MainActor
private func makeModel(
    recorder: CommandRecorder,
    salt: String = "abcd"
) -> ActionsModel {
    let writer = PipelineWriter(
        stateDir: (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-actions-\(UUID().uuidString)"),
        post: { repo, body in try recorder.post(repo, body) },
        pilot: { repo in recorder.pilot(repo) }
    )
    return ActionsModel(writer: writer, clock: StoreClock { t0 }, salt: { salt })
}

private func cardAction(repoRoot: String = "/tmp/repo", slug: String = "alpha") -> KanbanCardAction {
    KanbanCardAction(
        repoRoot: repoRoot,
        slug: slug,
        waitKind: .specs,
        featureState: .waiting,
        run: nil
    )
}

@MainActor
private func waitForCommand(_ model: ActionsModel) async {
    await model.commandTask?.value
}

@MainActor
@Test("coque-service : un jalon poste une commande verdict et affiche « prise en charge »")
func verdictPostsAndShowsTaken() async throws {
    let recorder = CommandRecorder()
    recorder.ack = ServiceCommandAck(
        id: "console-1-abcd", repo: "/tmp/repo", kind: "verdict", state: .taken, reason: nil, at: t0
    )
    let model = makeModel(recorder: recorder)
    model.validate(cardAction())
    await waitForCommand(model)
    #expect(model.journal.first?.state == .taken)
    #expect(recorder.posts.count == 1)
    #expect(recorder.posts.first?.body["kind"] as? String == "verdict")
    #expect(recorder.posts.first?.body["verdict"] as? String == "v")
    #expect(recorder.posts.first?.body["slug"] as? String == "alpha")
    #expect(recorder.posts.first?.body["repo"] as? String == "/tmp/repo")
}

@MainActor
@Test("coque-service : un refus affiche le motif du service, verbatim")
func refusalIsVerbatim() async throws {
    let recorder = CommandRecorder()
    recorder.ack = ServiceCommandAck(
        id: "console-1-abcd", repo: "/tmp/repo", kind: "verdict",
        state: .refused, reason: "lot illisible : feature absente", at: t0
    )
    let model = makeModel(recorder: recorder)
    model.accept(cardAction())
    await waitForCommand(model)
    #expect(model.journal.first?.state == .refused(reason: "lot illisible : feature absente"))
    #expect(ActionsText.stateText(model.journal.first!.state) == "refusée : lot illisible : feature absente")
}

@MainActor
@Test("coque-service : un service arrêté journalise l'échec, sans process lancé")
func stoppedServiceFailsCommand() async throws {
    let recorder = CommandRecorder()
    recorder.failure = ServiceClientError.unavailable
    let model = makeModel(recorder: recorder)
    model.stopLot(cardAction())
    await waitForCommand(model)
    #expect(model.journal.first?.state == .failed(reason: "service arrêté"))
    #expect(recorder.posts.count == 1)
}

@MainActor
@Test("coque-service : « piloter un dépôt » poste POST /pilot, jamais un process")
func resumePostsPilot() async throws {
    let recorder = CommandRecorder()
    let model = makeModel(recorder: recorder)
    model.resume(cardAction(repoRoot: "/tmp/repo"))
    await waitForCommand(model)
    #expect(recorder.pilots == ["/tmp/repo"])
    #expect(model.journal.first?.state == .taken)
    #expect(recorder.posts.isEmpty)
}

@MainActor
@Test("coque-service : « Répondre » (reply) poste la commande avec son texte")
func replyPostsCommand() async throws {
    let recorder = CommandRecorder()
    let model = makeModel(recorder: recorder)
    model.replyText = "voici ma réponse"
    model.submitReply(cardAction())
    await waitForCommand(model)
    #expect(recorder.posts.first?.body["kind"] as? String == "reply")
    #expect(recorder.posts.first?.body["text"] as? String == "voici ma réponse")
    #expect(model.replyText.isEmpty)
}

@MainActor
@Test("coque-service : le lancement poste launch puis vide le formulaire")
func launchPostsAndResets() async throws {
    let recorder = CommandRecorder()
    let model = makeModel(recorder: recorder)
    model.launchTitle = "Socle"
    model.launchDescription = "Poser le socle"
    model.launch(title: "Socle", description: "Poser le socle", repoRoot: "/tmp/repo")
    await waitForCommand(model)
    #expect(recorder.posts.first?.body["kind"] as? String == "launch")
    #expect(recorder.posts.first?.body["title"] as? String == "Socle")
    #expect(model.launchTitle.isEmpty)
    #expect(model.launchDescription.isEmpty)
}

@MainActor
@Test("coque-service : un texte blanc ne produit aucun geste")
func blankIsNoGesture() async throws {
    let recorder = CommandRecorder()
    let model = makeModel(recorder: recorder)
    model.launch(title: "  ", description: "x", repoRoot: "/tmp/repo")
    #expect(model.commandTask == nil)
    #expect(recorder.posts.isEmpty)
}
