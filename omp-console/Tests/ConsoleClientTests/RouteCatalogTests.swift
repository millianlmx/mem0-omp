// Le catalogue des routes (S-1) : 9 entrées, chacune unique, normalisée comme la
// table de la coque.

@testable import ConsoleClient
import ConsoleCore
import Testing

@Suite("Catalogue des routes")
@MainActor
struct RouteCatalogTests {
    @Test("le catalogue porte 9 routes uniques")
    func catalogSize() {
        #expect(ClientRoute.all.count == 9)
        let keys = ClientRoute.all.map { "\($0.method) \($0.normalized.path)" }
        #expect(Set(keys).count == 9, "deux routes identiques dans le catalogue")
    }

    @Test("chaque méthode typée a sa route dans le catalogue")
    func typedMethodsHaveRoutes() {
        let expected: Set<String> = [
            "GET /v1/version", "GET /v1/devices", "GET /v1/components",
            "GET /v1/memory/page", "GET /v1/memory/search", "GET /v1/memory/graph",
            "GET /v1/stream", "POST /v1/pair", "DELETE /v1/devices/self",
        ]
        let actual = Set(ClientRoute.all.map { "\($0.method) \($0.path)" })
        #expect(actual == expected)
    }
}
