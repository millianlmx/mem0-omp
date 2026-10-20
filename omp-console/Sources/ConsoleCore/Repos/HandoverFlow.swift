// La bascule d'un dépôt d'une machine à l'autre (S-5 de orchestrator-living-in-a-vps),
// orchestrée par le CLIENT : aucun appel de serveur à serveur.
//
//   1. `handover` sur la source : elle gèle le dépôt (plus aucune feature
//      démarrée) et rend les features pas encore démarrées ;
//   2. `adopt` sur la cible : elle trouve (ou clone) le dépôt et lance ces features ;
//   3. `commit` sur la source avec les features réellement lancées : elle les retire.
//
// Un échec en 2 rouvre la source (`cancel`). Un échec en 3 laisse la cible
// DÉMARRÉE : annuler est alors impossible, on réessaie le retrait (3 nouvelles
// tentatives à 2 s) puis on demande à l'utilisateur de terminer la bascule.
// Invariant : entre 1 et 3 la source ne démarre rien ; une feature n'est jamais
// conduite par deux machines.
//
// Pure : le transport est un protocole, l'attente est injectée.

import Foundation

/// Une feature en route vers l'autre machine (miroir de `HandoverFeature`, handover.ts).
public struct HandoverFeatureCharge: Codable, Equatable, Sendable {
    public var slug: String
    public var description: String
    public var deps: [String]?
    public var modelReqSpecs: String?
    public var modelImplReview: String?

    public init(slug: String, description: String, deps: [String]? = nil, modelReqSpecs: String? = nil, modelImplReview: String? = nil) {
        self.slug = slug
        self.description = description
        self.deps = deps
        self.modelReqSpecs = modelReqSpecs
        self.modelImplReview = modelImplReview
    }
}

/// La charge rendue par `handover` sur la source.
public struct HandoverCharge: Codable, Equatable, Sendable {
    public var id: String
    public var identity: String
    public var features: [HandoverFeatureCharge]

    public init(id: String, identity: String, features: [HandoverFeatureCharge]) {
        self.id = id
        self.identity = identity
        self.features = features
    }
}

/// Un refus d'une feature par la cible.
public struct HandoverRefusal: Codable, Equatable, Sendable {
    public var slug: String
    public var reason: String

    public init(slug: String, reason: String) {
        self.slug = slug
        self.reason = reason
    }
}

/// Ce que la cible rend à `adopt`.
public struct HandoverAdoption: Codable, Equatable, Sendable {
    public var repoKey: String
    public var repoRoot: String
    public var cloned: Bool
    public var launched: [String]
    public var refused: [HandoverRefusal]

    public init(repoKey: String, repoRoot: String, cloned: Bool, launched: [String], refused: [HandoverRefusal]) {
        self.repoKey = repoKey
        self.repoRoot = repoRoot
        self.cloned = cloned
        self.launched = launched
        self.refused = refused
    }
}

/// Un échec de geste : le MOTIF du refus du serveur, tel quel.
public struct HandoverFailure: Error, Equatable, Sendable {
    public var message: String

    public init(_ message: String) {
        self.message = message
    }
}

/// Les quatre gestes d'une machine ; chaque coque en fournit une implémentation
/// (service local du Mac, client distant du VPS).
public protocol HandoverEndpoint: Sendable {
    func handover(repoKey: String, to: RepoMachine) async throws -> HandoverCharge
    func adopt(identity: String, features: [HandoverFeatureCharge]) async throws -> HandoverAdoption
    func commit(repoKey: String, handoverId: String, slugs: [String]) async throws
    func cancel(repoKey: String, handoverId: String) async throws
}

/// Une bascule dont le retrait final a échoué : de quoi le refaire.
public struct PendingHandover: Codable, Equatable, Sendable {
    public var from: RepoMachine
    public var to: RepoMachine
    public var name: String
    public var identity: String
    public var repoKey: String
    public var handoverId: String
    public var launched: [String]
    public var message: String

    public init(from: RepoMachine, to: RepoMachine, name: String, identity: String, repoKey: String, handoverId: String, launched: [String], message: String) {
        self.from = from
        self.to = to
        self.name = name
        self.identity = identity
        self.repoKey = repoKey
        self.handoverId = handoverId
        self.launched = launched
        self.message = message
    }
}

public enum HandoverOutcome: Equatable, Sendable {
    /// La bascule est terminée : `launched` features démarrent sur la cible.
    case completed(launched: Int, refused: [HandoverRefusal])
    /// La bascule a échoué AVANT le démarrage de la cible et la source est rouverte.
    case failed(String)
    /// La cible a démarré, le retrait a échoué : « bascule à terminer ».
    case toFinish(PendingHandover)
}

public struct HandoverFlow: Sendable {
    /// Le retrait final : une tentative, puis 3 reprises espacées de 2 s.
    public static let commitRetries = 3
    public static let retryDelaySeconds = 2.0

    private let source: any HandoverEndpoint
    private let target: any HandoverEndpoint
    private let sleep: @Sendable (Double) async -> Void

    public init(
        source: any HandoverEndpoint,
        target: any HandoverEndpoint,
        sleep: @escaping @Sendable (Double) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) {
        self.source = source
        self.target = target
        self.sleep = sleep
    }

    /// Confie `repoKey` (clé du dépôt sur la source) à `to`.
    public func run(from: RepoMachine, to: RepoMachine, repoKey: String, name: String) async -> HandoverOutcome {
        let charge: HandoverCharge
        do {
            charge = try await source.handover(repoKey: repoKey, to: to)
        } catch {
            return .failed(Self.message(error))
        }
        let adoption: HandoverAdoption
        do {
            adoption = try await target.adopt(identity: charge.identity, features: charge.features)
        } catch {
            // Rien n'a démarré sur la cible : la source est rouverte.
            let reason = Self.message(error)
            do {
                try await source.cancel(repoKey: repoKey, handoverId: charge.id)
            } catch {
                return .failed("\(reason) — la source n’a pas pu être rouverte\u{00A0}: \(Self.message(error))")
            }
            return .failed(reason)
        }
        let pending = PendingHandover(
            from: from, to: to, name: name, identity: charge.identity, repoKey: repoKey,
            handoverId: charge.id, launched: adoption.launched, message: ""
        )
        return await finish(pending, refused: adoption.refused)
    }

    /// Le geste « Réessayer » : refaire le retrait final.
    public func finish(_ pending: PendingHandover, refused: [HandoverRefusal] = []) async -> HandoverOutcome {
        var lastMessage = ""
        for attempt in 0...Self.commitRetries {
            if attempt > 0 { await sleep(Self.retryDelaySeconds) }
            do {
                try await source.commit(repoKey: pending.repoKey, handoverId: pending.handoverId, slugs: pending.launched)
                return .completed(launched: pending.launched.count, refused: refused)
            } catch {
                lastMessage = Self.message(error)
            }
        }
        var failed = pending
        failed.message = lastMessage
        return .toFinish(failed)
    }

    /// Le geste « Annuler la bascule » (état « en cours » seulement) : rouvre la source.
    public func cancel(repoKey: String, handoverId: String) async -> Result<Void, HandoverFailure> {
        do {
            try await source.cancel(repoKey: repoKey, handoverId: handoverId)
            return .success(())
        } catch {
            return .failure(HandoverFailure(Self.message(error)))
        }
    }

    private static func message(_ error: Error) -> String {
        if let failure = error as? HandoverFailure { return failure.message }
        if let described = (error as? LocalizedError)?.errorDescription { return described }
        return String(describing: error)
    }
}
