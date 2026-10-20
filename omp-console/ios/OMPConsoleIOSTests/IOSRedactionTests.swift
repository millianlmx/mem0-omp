// Les preuves Swift de la rédaction iOS au vouvoiement (ios-redaction-vouvoiement) :
// un message d'erreur dit d'abord ce qui s'est passé, puis ce qu'il faut faire, sans
// nommer de service ni de commande.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@Suite("ios-redaction-vouvoiement — rédaction des textes visibles")
struct IOSRedactionTests {
    /// Les mots qu'aucun message d'erreur ne montre : services, commandes, branches.
    private static let forbidden = ["mem0", "qdrant", "podman", "ollama", "omlx", "redéploie", "redéployez", "feat/", "branche"]

    /// Les fautes d'un message à la manière d'Apple : deux lignes non vides, la
    /// seconde ouverte par un impératif au vouvoiement, aucun mot interdit.
    private static func faults(_ message: String) -> [String] {
        var faults: [String] = []
        let lines = message.components(separatedBy: "\n")
        if lines.count != 2 { faults.append("\(lines.count) lignes au lieu de 2") }
        if lines.contains(where: { $0.trimmingCharacters(in: .whitespaces).isEmpty }) {
            faults.append("une ligne vide")
        }
        if lines.count == 2 {
            let verb = lines[1].split(whereSeparator: { !$0.isLetter }).first.map(String.init) ?? ""
            if !verb.lowercased().hasSuffix("ez") { faults.append("2e ligne ouverte par « \(verb) »") }
        }
        let lowered = message.lowercased()
        for word in forbidden where lowered.contains(word) { faults.append("contient « \(word) »") }
        return faults
    }

    @Test("ios-redaction-vouvoiement/AC-2 : macErrorsSayWhatHappenedThenWhatToDo — chaque message d'erreur dit ce qui s'est passé puis ce qu'il faut faire, au vouvoiement, sans service ni commande")
    func macErrorsSayWhatHappenedThenWhatToDo() {
        let failures: [IOSMacFailure] = [
            .macOutdated, .macUnreachable, .macTimedOut, .serviceUnavailable, .refused,
            .serviceOutdated, .rejected("carte inconnue"),
            .incompatibleProtocol(local: ConsoleAPI.protocolVersion, remote: nil),
            .incompatibleProtocol(local: 1, remote: 2),
            .generic,
        ]
        for failure in failures {
            let message = IOSMacErrorText.message(for: failure)
            #expect(Self.faults(message).isEmpty, "\(failure) : \(Self.faults(message)) — « \(message) »")
            // La cause d'abord : la première ligne est la cause du traducteur.
            if failure != .serviceOutdated {
                #expect(message.hasPrefix(IOSMacErrorText.cause(failure) + "\n"), "\(failure)")
            }
        }
        #expect(Self.faults(IOSMemoryText.graphMacOutdated).isEmpty, "\(Self.faults(IOSMemoryText.graphMacOutdated))")

        // Le traducteur partagé ne montre jamais le détail brut du Mac.
        let raw = ClientError.api(.badRequest("mem0-http a répondu 500 sur /memory"))
        #expect(IOSMacErrorText.message(for: raw)?.contains("mem0-http") != true)
    }

    @Test("ios-redaction-vouvoiement/AC-4 : proximityReadsAsPlainWords — une proximité se lit en clair, sans chiffre ni « Proximité »")
    func proximityReadsAsPlainWords() {
        let near = IOSMemoryText.proximityLabel(0.9)
        let far = IOSMemoryText.proximityLabel(0.3)
        #expect(near == "Très proche")
        #expect(far == "Assez proche")
        #expect(near != far)
        // Les bornes : 0,90 et 0,80 incluses dans le palier du dessus.
        #expect(IOSMemoryText.proximityLabel(0.90) == "Très proche")
        #expect(IOSMemoryText.proximityLabel(0.8999) == "Proche")
        #expect(IOSMemoryText.proximityLabel(0.80) == "Proche")
        #expect(IOSMemoryText.proximityLabel(0.7999) == "Assez proche")
        #expect(IOSMemoryText.proximityLabel(.nan) == "Assez proche")
        for label in [near, far, IOSMemoryText.proximityLabel(0.85)] {
            let hasDigit = label.contains(where: \.isNumber)
            #expect(!hasDigit, "« \(label) »")
        }

        let labels = Dictionary(uniqueKeysWithValues: MemoryGraphParity.facts.nodes.map { ($0.id, $0.label) })
        let links = MemoryGraphParity.facts.links
        let m1 = IOSMemoryDetailView.linkLines(links, from: "m1", labels: labels)
        let m3 = IOSMemoryDetailView.linkLines(links, from: "m3", labels: labels)
        #expect(m1.contains("Proche · titre deux"), "\(m1)")
        #expect(m3.contains("Assez proche · titre deux"), "\(m3)")
        #expect(m3.contains("Très proche · titre quatre"), "\(m3)")
        for line in m1 + m3 {
            let hasDigit = line.contains(where: \.isNumber)
            #expect(!hasDigit, "« \(line) »")
            #expect(!line.contains("Proximité"), "« \(line) »")
        }
    }
}
