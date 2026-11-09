// Les PREUVES d'une feature vues par les apps (onglet « Preuves » de sa page, Mac et
// iOS) : la liste servie par `GET /v1/runs/{id}/proofs`, rangée par tour de revue
// (`currentRound` d'omp-harness/proofs.ts), puis, dans un tour, les captures avant et
// après appariées par critère, les autres captures, les rapports de tests, les
// journaux et les vidéos. Le contenu d'une preuve (`/proofs/{n}`) se lit à la demande
// et se garde le temps de la page.
//
// Un serveur qui ne sert pas les preuves (404) cache l'onglet sans rien dire ; une
// réponse illisible ou un serveur injoignable se montre dans l'onglet.

import Foundation

/// Les preuves d'une feature découpées en tours de revue : le tour COURANT (depuis le
/// début de la dernière étape d'implémentation ou de correction), puis les tours
/// précédents, jamais mêlés.
public struct HarnessProofRounds: Equatable, Sendable {
    public var current: HarnessProofRound
    public var previous: HarnessProofRound

    /// Le découpage de `currentRound` (omp-harness/proofs.ts) : `start` est le début de
    /// la DERNIÈRE étape `impl` ou `fix` de la frise ; le tour courant prend les preuves
    /// de `createdAt ≥ start`. Sans frise, ou sans étape d'implémentation ni de
    /// correction, tout forme un seul tour.
    public init(proofs: [HarnessProof], steps: [HarnessTimelineStep]?) {
        let ordered = proofs.sorted { $0.n < $1.n }
        let start = steps?.last { $0.kind == "impl" || $0.kind == "fix" }?.startedAt
        guard let start else {
            current = HarnessProofRound(ordered)
            previous = HarnessProofRound([])
            return
        }
        current = HarnessProofRound(ordered.filter { $0.createdAt >= start })
        previous = HarnessProofRound(ordered.filter { $0.createdAt < start })
    }
}

/// Un avant/après : les captures d'un même critère prises sur la base et sur la feature.
public struct HarnessProofPair: Equatable, Sendable, Identifiable {
    /// Le critère (`AC-n`).
    public var acRef: String
    public var before: HarnessProof?
    public var after: HarnessProof?

    public var id: String { acRef }

    public init(acRef: String, before: HarnessProof? = nil, after: HarnessProof? = nil) {
        self.acRef = acRef
        self.before = before
        self.after = after
    }
}

/// Les preuves d'un tour, rangées pour l'écran.
public struct HarnessProofRound: Equatable, Sendable {
    /// Toutes les preuves du tour, dans l'ordre de leur rang.
    public var proofs: [HarnessProof]
    /// Les captures portant un critère et un côté, appariées par critère (ordre du premier rang).
    public var pairs: [HarnessProofPair]
    /// Les autres captures, en vignettes.
    public var captures: [HarnessProof]
    /// Les rapports de tests (`test_report`), au plus un par étape.
    public var reports: [HarnessProof]
    public var logs: [HarnessProof]
    public var videos: [HarnessProof]

    public var isEmpty: Bool { proofs.isEmpty }

    public init(_ proofs: [HarnessProof]) {
        self.proofs = proofs
        var pairs: [HarnessProofPair] = []
        var captures: [HarnessProof] = []
        for proof in proofs where proof.kind == "screenshot" {
            guard let acRef = proof.acRef, let side = proof.side, side == "before" || side == "after" else {
                captures.append(proof)
                continue
            }
            var pair = pairs.first { $0.acRef == acRef } ?? HarnessProofPair(acRef: acRef)
            // La dernière capture d'un côté remplace la précédente : l'agent a repris sa capture.
            if side == "before" { pair.before = proof } else { pair.after = proof }
            if let index = pairs.firstIndex(where: { $0.acRef == acRef }) {
                pairs[index] = pair
            } else {
                pairs.append(pair)
            }
        }
        self.pairs = pairs
        self.captures = captures
        reports = proofs.filter { $0.kind == "test_report" }
        logs = proofs.filter { $0.kind == "log" }
        videos = proofs.filter { $0.kind == "video" }
    }
}

extension HarnessProof {
    /// Une capture se montre en image (PNG ou JPEG).
    public var isImage: Bool { kind == "screenshot" }
}

/// Ce que l'onglet « Preuves » a lu du serveur.
public enum HarnessProofsAvailability: Equatable, Sendable {
    /// La lecture est en cours : l'onglet n'est pas encore montré.
    case loading
    /// Le serveur ne sert pas les preuves (404) : pas d'onglet, aucune erreur.
    case absent
    /// La lecture a échoué (réponse illisible, serveur injoignable) : l'onglet le dit.
    case failed(HarnessFailure)
    case loaded(HarnessProofRounds)
}

/// Les preuves d'UNE feature, pour sa page : la liste découpée en tours, et le contenu
/// de chaque preuve lu une fois.
@MainActor
public final class HarnessRunProofs: ObservableObject {
    public let runId: String
    @Published public private(set) var availability: HarnessProofsAvailability = .loading
    /// Le contenu lu, par rang ; `nil` tant qu'il n'est pas lu.
    @Published public private(set) var contents: [Int: HarnessProofContent] = [:]

    private let harness: HarnessModel
    private var reading: Set<Int> = []

    public init(harness: HarnessModel, runId: String) {
        self.harness = harness
        self.runId = runId
    }

    /// L'onglet existe : le serveur sert les preuves (une lecture en échec se montre).
    public var showsTab: Bool {
        switch availability {
        case .loading, .absent: false
        case .failed, .loaded: true
        }
    }

    /// La lecture est tranchée : servie, absente ou en échec.
    public var isResolved: Bool { availability != .loading }

    /// Relit la liste et la frise. Une frise illisible n'empêche rien : tout forme un tour.
    public func load() async {
        do {
            guard let listed = try await harness.proofs(runId: runId) else {
                availability = .absent
                return
            }
            let timeline = await harness.timeline(runId: runId)
            availability = .loaded(HarnessProofRounds(proofs: listed.proofs, steps: timeline?.steps))
        } catch {
            guard let failure = HarnessModel.failure(of: error) else { return }
            availability = .failed(failure)
        }
    }

    /// Lit le contenu d'une preuve, une seule fois par rang.
    public func read(_ proof: HarnessProof) async {
        guard contents[proof.n] == nil, !reading.contains(proof.n) else { return }
        reading.insert(proof.n)
        defer { reading.remove(proof.n) }
        do {
            guard let data = try await harness.proofContent(runId: runId, n: proof.n) else {
                contents[proof.n] = .missing
                return
            }
            contents[proof.n] = HarnessProofContent(proof: proof, data: data)
        } catch {
            guard let failure = HarnessModel.failure(of: error) else { return }
            contents[proof.n] = .failed(failure)
        }
    }
}

/// Le contenu lu d'une preuve, selon sa sorte.
public enum HarnessProofContent: Equatable, Sendable {
    /// Les octets d'une image (capture), à décoder par la vue.
    case image(Data)
    case text(String)
    case report(HarnessTestReport)
    /// Une vidéo : rien à montrer dans l'onglet, sa taille seulement.
    case video
    /// Le serveur ne connaît plus cette preuve (404).
    case missing
    /// Un contenu que cette version ne sait pas lire.
    case unreadable
    case failed(HarnessFailure)

    /// Le contenu d'une preuve d'après sa sorte.
    public init(proof: HarnessProof, data: Data) {
        switch proof.kind {
        case "screenshot": self = .image(data)
        case "log": self = String(data: data, encoding: .utf8).map(Self.text) ?? .unreadable
        case "test_report": self = (try? JSONDecoder().decode(HarnessTestReport.self, from: data)).map(Self.report) ?? .unreadable
        case "video": self = .video
        default: self = .unreadable
        }
    }
}

extension HarnessRun {
    /// La feature attend la validation de sa REVUE (un verdict, pas des specs).
    public var awaitsVerdict: Bool { phase == .awaitingHuman && !awaitsSpecs }
}

/// L'onglet d'ouverture de la page d'une feature, commun au Mac et à l'iPhone.
public enum HarnessRunOpening: Equatable, Sendable {
    case proofs, overview, live

    /// Les preuves quand la feature attend la validation de sa revue et que le serveur
    /// les sert ; l'Aperçu quand elle vous attend autrement ; le Direct quand elle tourne.
    public static func of(_ run: HarnessRun, pending: Bool, running: Bool, proofsShown: Bool) -> HarnessRunOpening {
        if run.awaitsVerdict, proofsShown { return .proofs }
        if pending { return .overview }
        return running ? .live : .overview
    }
}
