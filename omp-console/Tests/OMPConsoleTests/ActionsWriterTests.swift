// Preuves de l'ÉCRIVAIN du canal côté app (S-1, S-2, S-4, S-11) : le nom et l'objet
// EXACTS d'une livraison comme d'une commande, l'atomicité, l'échec d'écriture à
// motif stable, la lecture d'un accusé (relu, illisible, hors schéma) et
// l'invariant « un seul fichier de plus ».
//
// Le contrat inter-langages est le LITTÉRAL du protocole : les mêmes chaînes sont
// écrites ici et dans `test/reponses.test.ts`.

import Foundation
import Testing
@testable import OMPConsole

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
    // Un FICHIER à la place du dossier : la création de la boîte échoue, errno
    // porte le motif.
    let blocked = joinPath(fixture.root, "bloque")
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

// MARK: - commandes et accusés (S-4)

@Test("reponses-et-jalons/AC-5 : une commande verdict `v` a le nom et l'objet du canal")
func writeVerdictCommand() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    let command = OutgoingCommand.verdict(
        id: "console-1700000000000-a1b2", repo: "/tmp/depot", slug: "alpha", verdict: .specs
    )

    let path = try writer.writeCommand(command, sentAt: 1_700_000_000_000, salt: "a1b2")

    #expect(path == joinPath(writer.commandDir, "0001700000000000-a1b2.json"))
    #expect(object(path) == [
        "version": .number(1),
        "id": .string("console-1700000000000-a1b2"),
        "sentAt": .number(1_700_000_000_000),
        "repo": .string("/tmp/depot"),
        "kind": .string("verdict"),
        "slug": .string("alpha"),
        "verdict": .string("v"),
    ])
    #expect(writer.ackPath(id: "console-1700000000000-a1b2")
        == joinPath(writer.commandAckDir, "console-1700000000000-a1b2.json"))
}

@Test("reponses-et-jalons/AC-6 : une commande verdict `y` porte exactement le schéma du canal")
func writeReviewVerdictCommand() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    let path = try writer.writeCommand(
        .verdict(id: "c-y", repo: "/tmp/depot", slug: "beta", verdict: .review),
        sentAt: 1_700_000_000_000, salt: "abcd"
    )
    #expect(object(path) == [
        "version": .number(1),
        "id": .string("c-y"),
        "sentAt": .number(1_700_000_000_000),
        "repo": .string("/tmp/depot"),
        "kind": .string("verdict"),
        "slug": .string("beta"),
        "verdict": .string("y"),
    ])
}

@Test("reponses-et-jalons/AC-7 : une commande launch ne porte NI slug NI deps")
func writeLaunchCommand() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    let before = relativeTree(fixture.root)

    let path = try writer.writeCommand(
        .launch(id: "c-l", repo: "/tmp/depot", title: "Ma feature", description: "l'intention"),
        sentAt: 1_700_000_000_000, salt: "abcd"
    )

    #expect(object(path) == [
        "version": .number(1),
        "id": .string("c-l"),
        "sentAt": .number(1_700_000_000_000),
        "repo": .string("/tmp/depot"),
        "kind": .string("launch"),
        "title": .string("Ma feature"),
        "description": .string("l'intention"),
    ])
    // Un seul fichier créé, dans `commands/` — et `acks/` n'existe pas encore.
    let added = Set(relativeTree(fixture.root)).subtracting(before)
    #expect(added == ["commands/0001700000000000-abcd.json"])
}

@Test("reponses-et-jalons/AC-8 : une commande stop ne porte que son identité et son dépôt")
func writeStopCommand() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    let path = try writer.writeCommand(
        .stop(id: "c-s", repo: "/tmp/depot"), sentAt: 1_700_000_000_000, salt: "abcd"
    )
    #expect(object(path) == [
        "version": .number(1),
        "id": .string("c-s"),
        "sentAt": .number(1_700_000_000_000),
        "repo": .string("/tmp/depot"),
        "kind": .string("stop"),
    ])
}

@Test("reponses-et-jalons/AC-10 : un accusé absent rend nil sans lever")
func readAckAbsentIsNil() {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    #expect(writer.readAck(id: "console-1-abcd") == nil, "`commands/acks/` absent : aucune exception")
}

@Test("reponses-et-jalons/AC-9 : un accusé refusé rend son identité, son état et son motif")
func readAckRefused() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    try FileManager.default.createDirectory(atPath: writer.commandAckDir, withIntermediateDirectories: true)
    let ack = writer.ackPath(id: "c-1")
    try Data("""
    {"version":1,"id":"c-1","repo":"/tmp/depot","kind":"verdict","state":"refused",\
    "reason":"sans objet : la feature n'attend pas le jalon v","at":1700000000000}
    """.utf8).write(to: URL(fileURLWithPath: ack))

    #expect(writer.readAck(id: "c-1") == PipelineCommandAck(
        id: "c-1",
        state: .refused,
        reason: "sans objet : la feature n'attend pas le jalon v",
        at: 1_700_000_000_000
    ))
}

@Test("reponses-et-jalons/AC-10 : un accusé illisible ou hors schéma est traité comme absent")
func readAckIllisibleIsNil() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    try FileManager.default.createDirectory(atPath: writer.commandAckDir, withIntermediateDirectories: true)

    try Data("{ pas du json".utf8).write(to: URL(fileURLWithPath: writer.ackPath(id: "c-1")))
    #expect(writer.readAck(id: "c-1") == nil)

    try Data("{\"version\":2,\"id\":\"c-1\"}".utf8).write(to: URL(fileURLWithPath: writer.ackPath(id: "c-1")))
    #expect(writer.readAck(id: "c-1") == nil, "version hors schéma")

    try Data("{\"version\":1,\"id\":\"c-1\",\"repo\":\"/x\",\"kind\":null,\"state\":\"peut-être\",\"reason\":null,\"at\":1}"
        .utf8).write(to: URL(fileURLWithPath: writer.ackPath(id: "c-1")))
    #expect(writer.readAck(id: "c-1") == nil, "état hors vocabulaire")
}

@Test("reponses-et-jalons/AC-10 : un accusé nommé d'un autre identifiant est traité comme absent")
func readAckWrongIdIsNil() throws {
    let fixture = StoreFixture()
    let writer = PipelineWriter(stateDir: fixture.root)
    try FileManager.default.createDirectory(atPath: writer.commandAckDir, withIntermediateDirectories: true)
    try Data("{\"version\":1,\"id\":\"autre\",\"repo\":\"/x\",\"kind\":null,\"state\":\"taken\",\"reason\":null,\"at\":1}"
        .utf8).write(to: URL(fileURLWithPath: writer.ackPath(id: "c-1")))

    #expect(writer.readAck(id: "c-1") == nil)
    #expect(writer.readAck(id: "a/b") == nil, "un identifiant hors motif ne nomme aucun fichier")
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
