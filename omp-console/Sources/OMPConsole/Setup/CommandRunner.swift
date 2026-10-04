// L'exécution d'une commande EXTERNE (podman, pkgutil, curl…), injectable (S-1).
//
// Un seul type pour les trois appels de l'app : les commandes podman de la pile
// (S-2), `pkgutil --expand-full` et les vérifications `--version` de
// l'installateur (S-1), et les appels `curl` sur socket Unix de la migration
// (S-3). Les doublures de test remplacent la closure entière ; aucun test
// unitaire ne lance un binaire réel.
//
// Type NOMINAL, pas un alias de type fonction : Swift interdit d'étendre un type
// fonction (« non-nominal type cannot be extended »), or le contrat exige
// `CommandRunner.live`. `callAsFunction` conserve la syntaxe d'appel du contrat
// (`run(binary, arguments, environment, timeout)`), et l'initialiseur prend la
// closure — une doublure s'écrit `CommandRunner { binary, arguments, env, timeout in … }`.
//
// Ce que ce fichier ne connaît PAS : podman, curl, pkgutil, et tout message
// destiné à l'utilisateur. La traduction d'un échec en erreur de domaine
// appartient à l'appelant, qui garde ses textes.

import Foundation

struct CommandRunner: Sendable {
    private let body: @Sendable (
        _ binary: URL,
        _ arguments: [String],
        _ environment: [String: String],
        _ timeout: Double
    ) async throws -> ProcessRun

    init(_ body: @escaping @Sendable (
        _ binary: URL,
        _ arguments: [String],
        _ environment: [String: String],
        _ timeout: Double
    ) async throws -> ProcessRun) {
        self.body = body
    }

    func callAsFunction(
        _ binary: URL,
        _ arguments: [String],
        _ environment: [String: String],
        _ timeout: Double
    ) async throws -> ProcessRun {
        try await body(binary, arguments, environment, timeout)
    }

    /// L'exécution réelle : `ProcessRunner.child`/`run` (S-1), cwd `/` — un chemin
    /// relatif ne doit jamais dépendre du dossier courant de l'app — et stdin
    /// `/dev/null` (aucune commande n'attend d'entrée).
    static var live: CommandRunner {
        CommandRunner { binary, arguments, environment, timeout in
            let child = ProcessRunner.child(
                binary: binary,
                arguments: arguments,
                cwd: URL(fileURLWithPath: "/", isDirectory: true),
                environment: environment,
                input: .nullDevice
            )
            return try await ProcessRunner.run(child, timeout: timeout)
        }
    }
}
