// L'APPAIRAGE PAR QR CODE, côté client (omp-harness pairing.ts, capacité `pairing-ticket`).
//
// Le Mac, relié au serveur, crée un ticket à usage unique (`createPairInvite`) et l'affiche en QR code :
// le lien `ompconsole://pair?u=<adresse du serveur>&t=<ticket>`. L'appareil photo de l'iPhone l'ouvre dans
// l'app, qui demande confirmation en nommant le serveur, puis échange le ticket (`pair(with:)`) CONTRE le
// jeton d'un client nommé à elle, qu'elle enregistre comme le fait le collage d'un code `omp1:`.
//
// L'échange est le seul appel SANS jeton de ce client : l'appareil n'en a pas encore, le ticket EST le
// secret. Il vit ici, avec le chemin de la route publique, hors de `HarnessModel.swift`.

import ConsoleCore
import Foundation

/// Le lien d'un QR code d'appairage : l'adresse du serveur (normalisée) et le ticket.
public struct HarnessPairLink: Equatable, Sendable {
    /// Le serveur à rejoindre, tel que `HarnessModel.normalizedAddress` l'écrit.
    public let address: String
    public let ticket: String

    /// L'hôte du lien : `ompconsole://pair`.
    public static let host = "pair"
    /// La route publique qui échange un ticket contre un jeton.
    static let redeemPath = "/v1/pair/redeem"
    private static let addressField = "u"
    private static let ticketField = "t"

    /// `nil` si l'adresse n'est pas une adresse http(s) ou si le ticket est vide ou contient un blanc.
    public init?(address: String, ticket: String) {
        guard let normalized = HarnessModel.normalizedAddress(address), Self.isTicket(ticket) else { return nil }
        self.address = normalized
        self.ticket = ticket
    }

    /// Le lien d'un QR code. Les deux valeurs sont encodées en pourcentage (l'adresse porte `:` et `/`).
    public var url: URL {
        var components = URLComponents()
        components.scheme = HarnessWidgetLink.scheme
        components.host = Self.host
        components.percentEncodedQuery =
            "\(Self.addressField)=\(HarnessModel.queryValue(address))&\(Self.ticketField)=\(HarnessModel.queryValue(ticket))"
        return components.url ?? URL(fileURLWithPath: "/")
    }

    /// Analyse un lien. `nil` pour un autre schéma ou un autre hôte, une adresse ou un ticket vide ou
    /// invalide, ou un champ répété (deux adresses : on ne devine pas laquelle l'humain verrait).
    public init?(url: URL) {
        guard Self.isPairLink(url), let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let items = components.queryItems ?? []
        let addresses = items.filter { $0.name == Self.addressField }
        let tickets = items.filter { $0.name == Self.ticketField }
        guard addresses.count == 1, tickets.count == 1,
              let address = addresses[0].value, let ticket = tickets[0].value
        else { return nil }
        self.init(address: address, ticket: ticket)
    }

    /// Le lien vise l'appairage (`ompconsole://pair…`), valide ou non : l'app dit alors qu'il est illisible
    /// au lieu de l'ignorer, et le Mac, qui n'appaire jamais ainsi, l'ignore.
    public static func isPairLink(_ url: URL) -> Bool {
        url.scheme?.lowercased() == HarnessWidgetLink.scheme && url.host?.lowercased() == host
    }

    private static func isTicket(_ text: String) -> Bool {
        !text.isEmpty && !text.contains(where: \.isWhitespace)
    }
}

/// La mémoire du projet que le créateur joint à un ticket (`{url, token}`) : l'iPhone la lit comme
/// celle d'un code `omp1:`. Le serveur ne la garde qu'en mémoire vive, jusqu'à l'échange.
public struct HarnessPairMemory: Codable, Equatable, Sendable {
    public var url: String
    public var token: String

    public init(url: String, token: String) {
        self.url = url
        self.token = token
    }
}

/// Un ticket créé : le lien à mettre en QR code et son échéance.
public struct HarnessPairInvite: Equatable, Sendable {
    public var link: HarnessPairLink
    /// L'échéance sur l'horloge de CET appareil : l'instant de la réponse plus la durée de vie annoncée.
    /// La date du serveur n'est pas lue (deux horloges ne s'accordent pas) ; l'échéance exacte reste celle du serveur.
    public var expiresAt: Date
    /// Le futur appareil approuvera les envois du poste.
    public var approver: Bool

    public init(link: HarnessPairLink, expiresAt: Date, approver: Bool) {
        self.link = link
        self.expiresAt = expiresAt
        self.approver = approver
    }

    /// Les secondes restantes à `now`, jamais négatives.
    public func secondsLeft(at now: Date) -> Int { max(0, Int(expiresAt.timeIntervalSince(now).rounded(.up))) }

    public func isExpired(at now: Date) -> Bool { secondsLeft(at: now) == 0 }
}

/// `POST /v1/pair/tickets` : `{ticket, expiresAt, ttlSec, approver}`.
struct HarnessPairTicket: Decodable {
    var ticket: String
    var ttlSec: Int
    var approver: Bool
}

private struct PairTicketBody: Encodable {
    var label: String?
    var approver: Bool
    var memory: HarnessPairMemory?
}

private struct RedeemBody: Encodable {
    var ticket: String
}

/// `POST /v1/pair/redeem` : le client nommé créé, son jeton et la mémoire jointe.
private struct HarnessRedeemed: Decodable {
    var client: HarnessClient
    var token: String
    var memory: HarnessPairMemory?
}

/// Ce qui a empêché l'échange d'un ticket — jamais un texte : les mots sont ceux de `PairingText`.
public enum HarnessPairFailure: Error, Equatable, Sendable {
    /// Le lien n'est pas un lien d'appairage complet.
    case invalidLink
    /// Ticket inconnu, périmé ou déjà échangé (401).
    case ticketRefused
    /// Trop d'échanges refusés (429).
    case tooManyAttempts
    /// Le serveur ne sait pas appairer par ticket (404).
    case unsupported
    /// Le serveur ne peut pas créer le client (409) ou a refusé autrement ; son motif.
    case serverRefused(String)
    /// Le ticket est consommé, mais l'appareil n'a pas pu rejoindre le serveur.
    case joinFailed
    /// Le serveur ne répond pas, ou pas à temps, ou répond ce que cette version ne lit pas.
    case transport(HarnessFailure)

    /// La cause, puis le remède, au vouvoiement.
    public var message: String {
        switch self {
        case .invalidLink: PairingText.invalidLink
        case .ticketRefused: PairingText.ticketRefused
        case .tooManyAttempts: PairingText.tooManyAttempts
        case .unsupported: PairingText.unsupported
        case .serverRefused(let motive): PairingText.serverRefused(motive)
        case .joinFailed: PairingText.joinFailed
        case .transport(let failure): failure.message
        }
    }
}

/// Le résultat d'un appairage, tel que l'écran le dit.
public enum HarnessPairOutcome: Equatable, Sendable {
    /// L'appareil est relié à ce serveur.
    case paired(address: String)
    case failed(HarnessPairFailure)

    /// Le texte que l'écran montre.
    public var message: String {
        switch self {
        case .paired(let address): PairingText.success(address: address)
        case .failed(let failure): failure.message
        }
    }
}

extension HarnessModel {
    /// Le serveur annonce l'appairage par ticket (`GET /v1/health`, `features`), et ce client peut en
    /// créer : un admin qui voit tous les dépôts. Le serveur tranche en dernier (403).
    public var canCreatePairInvite: Bool {
        isConfigured && health?.features.contains(Self.pairingFeature) == true && isAdmin && client?.repos == nil
    }

    /// Le client de l'app est lui-même approbateur : lui seul peut appairer un approbateur (403 sinon).
    public var canPairApprover: Bool { client?.approver == true }

    /// Le nom de la capacité dans `features`.
    nonisolated static let pairingFeature = "pairing-ticket"

    /// Crée un ticket à usage unique (10 minutes) et rend son lien. `label` nomme l'appareil (40 caractères
    /// au plus, vide : le serveur choisit) ; `approver` fait de l'appareil un approbateur (refusé par le
    /// serveur si ce client ne l'est pas) ; `memory` est la mémoire du projet que l'appareil recevra.
    /// Lève l'échec du serveur (`forbidden` pour un client qui n'a pas le droit, `rejected` quand dix
    /// tickets attendent déjà).
    public func createPairInvite(
        label: String, approver: Bool = false, memory: HarnessPairMemory? = nil, now: Date = Date()
    ) async throws -> HarnessPairInvite {
        guard isConfigured, let address else { throw HarnessFailure.unreachable }
        let name = String(label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        let created: HarnessPairTicket
        do {
            created = try await write(
                "POST", "/v1/pair/tickets",
                body: PairTicketBody(label: name.isEmpty ? nil : name, approver: approver, memory: memory)
            )
        } catch HarnessFailure.approverOnly {
            // Le refus d'appairer un approbateur porte le marqueur des gestes du poste : sa phrase parlerait d'approuver un envoi.
            throw HarnessFailure.forbidden(PairingText.approverDenied)
        }
        guard let link = HarnessPairLink(address: address, ticket: created.ticket) else { throw HarnessFailure.unreadable }
        return HarnessPairInvite(link: link, expiresAt: now.addingTimeInterval(TimeInterval(created.ttlSec)), approver: created.approver)
    }

    /// Échange le ticket d'un lien contre le jeton d'un client NOMMÉ neuf (sans `Authorization`), puis relie
    /// l'app comme le collage d'un code `omp1:` : adresse du lien, jeton reçu au trousseau, mémoire reçue à
    /// `onPaired`. Un client approbateur reçoit son jeton comme jeton d'app. À n'appeler qu'APRÈS la
    /// confirmation de l'humain : un lien ne doit jamais relier l'appareil à un serveur qu'il n'a pas vu.
    @discardableResult
    public func pair(with link: HarnessPairLink) async -> HarnessPairOutcome {
        guard let base = URL(string: link.address), let body = try? JSONEncoder().encode(RedeemBody(ticket: link.ticket)) else {
            return .failed(.invalidLink)
        }
        let call = HarnessCall(method: "POST", path: HarnessPairLink.redeemPath, body: body, authenticated: false)
        let reply: HarnessReply
        do {
            reply = try await transport.send(call, server: HarnessServer(baseURL: base, token: ""))
        } catch {
            return .failed(.transport(Self.failure(of: error) ?? .unreachable))
        }
        let redeemed: HarnessRedeemed
        switch reply.status {
        case 200:
            guard let decoded = try? JSONDecoder().decode(HarnessRedeemed.self, from: reply.body), !decoded.token.isEmpty else {
                return .failed(.transport(.unreadable))
            }
            redeemed = decoded
        case 401: return .failed(.ticketRefused)
        case 429: return .failed(.tooManyAttempts)
        case 404: return .failed(.unsupported)
        default:
            let motive = (try? JSONDecoder().decode(HarnessErrorBody.self, from: reply.body))?.error ?? ""
            return .failed(.serverRefused(motive))
        }
        // Un approbateur n'a qu'UN jeton, celui de l'approbateur : l'ordinaire reste vide pour que
        // `writeShared` (Mac) n'écrive jamais l'approbateur dans ~/.omp.
        let approver = redeemed.client.approver
        let pairing = HarnessPairing(
            address: link.address, token: approver ? "" : redeemed.token,
            memoryAddress: redeemed.memory?.url ?? "", memoryToken: redeemed.memory?.token ?? "",
            approverToken: approver ? redeemed.token : nil
        )
        guard await connect(pairing: pairing, address: link.address, token: "") else { return .failed(.joinFailed) }
        return .paired(address: link.address)
    }
}
