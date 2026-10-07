// Le catalogue des routes (S-1) : 29 entrées, chacune unique, normalisée comme la
// table de la coque.

@testable import ConsoleClient
import ConsoleCore
import Testing

@Suite("Catalogue des routes")
@MainActor
struct RouteCatalogTests {
    @Test("le catalogue porte 29 routes uniques")
    func catalogSize() {
        #expect(ClientRoute.all.count == 29)
        let keys = ClientRoute.all.map { "\($0.method) \($0.normalized.path)" }
        #expect(Set(keys).count == 29, "deux routes identiques dans le catalogue")
    }

    @Test("chaque méthode typée a sa route dans le catalogue")
    func typedMethodsHaveRoutes() {
        // Les routes invoquées par une méthode typée du modèle, hors `stream` et
        // `pair` couverts respectivement par `openStream()` et `pair()`.
        let expected: Set<String> = [
            "GET /v1/version", "GET /v1/store", "GET /v1/sessions", "GET /v1/sessions/{id}",
            "GET /v1/projects", "GET /v1/repos", "GET /v1/projects/{repoKey}/documents", "GET /v1/stats",
            "GET /v1/devices", "GET /v1/memory", "GET /v1/memory/search", "GET /v1/memory/graph",
            "GET /v1/stream", "POST /v1/pair", "POST /v1/cards/{id}/answer", "POST /v1/cards/{id}/reply",
            "POST /v1/cards/{id}/text", "POST /v1/cards/{id}/verdict", "POST /v1/cards/{id}/resume",
            "POST /v1/cards/{id}/stop", "POST /v1/features", "POST /v1/projects/{repoKey}/conduite",
            "DELETE /v1/projects/{repoKey}/conduite", "GET /v1/conduite", "POST /v1/conduite/dialogs/{id}",
            "GET /v1/session", "POST /v1/session/prompt",
            "GET /v1/projects/{repoKey}/pull-requests", "POST /v1/projects/{repoKey}/pull-requests/{slug}/merge",
        ]
        let actual = Set(ClientRoute.all.map { "\($0.method) \($0.path)" })
        #expect(actual == expected)
    }
}
