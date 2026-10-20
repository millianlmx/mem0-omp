// Ce que le Mac sait de l'identité et de la bascule de ses dépôts (S-5 de
// orchestrator-living-in-a-vps) : `repos.json` (dépôts adoptés par une bascule) et
// `handovers.json` (bascules inscrites) du dossier d'état — écrits par le SERVICE,
// lus ici, jamais écrits — et l'identité GitHub de l'`origin` d'un dépôt.
//
// Miroir de `readAdoptedRepos`/`readHandovers`/`repoIdentity` (omp-mem0-req/handover.ts) :
// un fichier absent ou illisible vaut « rien », jamais une erreur.

import ConsoleCore
import Foundation

enum RepoDirectory {
    /// Un dépôt adopté par une bascule : l'identité et le chemin local du clone.
    struct Adopted: Equatable, Sendable {
        let identity: String
        let repoRoot: String
    }

    private struct AdoptedFile: Decodable {
        struct Entry: Decodable {
            let identity: String
            let repoRoot: String
        }

        let repos: [Entry]
    }

    private struct HandoversFile: Decodable {
        struct Entry: Decodable {
            let id: String
            let to: RepoMachine
            let state: RepoHandover.State
        }

        let repos: [String: Entry]
    }

    /// `<stateDir>/repos.json` : les dépôts adoptés, dans l'ordre du fichier.
    static func adopted(stateDir: String) -> [Adopted] {
        let url = URL(fileURLWithPath: stateDir).appendingPathComponent("repos.json")
        guard let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(AdoptedFile.self, from: data) else { return [] }
        return file.repos.map { Adopted(identity: $0.identity, repoRoot: $0.repoRoot) }
    }

    /// `<stateDir>/handovers.json` : la bascule de chaque dépôt, par clé de dépôt.
    static func handovers(stateDir: String) -> [String: RepoHandover] {
        let url = URL(fileURLWithPath: stateDir).appendingPathComponent("handovers.json")
        guard let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(HandoversFile.self, from: data) else { return [:] }
        return file.repos.mapValues { RepoHandover(id: $0.id, to: $0.to, state: $0.state) }
    }

    /// L'identité GitHub du dépôt : `git -C <root> remote get-url origin` normalisé ;
    /// `nil` sans git, sans `origin` ou pour un autre hébergeur.
    static func originIdentity(root: String, environment: [String: String]) async -> String? {
        guard case .success(let git) = GitBinary.resolve(environment: environment, path: root) else { return nil }
        let child = ProcessRunner.child(
            binary: git,
            arguments: ["-C", root, "remote", "get-url", "origin"],
            cwd: URL(fileURLWithPath: root),
            environment: environment,
            input: .nullDevice
        )
        guard let run = try? await ProcessRunner.run(child, timeout: 10), run.code == 0, !run.timedOut else { return nil }
        return RepoIdentity.normalize(run.stdout)
    }
}
