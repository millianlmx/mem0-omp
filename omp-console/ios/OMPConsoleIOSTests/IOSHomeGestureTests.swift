// Les preuves Swift des gestes de carte de l'Accueil (feature
// accueil-iphone-rangees-ecrasees-et-geste, BR-2) : `IOSHomeGestureModel` piloté
// par une doublure d'envoi suspendue (un Mac qui tarde), la table d'échec pure
// `IOSHomeContent.gestureFailure(_:error:)`, les gestes offerts par le tableau de
// bord et la recette `-home.recipe slowMac`.
//
// AC-6/AC-7 : un geste en vol n'envoie rien de plus. AC-8/AC-9 : seule « Valider
// les specs » demande confirmation. AC-10 : l'échec arrive sur la carte, en
// français, sans détail brut, et libère le bouton. AC-11 : aucun état de succès.

import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// Une erreur hors du client : la cause par défaut s'applique.
private struct ForeignError: Error {}

/// L'envoi d'un Mac qui tarde : chaque appel est compté puis suspendu jusqu'à
/// `finish(_:)`.
@MainActor
private final class GestureSendDouble {
    private(set) var keys: [IOSHomeGestureKey] = []
    private var pending: [CheckedContinuation<Void, Error>] = []

    var send: IOSHomeGestureModel.Send {
        { [self] key in
            keys.append(key)
            try await withCheckedThrowingContinuation { pending.append($0) }
        }
    }

    /// Le nombre d'appels encore suspendus.
    var waiting: Int { pending.count }

    func finish(_ result: Result<Void, Error>) {
        let resumed = pending
        pending = []
        for continuation in resumed { continuation.resume(with: result) }
    }
}

@MainActor
@Suite("accueil-iphone-rangees-ecrasees-et-geste — gestes")
struct IOSHomeGestureTests {
    private static let rawDetail = "/tmp/x pid 42 {\"a\":1}"
    private let resumeKey = IOSHomeGestureKey(cardId: "card-resume", gesture: .resume)
    private let specsKey = IOSHomeGestureKey(cardId: "card-specs", gesture: .validateSpecs)
    private let reviewKey = IOSHomeGestureKey(cardId: "card-review", gesture: .acceptReview)

    /// Laisse tourner la tâche d'envoi jusqu'à ce que `done` soit vrai.
    private func settle(_ done: () -> Bool) async {
        for _ in 0..<200 where !done() { await Task.yield() }
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-6 : « Reprendre » en vol ignore un second toucher jusqu'à la réponse")
    func resumeIgnoresSecondTapWhileInFlight() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(resumeKey, send: mac.send)
        model.tap(resumeKey, send: mac.send)
        #expect(model.inFlight == [resumeKey])
        await settle { mac.waiting == 1 }
        model.tap(resumeKey, send: mac.send)
        await settle { false }
        #expect(mac.keys == [resumeKey])
        #expect(model.inFlight == [resumeKey])
        #expect(model.specsConfirmation == nil)
        #expect(model.failures.isEmpty)

        // Une autre carte a sa propre clé : elle part pendant que la première attend.
        let other = IOSHomeGestureKey(cardId: "card-other", gesture: .resume)
        model.tap(other, send: mac.send)
        await settle { mac.waiting == 2 }
        #expect(model.inFlight == [resumeKey, other])

        mac.finish(.success(()))
        await settle { model.inFlight.isEmpty }
        #expect(model.inFlight.isEmpty)
        #expect(mac.keys == [resumeKey, other])
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-7 : « Valider les specs » confirmé puis en vol n'envoie aucune seconde requête")
    func confirmedSpecsIgnoresSecondTapWhileInFlight() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(specsKey, send: mac.send)
        #expect(model.specsConfirmation == specsKey.cardId)
        model.confirmSpecs(cardId: specsKey.cardId, send: mac.send)
        #expect(model.specsConfirmation == nil)
        #expect(model.inFlight == [specsKey])
        await settle { mac.waiting == 1 }

        model.tap(specsKey, send: mac.send)
        #expect(model.specsConfirmation == nil, "clé en vol : la confirmation ne se rouvre pas")
        model.confirmSpecs(cardId: specsKey.cardId, send: mac.send)
        await settle { false }
        #expect(mac.keys == [specsKey])
        #expect(model.inFlight == [specsKey])

        mac.finish(.success(()))
        await settle { model.inFlight.isEmpty }
        #expect(model.inFlight.isEmpty)
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-8 : toucher « Valider les specs » ouvre la confirmation sans rien envoyer")
    func specsTapAsksConfirmationWithoutSending() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(specsKey, send: mac.send)
        await settle { false }
        #expect(model.specsConfirmation == specsKey.cardId)
        #expect(mac.keys.isEmpty)
        #expect(model.inFlight.isEmpty)
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-8 : annuler la confirmation des specs n'envoie rien et ne montre rien")
    func cancelledSpecsSendNothing() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(specsKey, send: mac.send)
        model.cancelSpecs()
        await settle { false }
        #expect(model.specsConfirmation == nil)
        #expect(mac.keys.isEmpty)
        #expect(model.inFlight.isEmpty)
        #expect(model.failures.isEmpty)

        // Le bouton reste utilisable : un nouveau toucher rouvre la confirmation.
        model.tap(specsKey, send: mac.send)
        #expect(model.specsConfirmation == specsKey.cardId)
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-9 : « Reprendre » part sans confirmation")
    func resumeSendsWithoutConfirmation() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(resumeKey, send: mac.send)
        #expect(model.specsConfirmation == nil)
        await settle { mac.waiting == 1 }
        #expect(mac.keys == [resumeKey])
        mac.finish(.success(()))
        await settle { model.inFlight.isEmpty }
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-9 : « Accepter la revue » part sans confirmation")
    func reviewSendsWithoutConfirmation() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(reviewKey, send: mac.send)
        #expect(model.specsConfirmation == nil)
        #expect(model.inFlight == [reviewKey])
        await settle { mac.waiting == 1 }
        #expect(mac.keys == [reviewKey])
        mac.finish(.success(()))
        await settle { model.inFlight.isEmpty }
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-10 : l'échec arrive sur la carte du geste, en français, sans détail brut")
    func failureLandsOnItsCardWithoutRawDetail() async {
        let raw = Self.rawDetail
        func translated(_ failure: IOSMacFailure) -> String { IOSMacErrorText.message(for: failure) }
        let causes: [(Error, String?)] = [
            (ForeignError(), translated(.generic)),
            (ClientError.notConnected, translated(.macUnreachable)),
            (ClientError.transport(.unreachable(raw)), translated(.macUnreachable)),
            (ClientError.transport(.closed(raw)), translated(.macUnreachable)),
            (ClientError.incompatibleProtocol(local: 1, remote: 2), translated(.incompatibleProtocol(local: 1, remote: 2))),
            (ClientError.decoding(raw), translated(.generic)),
            (ClientError.api(.unauthorized), nil),
            (ClientError.api(.conflict(raw)), translated(.generic)),
            (ClientError.api(.notFound(raw)), translated(.generic)),
            (ClientError.api(.incompatibleProtocol(raw)), translated(.incompatibleProtocol(local: ConsoleAPI.protocolVersion, remote: nil))),
            (ClientError.api(.badRequest(raw)), translated(.generic)),
            (ClientError.api(.unavailable(raw)), translated(.serviceUnavailable)),
            (ClientError.api(.server(raw)), translated(.generic)),
            (ClientError.api(.decoding(raw)), translated(.generic)),
            (ClientError.api(.outdatedService(raw)), translated(.serviceOutdated)),
        ]
        let headlines: [(IOSHomeGesture, String)] = [
            (.validateSpecs, IOSHomeText.specsFailed),
            (.acceptReview, IOSHomeText.reviewFailed),
            (.resume, IOSHomeText.resumeFailed),
        ]
        for (gesture, headline) in headlines {
            for (error, cause) in causes {
                let message = IOSHomeContent.gestureFailure(gesture, error: error)
                #expect(message == cause.map { "\(headline) \($0)" }, "\(gesture) \(error)")
                for leak in ["/tmp", "pid", "{"] {
                    #expect(message?.contains(leak) != true, "\(gesture) \(error)")
                }
            }
        }

        // Par le modèle : le message se range sous la clé de la carte.
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()
        model.tap(resumeKey, send: mac.send)
        model.tap(specsKey, send: mac.send)
        model.confirmSpecs(cardId: specsKey.cardId, send: mac.send)
        await settle { mac.waiting == 2 }
        mac.finish(.failure(ClientError.api(.conflict(raw))))
        await settle { model.inFlight.isEmpty }
        #expect(model.failures[resumeKey] == "La pipeline n'a pas repris. " + IOSMacErrorText.message(for: .generic))
        #expect(model.failures[specsKey] == "Les specs n'ont pas été validées. " + IOSMacErrorText.message(for: .generic))
        #expect(model.failures.count == 2)
        #expect(model.inFlight.isEmpty)
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-10 : après un échec, le bouton redevient utilisable et un nouvel envoi efface le message")
    func failureFreesTheButton() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(resumeKey, send: mac.send)
        await settle { mac.waiting == 1 }
        mac.finish(.failure(ClientError.notConnected))
        await settle { model.inFlight.isEmpty }
        #expect(model.inFlight.isEmpty)
        #expect(model.failures[resumeKey] == "La pipeline n'a pas repris. " + IOSMacErrorText.message(for: .macUnreachable))

        model.tap(resumeKey, send: mac.send)
        #expect(model.failures[resumeKey] == nil)
        #expect(model.inFlight == [resumeKey])
        await settle { mac.waiting == 1 }
        #expect(mac.keys == [resumeKey, resumeKey])
        mac.finish(.success(()))
        await settle { model.inFlight.isEmpty }
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-10 : une révocation termine l'envoi sans message sur la carte")
    func unauthorizedShowsNoMessage() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(reviewKey, send: mac.send)
        await settle { mac.waiting == 1 }
        mac.finish(.failure(ClientError.api(.unauthorized)))
        await settle { model.inFlight.isEmpty }
        #expect(model.inFlight.isEmpty)
        #expect(model.failures.isEmpty)
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-11 : un geste accepté ne laisse aucun message")
    func successShowsNoMessage() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(resumeKey, send: mac.send)
        model.tap(specsKey, send: mac.send)
        model.confirmSpecs(cardId: specsKey.cardId, send: mac.send)
        await settle { mac.waiting == 2 }
        mac.finish(.success(()))
        await settle { model.inFlight.isEmpty }
        #expect(model.inFlight.isEmpty)
        #expect(model.failures.isEmpty)
        #expect(model.specsConfirmation == nil)
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-10 : l'échec et la confirmation s'effacent quand la carte n'offre plus le geste")
    func failureDisappearsWhenGestureNoLongerOffered() async {
        let model = IOSHomeGestureModel()
        let mac = GestureSendDouble()

        model.tap(resumeKey, send: mac.send)
        await settle { mac.waiting == 1 }
        mac.finish(.failure(ClientError.notConnected))
        await settle { model.inFlight.isEmpty }
        model.tap(specsKey, send: mac.send)
        #expect(model.failures[resumeKey] != nil)
        #expect(model.specsConfirmation == specsKey.cardId)

        model.retain([resumeKey, specsKey])
        #expect(model.failures[resumeKey] != nil)
        #expect(model.specsConfirmation == specsKey.cardId)

        model.retain([])
        #expect(model.failures.isEmpty)
        #expect(model.specsConfirmation == nil)
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-10 : la fixture offre un « Valider les specs », un « Accepter la revue » et un « Reprendre »")
    func offeredGesturesFollowTheDashboard() {
        guard case .dashboard(let dashboard) = IOSHomeRecipe.dashboard.homeState else {
            Issue.record("la recette dashboard doit rendre un tableau de bord")
            return
        }
        let offered = IOSHomeContent.offeredGestures(dashboard)
        #expect(offered.filter { $0.gesture == .validateSpecs }.count == 1)
        #expect(offered.filter { $0.gesture == .acceptReview }.count == 1)
        #expect(offered.filter { $0.gesture == .resume }.count == 1)
        #expect(offered.count == 3)

        let attentionIDs = Set(dashboard.attention.map(\.card.id))
        let runningIDs = Set(dashboard.running.map(\.id))
        for key in offered {
            if key.gesture == .resume {
                #expect(runningIDs.contains(key.cardId))
            } else {
                #expect(attentionIDs.contains(key.cardId))
            }
        }
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-6 (recette) : slowMac seule remplace l'envoi des gestes")
    func slowMacRecipeNeverAnswers() {
        #expect(IOSHomeRecipe.resolve(["-home.recipe", "slowMac"]) == .slowMac)
        let recipes: [IOSHomeRecipe] = [
            .dashboard, .firstRun, .loading, .ompMissing, .degraded, .answer, .contract, .longTitles, .slowMac,
        ]
        for recipe in recipes {
            #expect((recipe.gestureSend != nil) == (recipe == .slowMac), "\(recipe)")
        }
        guard case .dashboard = IOSHomeRecipe.slowMac.homeState else {
            Issue.record("la recette slowMac doit rendre le tableau de bord de la fixture")
            return
        }
    }
}
