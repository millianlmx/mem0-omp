// Preuves de l'ÉCRIVAIN du canal côté app (S-1, S-2, S-4, S-11) : le nom et l'objet
// EXACTS d'une livraison comme d'une commande, l'atomicité, l'échec d'écriture à
// motif stable, la lecture d'un accusé (relu, illisible, hors schéma) et
// l'invariant « un seul fichier de plus ».
//
// Le contrat inter-langages est le LITTÉRAL du protocole : les mêmes chaînes sont
// écrites ici et dans `test/reponses.test.ts`.

@testable import OMPConsole
import ConsoleCore
import Darwin
import Foundation
import Testing

/// Un compteur d'appels partagé par les fermetures `@Sendable` du seam
/// `PipelineFileOps` : chaque cas d'`EINTR` ne doit se produire qu'UNE fois.
private final class Attempts: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}

/// Le motif du nom d'un fichier du canal : `<16 chiffres>-<4 hex minuscule>.json`,
/// suffixé `-1`, `-2`… si le nom est pris (`COMMAND_FILE`, commands.ts:49).
private func isCommandFileName(_ name: String) -> Bool {
    let suffixed = name.hasSuffix(".json") ? String(name.dropLast(5)) : ""
    guard !suffixed.isEmpty else { return false }
    let parts = suffixed.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 2 || (parts.count == 3 && Int(parts[2]) != nil) else { return false }
    guard parts[0].count == 16, parts[0].allSatisfy({ $0.isNumber }) else { return false }
    let salt = parts[1]
    return salt.count == 4 && salt.allSatisfy { character in
        character.isNumber || ("a"..."f").contains(character)
    }
}

/// L'arbre d'une racine : les chemins RELATIFS des FICHIERS, triés. Deux relevés
/// égaux disent qu'aucun fichier n'a été créé ni retiré (un répertoire créé pour
/// accueillir une écriture n'est pas un fichier).
private func relativeTree(_ root: String) -> [String] {
    guard let enumerator = FileManager.default.enumerator(atPath: root) else { return [] }
    return enumerator.compactMap { item -> String? in
        guard let name = item as? String else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
            atPath: joinPath(root, name), isDirectory: &isDirectory
        ), !isDirectory.boolValue else { return nil }
        return name
    }.sorted()
}

private func object(_ path: String) -> [String: JSONValue]? {
    guard let data = FileManager.default.contents(atPath: path),
          case .object(let json) = JSONValue.parse(data) else { return nil }
    return json
}

// MARK: - livraisons (S-1, S-2)

@Test("reponses-et-jalons/AC-1 : une livraison ask porte le libellé de l'option et le toolCallId")
func writeAskSelectedDelivery() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    let box = fixture.createBox("run-1")
    let before = relativeTree(fixture.root)

    let path = try writer.writeDelivery(
        inbox: box,
        delivery: .ask(toolCallId: "call-1", answer: .selected("Postgres")),
        sentAt: 1_700_000_000_000,
        salt: "a1b2"
    )

    #expect(path == joinPath(box, "0001700000000000-a1b2.json"))
    #expect(isCommandFileName("0001700000000000-a1b2.json"))
    let body = try #require(object(path))
    #expect(body == [
        "version": .number(1),
        "kind": .string("ask"),
        "toolCallId": .string("call-1"),
        "selected": .string("Postgres"),
        "sentAt": .number(1_700_000_000_000),
    ], "l'objet écrit est exactement le protocole, sans clé de plus")

    // Un seul fichier créé, et il est dans la boîte publiée du run (S-11).
    let after = relativeTree(fixture.root)
    let added = Set(after).subtracting(before)
    #expect(added == [path.replacingOccurrences(of: fixture.root + "/", with: "")])
}

@Test("reponses-et-jalons/AC-2 : une livraison ask en texte libre porte le champ custom")
func writeAskCustomDelivery() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    let box = fixture.createBox("run-1")

    let path = try writer.writeDelivery(
        inbox: box,
        delivery: .ask(toolCallId: "call-9", answer: .custom("les deux")),
        sentAt: 1_700_000_000_000,
        salt: "beef"
    )

    #expect(object(path) == [
        "version": .number(1),
        "kind": .string("ask"),
        "toolCallId": .string("call-9"),
        "custom": .string("les deux"),
        "sentAt": .number(1_700_000_000_000),
    ])
}

@Test("reponses-et-jalons/AC-3 : une livraison text porte le texte et rien d'autre")
func writeTextDelivery() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    let box = fixture.createBox("run-1")

    let path = try writer.writeDelivery(
        inbox: box,
        delivery: .text(text: "continue"),
        sentAt: 1_700_000_001_234,
        salt: "0f0f"
    )

    #expect(object(path) == [
        "version": .number(1),
        "kind": .string("text"),
        "text": .string("continue"),
        "sentAt": .number(1_700_000_001_234),
    ])
}

@Test("reponses-et-jalons/AC-1 : deux livraisons au même instant reçoivent des noms distincts")
func deliveryNameCollisionIsSuffixed() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    let box = fixture.createBox("run-1")

    let first = try writer.writeDelivery(
        inbox: box, delivery: .text(text: "un"), sentAt: 1_700_000_000_000, salt: "abcd"
    )
    let second = try writer.writeDelivery(
        inbox: box, delivery: .text(text: "deux"), sentAt: 1_700_000_000_000, salt: "abcd"
    )

    #expect(first.hasSuffix("0001700000000000-abcd.json"))
    #expect(second.hasSuffix("0001700000000000-abcd-1.json"))
    #expect(try #require(object(second))["text"] == .string("deux"))
}

@Test("reponses-et-jalons/AC-1 : une écriture impossible lève un motif stable et n'écrit rien")
func deliveryFailureHasStableMotif() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    // Un FICHIER à la place du dossier, À L'INTÉRIEUR de la zone (S-1) : la garde
    // de confinement passe, c'est la création du dossier qui échoue, errno porte le
    // motif.
    try FileManager.default.createDirectory(atPath: writer.inboxRoot, withIntermediateDirectories: true)
    let blocked = joinPath(writer.inboxRoot, "bloque")
    try Data("x".utf8).write(to: URL(fileURLWithPath: blocked))
    let before = relativeTree(fixture.root)

    var failure: PipelineWriteFailure?
    do {
        _ = try writer.writeDelivery(
            inbox: joinPath(blocked, "run-1"), delivery: .text(text: "un"), sentAt: 1, salt: "abcd"
        )
    } catch let error as PipelineWriteFailure {
        failure = error
    }

    let reason = try #require(failure?.reason)
    #expect(reason.hasPrefix("écriture impossible ("), "le motif est stable : écriture impossible (<strerror>)")
    #expect(relativeTree(fixture.root) == before, "aucun fichier n'est écrit en cas d'échec")
}

// MARK: - confinement de la boîte (S-1, B-1)

/// Tente une livraison et rend le motif du refus, `nil` si elle a réussi.
private func refusalReason(_ writer: PipelineWriter, inbox: String) -> String? {
    do {
        _ = try writer.writeDelivery(inbox: inbox, delivery: .text(text: "un"), sentAt: 1, salt: "abcd")
        return nil
    } catch let error as PipelineWriteFailure {
        return error.reason
    } catch {
        return "autre erreur : \(error)"
    }
}

@Test("chemins-du-magasin-non-confines/AC-1 : toute boîte hors de <stateDir>/inbox/ est refusée sans rien écrire")
func outOfZoneInboxesAreRefused() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    let outside = joinPath(NSTemporaryDirectory(), "omp-hors-\(UUID().uuidString)")
    let realOutside = joinPath(NSTemporaryDirectory(), "omp-cible-\(UUID().uuidString)")
    try FileManager.default.createDirectory(atPath: realOutside, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: realOutside) }

    // Un lien symbolique, DANS la zone, vers un dossier hors zone.
    try FileManager.default.createDirectory(atPath: writer.inboxRoot, withIntermediateDirectories: true)
    let evade = joinPath(writer.inboxRoot, "evade")
    try FileManager.default.createSymbolicLink(atPath: evade, withDestinationPath: realOutside)

    let refused = [
        "",
        "inbox/run-1",
        outside,
        joinPath(fixture.root, "inbox/../hors"),
        joinPath(fixture.root, "inbox-2"),
        evade,
        joinPath(evade, "../hors"),
    ]
    let before = relativeTree(fixture.root)
    #expect(throws: PipelineWriteFailure.self) {
        _ = try writer.writeDelivery(
            inbox: outside, delivery: .text(text: "un"), sentAt: 1, salt: "abcd"
        )
    }
    for inbox in refused {
        let motif = try #require(refusalReason(writer, inbox: inbox), "« \(inbox) » doit être refusé")
        #expect(motif == "chemin refusé (\(inbox)) : hors de \(writer.inboxRoot)")
    }

    #expect(relativeTree(fixture.root) == before, "un refus ne crée ni ne retire aucun fichier")
    #expect(!FileManager.default.fileExists(atPath: outside), "aucun dossier hors zone n'est créé")
    #expect(
        (try FileManager.default.contentsOfDirectory(atPath: realOutside)).isEmpty,
        "la cible du lien symbolique reste intacte"
    )
}

@Test("chemins-du-magasin-non-confines/AC-2 : une boîte sous la zone est admise, aux mêmes chemins qu'avant")
func inZoneInboxesAreAccepted() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    fixture.createBox("run-1")

    let direct = try writer.writeDelivery(
        inbox: writer.inboxRoot, delivery: .text(text: "un"), sentAt: 1_700_000_000_000, salt: "abcd"
    )
    #expect(direct == joinPath(writer.inboxRoot, "0001700000000000-abcd.json"))

    let box = joinPath(writer.inboxRoot, "run-1")
    let inBox = try writer.writeDelivery(
        inbox: box, delivery: .text(text: "deux"), sentAt: 1_700_000_000_000, salt: "abcd"
    )
    #expect(inBox == joinPath(box, "0001700000000000-abcd.json"))

    let sub = joinPath(writer.inboxRoot, "run-1/sous")
    let inSub = try writer.writeDelivery(
        inbox: sub, delivery: .text(text: "trois"), sentAt: 1_700_000_000_000, salt: "abcd"
    )
    #expect(inSub == joinPath(sub, "0001700000000000-abcd.json"))
    #expect(FileManager.default.fileExists(atPath: inSub), "le dossier est créé au besoin")

    // Zone traversant un lien symbolique légitime (`/var` → `/private/var`, cas de
    // `NSTemporaryDirectory()`) : les deux côtés passent par la même canonisation.
    #expect(writer.isConfinedInbox(joinPath(fixture.root, "inbox/run-1")))
    #expect(PipelineWriter.canonicalPath("../../hors") == nil, "un chemin relatif n'a pas de canonisation")
}

// MARK: - commandes (S-9) : le corps POSTÉ au service

/// Un capteur du corps posté : `PipelineWriter.post` l'enregistre et rend l'accusé
/// décidé par le test.
private final class PostedCommands: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var bodies: [[String: Any]] = []
    private(set) var pilots: [String] = []
    var ack = ServiceCommandAck(
        id: "c", repo: "/tmp/depot", kind: nil, state: .taken, reason: nil, at: 0
    )
    var failure: Error?

    func post(_ body: [String: Any]) throws -> ServiceCommandAck {
        lock.lock(); defer { lock.unlock() }
        bodies.append(body)
        if let failure { throw failure }
        return ack
    }

    func recordPilot(_ repo: String) {
        lock.withLock { pilots.append(repo) }
    }
}

private func commandWriter(_ recorder: PostedCommands, stateDir: String) -> PipelineWriter {
    PipelineWriter(stateDir: stateDir, post: { _, body in try recorder.post(body) })
}

/// L'objet `[String: Any]` égal à l'attendu, sans se soucier du type NSNumber.
private func sameObject(_ body: [String: Any], _ expected: [String: Any]) -> Bool {
    NSDictionary(dictionary: body) == NSDictionary(dictionary: expected)
}

@Test("reponses-et-jalons/AC-5 : une commande verdict `v` poste l'objet exact du canal")
func writeVerdictCommand() async throws {
    let fixture = StoreFixture()
    let recorder = PostedCommands()
    let writer = commandWriter(recorder, stateDir: fixture.root)
    let command = OutgoingCommand.verdict(
        id: "console-1700000000000-a1b2", repo: "/tmp/depot", slug: "alpha", verdict: .specs
    )

    let ack = try await writer.postCommand(repo: "/tmp/depot", command: command, sentAt: 1_700_000_000_000)

    #expect(ack.state == .taken)
    #expect(recorder.bodies.count == 1)
    #expect(sameObject(recorder.bodies[0], [
        "version": 1,
        "id": "console-1700000000000-a1b2",
        "sentAt": 1_700_000_000_000,
        "repo": "/tmp/depot",
        "kind": "verdict",
        "slug": "alpha",
        "verdict": "v",
    ]))
}

@Test("reponses-et-jalons/AC-6 : une commande verdict `y` porte exactement le schéma du canal")
func writeReviewVerdictCommand() async throws {
    let fixture = StoreFixture()
    let recorder = PostedCommands()
    let writer = commandWriter(recorder, stateDir: fixture.root)
    _ = try await writer.postCommand(
        repo: "/tmp/depot",
        command: .verdict(id: "c-y", repo: "/tmp/depot", slug: "beta", verdict: .review),
        sentAt: 1_700_000_000_000
    )
    #expect(sameObject(recorder.bodies[0], [
        "version": 1,
        "id": "c-y",
        "sentAt": 1_700_000_000_000,
        "repo": "/tmp/depot",
        "kind": "verdict",
        "slug": "beta",
        "verdict": "y",
    ]))
}

@Test("reponses-et-jalons/AC-7 : une commande launch ne porte NI slug NI deps, et n'écrit aucun fichier")
func writeLaunchCommand() async throws {
    let fixture = StoreFixture()
    let recorder = PostedCommands()
    let writer = commandWriter(recorder, stateDir: fixture.root)
    let before = relativeTree(fixture.root)

    _ = try await writer.postCommand(
        repo: "/tmp/depot",
        command: .launch(
            id: "c-l", repo: "/tmp/depot", title: "Ma feature", description: "l'intention",
            modelReqSpecs: nil, modelImplReview: nil
        ),
        sentAt: 1_700_000_000_000
    )

    #expect(sameObject(recorder.bodies[0], [
        "version": 1,
        "id": "c-l",
        "sentAt": 1_700_000_000_000,
        "repo": "/tmp/depot",
        "kind": "launch",
        "title": "Ma feature",
        "description": "l'intention",
    ]))
    #expect(relativeTree(fixture.root) == before, "la commande part par HTTP, aucun fichier n'est créé")
}

@Test("model-selector/AC-5 : une commande models porte le schéma exact, NSNull pour un groupe par défaut")
func writeModelsCommand() async throws {
    let fixture = StoreFixture()
    let recorder = PostedCommands()
    let writer = commandWriter(recorder, stateDir: fixture.root)
    _ = try await writer.postCommand(
        repo: "/tmp/depot",
        command: .models(id: "c-m", repo: "/tmp/depot", slug: "alpha", modelReqSpecs: "A", modelImplReview: nil),
        sentAt: 1_700_000_000_000
    )
    #expect(sameObject(recorder.bodies[0], [
        "version": 1,
        "id": "c-m",
        "sentAt": 1_700_000_000_000,
        "repo": "/tmp/depot",
        "kind": "models",
        "slug": "alpha",
        "modelReqSpecs": "A",
        "modelImplReview": NSNull(),
    ]))
}

@Test("reponses-et-jalons/AC-8 : une commande stop ne porte que son identité et son dépôt")
func writeStopCommand() async throws {
    let fixture = StoreFixture()
    let recorder = PostedCommands()
    let writer = commandWriter(recorder, stateDir: fixture.root)
    _ = try await writer.postCommand(
        repo: "/tmp/depot", command: .stop(id: "c-s", repo: "/tmp/depot"), sentAt: 1_700_000_000_000
    )
    #expect(sameObject(recorder.bodies[0], [
        "version": 1,
        "id": "c-s",
        "sentAt": 1_700_000_000_000,
        "repo": "/tmp/depot",
        "kind": "stop",
    ]))
}

@Test("reponses-et-jalons/AC-9 : l'accusé refusé rend son identité, son état et son motif verbatim")
func readAckRefused() async throws {
    let fixture = StoreFixture()
    let recorder = PostedCommands()
    recorder.ack = ServiceCommandAck(
        id: "c-1", repo: "/tmp/depot", kind: "verdict", state: .refused,
        reason: "sans objet : la feature n'attend pas le jalon v", at: 1_700_000_000_000
    )
    let writer = commandWriter(recorder, stateDir: fixture.root)
    let ack = try await writer.postCommand(
        repo: "/tmp/depot",
        command: .verdict(id: "c-1", repo: "/tmp/depot", slug: "alpha", verdict: .specs),
        sentAt: 1_700_000_000_000
    )
    #expect(ack.state == .refused)
    #expect(ack.reason == "sans objet : la feature n'attend pas le jalon v")
    #expect(ack.id == "c-1")
    #expect(ack.at == 1_700_000_000_000)
}

@Test("reponses-et-jalons/AC-10 : un échec du POST est rendu tel quel, aucun accusé inventé")
func readAckAbsentIsNil() async throws {
    let fixture = StoreFixture()
    let recorder = PostedCommands()
    recorder.failure = ServiceClientError.unavailable
    let writer = commandWriter(recorder, stateDir: fixture.root)
    await #expect(throws: ServiceClientError.unavailable) {
        _ = try await writer.postCommand(
            repo: "/tmp/depot", command: .stop(id: "c-1", repo: "/tmp/depot"), sentAt: 1
        )
    }
    #expect(recorder.bodies.count == 1, "le corps a bien été posté une fois")
}

@Test("reponses-et-jalons/AC-10 : « piloter un dépôt » poste au service, sans écrire de fichier")
func readAckIllisibleIsNil() async throws {
    let fixture = StoreFixture()
    let recorder = PostedCommands()
    let writer = PipelineWriter(
        stateDir: fixture.root,
        post: { _, body in try recorder.post(body) },
        pilot: { repo in recorder.recordPilot(repo) }
    )
    let before = relativeTree(fixture.root)
    try await writer.pilot(repo: "/tmp/depot")
    #expect(recorder.pilots == ["/tmp/depot"])
    #expect(relativeTree(fixture.root) == before)
}

// MARK: - identifiants (S-4)

@Test("reponses-et-jalons/AC-5 : l'identifiant console est conforme au motif du canal")
func consoleIdMatchesTheChannelPattern() {
    let id = PipelineId.console(sentAt: 1_700_000_000_000, salt: "a1b2")
    #expect(id == "console-1700000000000-a1b2")
    #expect(PipelineId.isValid(id))
    #expect(PipelineId.isValid("c-1"))
    #expect(!PipelineId.isValid("a/b"))
    #expect(!PipelineId.isValid(""))
    #expect(!PipelineId.isValid(String(repeating: "a", count: 65)))
}

// MARK: - publication exclusive (S-4, B-3)

@Test("chemins-du-magasin-non-confines/AC-5 : une cible occupée n'est jamais écrasée, le nom suivant est publié")
func occupiedTargetIsNeverOverwritten() throws {
    let fixture = StoreFixture()
    let box = fixture.createBox("run-1")
    let writer = PipelineWriter(stateDir: fixture.root)
    let occupied = joinPath(box, "0001700000000000-abcd.json")
    try Data("contenu initial".utf8).write(to: URL(fileURLWithPath: occupied))
    let before = try FileManager.default.attributesOfItem(atPath: occupied)

    let path = try writer.writeDelivery(
        inbox: box, delivery: .text(text: "nouveau"), sentAt: 1_700_000_000_000, salt: "abcd"
    )

    #expect(path == joinPath(box, "0001700000000000-abcd-1.json"), "le nom suivant est publié")
    #expect(try String(contentsOfFile: occupied, encoding: .utf8) == "contenu initial")
    let after = try FileManager.default.attributesOfItem(atPath: occupied)
    #expect(
        after[.modificationDate] as? Date == before[.modificationDate] as? Date,
        "le fichier préexistant n'est pas modifié : contenu ET date intacts"
    )
}

@Test("chemins-du-magasin-non-confines/AC-6 : un EINTR à la création, à l'écriture et à la publication est retenté")
func eintrIsRetriedAtEveryStep() throws {
    let sentAt: Double = 1_700_000_000_000
    let published = "0001700000000000-abcd.json"

    // (1) création exclusive interrompue une fois ⇒ candidat suivant (§3).
    do {
        let fixture = StoreFixture()
        let box = fixture.createBox("run-1")
        var ops = PipelineFileOps.live
        let attempts = Attempts()
        ops.createExclusive = { path in
            guard attempts.next() > 1 else { return (-1, EINTR) }
            return PipelineFileOps.live.createExclusive(path)
        }
        let writer = PipelineWriter(stateDir: fixture.root, fileOps: ops)
        let path = try writer.writeDelivery(
            inbox: box, delivery: .text(text: "un"), sentAt: sentAt, salt: "abcd"
        )
        #expect(path == joinPath(box, published))
        #expect(relativeTree(box) == [published], "aucun temporaire ne survit")
    }

    // (2) écriture interrompue une fois ⇒ la MÊME écriture est retentée (§6).
    do {
        let fixture = StoreFixture()
        let box = fixture.createBox("run-1")
        var ops = PipelineFileOps.live
        let attempts = Attempts()
        ops.write = { descriptor, data, offset in
            guard attempts.next() > 1 else { return (-1, EINTR) }
            return PipelineFileOps.live.write(descriptor, data, offset)
        }
        let writer = PipelineWriter(stateDir: fixture.root, fileOps: ops)
        let path = try writer.writeDelivery(
            inbox: box, delivery: .text(text: "un"), sentAt: sentAt, salt: "abcd"
        )
        #expect(path == joinPath(box, published))
        #expect(object(path)?["text"] == .string("un"), "le contenu est complet après la reprise")
        #expect(relativeTree(box) == [published])
    }

    // (3) publication interrompue une fois ⇒ `link` retenté (§4).
    do {
        let fixture = StoreFixture()
        let box = fixture.createBox("run-1")
        var ops = PipelineFileOps.live
        let attempts = Attempts()
        ops.link = { source, target in
            guard attempts.next() > 1 else { return EINTR }
            return PipelineFileOps.live.link(source, target)
        }
        let writer = PipelineWriter(stateDir: fixture.root, fileOps: ops)
        let path = try writer.writeDelivery(
            inbox: box, delivery: .text(text: "un"), sentAt: sentAt, salt: "abcd"
        )
        #expect(path == joinPath(box, published))
        #expect(relativeTree(box) == [published])
    }
}

@Test("chemins-du-magasin-non-confines/AC-7 : aucun nom libre et erreur d'E/S échouent en motif stable")
func exhaustedNamesAndIOErrorsFail() throws {
    // Aucun nom libre : la publication échoue après `uniqueNameLimit` collisions.
    do {
        let fixture = StoreFixture()
        let box = fixture.createBox("run-1")
        var ops = PipelineFileOps.live
        ops.link = { _, _ in EEXIST }
        let writer = PipelineWriter(stateDir: fixture.root, fileOps: ops)
        var failure: PipelineWriteFailure?
        do {
            _ = try writer.writeDelivery(
                inbox: box, delivery: .text(text: "un"), sentAt: 1, salt: "abcd"
            )
        } catch let error as PipelineWriteFailure {
            failure = error
        }
        #expect(PipelineWriter.uniqueNameLimit == 1000)
        #expect(failure?.reason == "écriture impossible (aucun nom libre)")
        #expect(
            (try FileManager.default.contentsOfDirectory(atPath: box)).isEmpty,
            "aucune cible publiée, aucun temporaire laissé"
        )
    }

    // Erreur d'E/S à la création exclusive : le motif porte le `strerror`.
    do {
        let fixture = StoreFixture()
        let box = fixture.createBox("run-1")
        var ops = PipelineFileOps.live
        ops.createExclusive = { _ in (-1, EIO) }
        let writer = PipelineWriter(stateDir: fixture.root, fileOps: ops)
        var failure: PipelineWriteFailure?
        do {
            _ = try writer.writeDelivery(inbox: box, delivery: .text(text: "un"), sentAt: 1, salt: "abcd")
        } catch let error as PipelineWriteFailure {
            failure = error
        }
        #expect(failure?.reason == "écriture impossible (\(String(cString: strerror(EIO))))")
        #expect(relativeTree(box).isEmpty)
    }
}
