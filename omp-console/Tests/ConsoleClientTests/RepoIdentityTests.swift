// L'identité d'un dépôt (S-5 de orchestrator-living-in-a-vps) : `RepoIdentity.normalize`
// lit les MÊMES vecteurs que `normalizeRepoIdentity` (omp-mem0-req/handover.ts),
// `test/fixtures/repo-identity.json`. Un vecteur à `identity: null` est un refus.

import ConsoleCore
import Foundation
import Testing

private struct IdentityVector: Decodable {
    var input: String
    var identity: String?
}

/// Le fichier de vecteurs du dépôt, déduit de l'emplacement de ce fichier.
private let vectorsFile = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // ConsoleClientTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // omp-console
    .deletingLastPathComponent()  // racine du dépôt
    .appendingPathComponent("test/fixtures/repo-identity.json")

@Suite("RepoIdentity — les vecteurs communs avec le TypeScript")
struct RepoIdentityTests {
    @Test("chaque vecteur de test/fixtures/repo-identity.json est normalisé (ou refusé) comme en TypeScript")
    func sharedVectors() throws {
        let data = try Data(contentsOf: vectorsFile)
        let vectors = try JSONDecoder().decode([IdentityVector].self, from: data)
        #expect(vectors.count >= 30, "les vecteurs sont lus")
        #expect(vectors.contains { $0.identity == nil } && vectors.contains { $0.identity != nil })
        for vector in vectors {
            #expect(
                RepoIdentity.normalize(vector.input) == vector.identity,
                "\(vector.input.debugDescription) → \(vector.identity ?? "nil")"
            )
        }
    }

    @Test("les segments `.` et `..` sont refusés partout, propriétaire compris (traversée de chemin)")
    func dotSegmentsAreRefused() {
        let refused = [
            "https://github.com/../x", "https://github.com/./x", "https://github.com/o/..", "https://github.com/o/.",
            "git@github.com:../x", "git@github.com:./x", "ssh://git@github.com/../x", "ssh://git@github.com/o/..",
            "https://github.com/../x.git",
        ]
        for url in refused {
            #expect(RepoIdentity.normalize(url) == nil, "\(url)")
        }
    }

    @Test("le nom d'affichage est le dernier segment de l'identité")
    func shortName() {
        #expect(RepoIdentity.shortName("github.com/o/n") == "n")
        #expect(RepoIdentity.shortName("seul") == "seul")
    }
}
