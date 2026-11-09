// Les canaux Slack SUIVIS, côté client, partagés par la coque Mac et l'app iOS : la liste
// des canaux de l'espace et la case « suivi » de chacun (routes
// `/v1/workstation/channels/slack/conversations*` d'omp-harness, capacité
// `workstation-channel-reads`). Le serveur lit les DM et les mentions partout ; un canal
// coché entre en plus dans sa lecture suivante.
//
// Comme tout le poste, ces routes sont au PROPRIÉTAIRE, et cocher est un geste de
// l'appareil approbateur : le refus du serveur revient au geste. Un serveur sans la route
// (404) ou un Slack non connecté (409) n'a pas de liste : `.absent`, la section disparaît.
//
// Il n'a ni transport ni jeton à lui : il est porté par `WorkstationChannelsModel`
// (`channels.slackConversations`) et relit la liste à chaque `workstation_channel_follow`.
//
// Aucun texte ici : un échec est un `HarnessFailure`, que les écrans traduisent.

import Foundation

// MARK: - Contrat JSON

/// Un canal de l'espace Slack : `kind` vaut `public` ou `private`.
public struct WorkstationSlackConversation: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var kind: String
    public var archived: Bool
    public var followed: Bool
}

/// `GET /v1/workstation/channels/slack/conversations`.
public struct WorkstationSlackConversationsReply: Codable, Equatable, Sendable {
    public var conversations: [WorkstationSlackConversation]
}

/// `PUT /v1/workstation/channels/slack/conversations/{id}`.
public struct WorkstationSlackConversationReply: Codable, Equatable, Sendable {
    public var conversation: WorkstationSlackConversation
}

// MARK: - Modèle

@MainActor
public final class WorkstationSlackConversationsModel: ObservableObject {
    /// Ce que le serveur relié dit de la liste.
    public enum Availability: Equatable, Sendable {
        /// Pas encore lue.
        case unknown
        /// Le serveur sert la liste.
        case available
        /// Le serveur ne sert pas la route, Slack n'est pas lisible, ou le jeton n'est pas
        /// celui du propriétaire : rien n'est montré.
        case absent
    }

    @Published public private(set) var availability: Availability = .unknown
    /// Les canaux de l'espace, par nom (ordre du serveur).
    @Published public private(set) var conversations: [WorkstationSlackConversation] = []
    /// Le dernier échec de lecture, effacé par la prochaine lecture réussie.
    @Published public private(set) var failure: HarnessFailure?
    /// Les canaux dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []

    weak var harness: HarnessModel?

    init(harness: HarnessModel?) {
        self.harness = harness
    }

    /// Relit la liste (le serveur la relit en direct chez Slack).
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        let call = HarnessCall(method: "GET", path: "/v1/workstation/channels/slack/conversations")
        do {
            let reply = try await harness.exchange(call)
            if reply.status == 404 || reply.status == 409 {
                clear(.absent)
                return
            }
            let read: WorkstationSlackConversationsReply = try harness.decode(reply, for: call)
            conversations = read.conversations
            availability = .available
            failure = nil
        } catch HarnessFailure.forbidden {
            clear(.absent)
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Coche ou décoche un canal suivi (appareil approbateur) ; la ligne prend la réponse du serveur.
    public func setFollowed(_ id: String, _ followed: Bool) async throws {
        guard let harness, harness.isConfigured else { throw HarnessFailure.unreachable }
        guard let encoded = try? JSONEncoder().encode(FollowBody(followed: followed)) else {
            throw HarnessFailure.unreadable
        }
        let call = HarnessCall(
            method: "PUT",
            path: "/v1/workstation/channels/slack/conversations/\(HarnessModel.pathComponent(id))",
            body: encoded
        )
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let reply: WorkstationSlackConversationReply = try harness.decode(try await harness.exchange(call), for: call)
            if let index = conversations.firstIndex(where: { $0.id == reply.conversation.id }) {
                conversations[index] = reply.conversation
            }
        } catch {
            if let failure = HarnessModel.failure(of: error) { throw failure }
            throw error
        }
    }

    /// `workstation_channel_follow` (un autre appareil a coché un canal) fait relire une liste déjà lue.
    func receive(_ names: [String]) {
        guard names.contains("workstation_channel_follow"), availability == .available else { return }
        Task { await refresh() }
    }

    /// Oublie la liste : le serveur a changé (ou a été oublié).
    func reset() {
        clear(.unknown)
        busy = []
    }

    private func clear(_ next: Availability) {
        availability = next
        conversations = []
        failure = nil
    }
}

/// `{followed}`.
private struct FollowBody: Encodable {
    var followed: Bool
}
