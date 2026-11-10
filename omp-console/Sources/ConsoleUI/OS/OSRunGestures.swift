// L'« OS agentique » : ce que l'humain peut FAIRE d'une feature, selon son état, son rôle
// et ce que le serveur relié annonce (`GET /v1/health`, `features`). Une capacité absente
// retire le geste : ni bouton mort, ni erreur. Lu par la carte de décision, la page d'un
// fil et l'arrêt avec son motif.

import ConsoleClient
import ConsoleCore
import Foundation

/// Les capacités du serveur dont dépendent les gestes de cette tranche.
enum OSCapability {
    /// Corriger, motif d'un arrêt, modules d'une feature en file.
    static let loop = "os-loop"
    /// Curseur d'autonomie, « Toujours ainsi », règle de palier écrite depuis une carte.
    static let autonomy = "os-autonomy"
    /// Le gabarit d'une feature (« Refaire »).
    static let proposals = "proposals"
    /// La pause globale (« Reprendre » d'une feature retenue par elle).
    static let pause = "pause"
}

/// La règle de palier qu'écrit « Toujours valider seul … » : le type de la feature, sa
/// porte en attente, son dépôt.
struct OSAlwaysRule: Equatable {
    var repo: String
    var kind: HarnessWorkKind
    var gate: HarnessAutonomyGate
}

/// Les gestes permis sur une feature.
struct OSRunGestures: Equatable {
    /// « Corriger… » : une consigne qui corrige la feature là où elle est.
    var amend = false
    /// « Arrêter… »
    var stop = false
    /// L'arrêt propose ses motifs et sa note (sinon une simple confirmation).
    var causes = false
    /// Le menu « Refaire » d'une feature finie.
    var redo = false
    /// Le curseur d'autonomie.
    var autonomy = false
    /// « Restreindre les modules… » d'une feature en file.
    var modules = false
    /// « Toujours ainsi » à côté d'une réponse ou d'une correction.
    var always = false
    /// « Toujours valider seul … » : `nil` hors d'une porte, sans type, ou sans droit d'administrer.
    var rule: OSAlwaysRule?

    /// `features` : les capacités annoncées par le serveur. Un lecteur (`canAct` faux) n'a aucun geste.
    static func of(_ run: HarnessRun, canAct: Bool, isAdmin: Bool, features: Set<String>) -> OSRunGestures {
        guard canAct, let phase = run.phase else { return OSRunGestures() }
        let loop = features.contains(OSCapability.loop)
        let autonomy = features.contains(OSCapability.autonomy)
        let live = [.queued, .running, .escalated, .awaitingHuman].contains(phase)
        var gestures = OSRunGestures()
        // Sans `os-loop`, corriger passe par les gestes d'avant (refus d'une porte, consigne),
        // qui ne relancent pas une feature en échec.
        gestures.amend = live || (loop && phase == .failed)
        gestures.stop = live
        gestures.causes = loop
        gestures.redo = features.contains(OSCapability.proposals) && [.merged, .failed, .cancelled].contains(phase)
        gestures.autonomy = autonomy && live
        gestures.modules = loop && phase == .queued
        gestures.always = autonomy && live
        if isAdmin, autonomy, phase == .awaitingHuman, let kind = run.kind.flatMap(HarnessWorkKind.init(rawValue:)) {
            gestures.rule = OSAlwaysRule(repo: run.repo, kind: kind, gate: run.awaitsSpecs ? .specs : .review)
        }
        return gestures
    }
}

extension HarnessModel {
    /// Les capacités que le serveur relié annonce ; vide tant que sa santé n'est pas lue.
    var osFeatures: Set<String> { Set(health?.features ?? []) }

    /// Les gestes permis à ce jeton sur une feature.
    func osGestures(_ run: HarnessRun) -> OSRunGestures {
        OSRunGestures.of(run, canAct: canAct, isAdmin: isAdmin, features: osFeatures)
    }

    /// Lit la santé du serveur si elle ne l'est pas encore : les capacités en viennent.
    func osReadFeatures() async {
        if health == nil { await refreshServices() }
    }

    /// « Corriger » : `amend` quand le serveur l'annonce. Un serveur antérieur reçoit le geste
    /// d'avant qui fait la même chose : le refus motivé d'une porte, sinon une consigne.
    func osAmend(_ run: HarnessRun, text: String, always: Bool) async -> Bool {
        if osFeatures.contains(OSCapability.loop) {
            return await amend(runId: run.id, text: text, always: always) != nil
        }
        if run.phase == .awaitingHuman {
            return await validate(runId: run.id, approve: false, reason: text, always: always)
        }
        return await instruct(runId: run.id, text: text) != nil
    }
}
