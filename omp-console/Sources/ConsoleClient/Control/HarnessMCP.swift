// L'appel d'un OUTIL du MCP du serveur (`POST /v1/mcp`, JSON-RPC 2.0) : les issues
// n'ont pas d'autre surface (`issues_list`, `issue_fix`). Un appel `tools/call` part
// seul, sans initialisation (le serveur répond en JSON, sans session) ; le résultat
// structuré (`structuredContent`) est décodé. Un outil qui échoue rend `isError` et
// son texte : l'échec `.rejected(texte)`. Une erreur du protocole : `.rejected(message)`.

import ConsoleCore
import Foundation

extension HarnessModel {
    /// Le chemin du MCP du serveur.
    nonisolated static let mcpPath = "/v1/mcp"

    /// Appelle l'outil `name` du MCP avec ses arguments ; rend son résultat structuré.
    func callTool<Result: Decodable>(_ name: String, arguments: [String: JSONValue]) async throws -> Result {
        let request = MCPRequest(id: Int.random(in: 1...Int(Int32.max)), params: .init(name: name, arguments: arguments))
        guard let body = try? JSONEncoder().encode(request) else { throw HarnessFailure.unreadable }
        let call = HarnessCall(method: "POST", path: Self.mcpPath, body: body)
        let reply: MCPReply<Result> = try decode(try await exchange(call), for: call)
        if let error = reply.error { throw HarnessFailure.rejected(error.message) }
        guard let result = reply.result else { throw HarnessFailure.unreadable }
        if result.isError == true {
            throw HarnessFailure.rejected(result.content?.compactMap(\.text).joined(separator: "\n") ?? "")
        }
        guard let structured = result.structuredContent else { throw HarnessFailure.unreadable }
        return structured
    }
}

/// Une requête JSON-RPC `tools/call`.
struct MCPRequest: Encodable {
    struct Params: Encodable {
        var name: String
        var arguments: [String: JSONValue]
    }

    var jsonrpc = "2.0"
    var id: Int
    var method = "tools/call"
    var params: Params
}

/// La réponse JSON-RPC d'un `tools/call`.
struct MCPReply<Result: Decodable>: Decodable {
    struct ToolResult: Decodable {
        struct Content: Decodable {
            var type: String
            var text: String?
        }

        var content: [Content]?
        var structuredContent: Result?
        var isError: Bool?

        private enum CodingKeys: String, CodingKey { case content, structuredContent, isError }

        /// Un outil en échec n'a pas de résultat structuré : il n'est décodé qu'en l'absence d'`isError`.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            content = try container.decodeIfPresent([Content].self, forKey: .content)
            isError = try container.decodeIfPresent(Bool.self, forKey: .isError)
            structuredContent = isError == true ? nil : try container.decodeIfPresent(Result.self, forKey: .structuredContent)
        }
    }

    struct RPCError: Decodable {
        var code: Int
        var message: String
    }

    var result: ToolResult?
    var error: RPCError?
}
