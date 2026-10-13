// Les preuves du pilotage vocal des pipelines sur l'iPhone
// (siri-iphone-pilotage-pipelines, S-8, S-9, S-12) : un vrai `ConsoleClientModel`
// appairé et prêt, sur un Mac scripté (`IOSSiriMacDoubles.swift`) qui sert
// l'ardoise et accepte ou refuse chaque geste, face à une conversation scriptée.
// Chaque preuve passe par l'orchestration de l'intent (`IOSSiriPilot.perform` ou
// `IOSSiriPilot.launch`) ; l'intent complet ne s'exécute pas hors de Siri (D-4).
// Les attendus sont construits par les fonctions publiques du noyau vocal
// (`VoiceSpeechText`, `VoiceGestureText`, `VoiceIssue`, `VoicePilot`) et par les
// prédicats de l'app, jamais par un littéral recopié. AC-17 est la recette
// manuelle sur iPhone réel du README.

import AppIntents
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

// MARK: - Les dépôts et l'ardoise du Mac scripté

/// Le dépôt du lot vivant (`PendingJSON.repoRoot`), celui d'un lot au pilote
/// mort, et un troisième dépôt au lot vivant.
private let liveRoot = PendingJSON.repoRoot
private let deadRoot = "/tmp/siri/autre"
private let thirdRoot = "/tmp/siri/troisieme"

/// Une feature en cours de `slug` (pilote vivant ou non selon son lot).
private func runningFeature(_ slug: String) -> String {
    PendingJSON.feature(slug, state: "running", phase: "impl", sinceAt: PendingJSON.at(1))
}

/// Une feature en cours, pilote vivant : l'app n'offre que « Arrêter ».
private let stoppable = MacState().running("export-csv", at: PendingJSON.at(1))

/// Une feature dont le pilote est mort : l'app offre « Reprendre ».
private let resumable = MacState().lot(on: deadRoot, features: [runningFeature("reprise-auto")], pilotDead: true)

/// L'ardoise qui couvre tous les états : en cours, en échec, jalon specs, jalon
/// revue, pilote mort, run hors lot, et un troisième dépôt.
private let everyState = MacState()
    .running("export-csv", at: PendingJSON.at(1))
    .failed("cache-froid", at: PendingJSON.at(2))
    .milestone("specs-pretes", "specs", at: PendingJSON.at(3))
    .milestone("revue-prete", "review", at: PendingJSON.at(4))
    .lot(on: deadRoot, features: [runningFeature("reprise-auto")], pilotDead: true)
    .lot(on: thirdRoot, features: [runningFeature("tri-rapide")])
    .strayRun("aaaaaaaaaaaaaab1", at: PendingJSON.at(5))

/// L'ardoise que le Mac sert dans `state`, dérivée par un client à part comme
/// l'écran Pipelines : la source des attendus.
@MainActor
private func board(_ state: MacState) async throws -> KanbanBoard {
    let client = connect(state).client
    _ = try await client.store()
    return try #require(PipelinesModel.boardState(of: client, nowMs: Date().timeIntervalSince1970 * 1000)?.kanbanBoard)
}

/// La carte de la feature `slug` du dépôt `root`.
@MainActor
private func card(_ slug: String, root: String = liveRoot, in state: MacState) async throws -> KanbanCard {
    let id = PendingJSON.cardId(slug, root: root)
    return try #require(try await board(state).cards.first { $0.id == id })
}

/// Un geste joué de bout en bout sur un Mac prêt : rend la phrase finale et les
/// gestes POST émis. Le client est arrêté avant de rendre.
@MainActor
private func play(
    _ gesture: VoicePilotGesture?,
    on state: MacState,
    refusals: [String: MacRefusal] = [:],
    conversation: ScriptedConversation
) async throws -> (result: String, sent: [ClientHTTPRequest]) {
    let (client, transport) = connectReady(state, refusals: refusals)
    defer { client.stop() }
    let result: String
    if let gesture {
        result = try await IOSSiriPilot.perform(gesture, client: client, conversation: conversation, isProtectedDataAvailable: { true })
    } else {
        result = try await IOSSiriPilot.launch(client: client, conversation: conversation, isProtectedDataAvailable: { true })
    }
    return (result, posts(transport.requests))
}

/// Les métadonnées App Intents extraites au build, à la racine du `.app` (D-3).
private func actionsData() throws -> [String: Any] {
    let url = try #require(Bundle.main.url(forResource: "extract", withExtension: "actionsdata", subdirectory: "Metadata.appintents"))
    return try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
}

/// Les cinq intents du pilotage, avec leur geste de pilotage (nil : lancement).
private let pilotIntents: [(type: any VoiceGestureIntent.Type, pilot: VoicePilotGesture?)] = [
    (IOSLaunchFeatureIntent.self, nil),
    (IOSResumeFeatureIntent.self, IOSResumeFeatureIntent.pilotGesture),
    (IOSStopFeatureIntent.self, IOSStopFeatureIntent.pilotGesture),
    (IOSValidateSpecsIntent.self, IOSValidateSpecsIntent.pilotGesture),
    (IOSAcceptReviewIntent.self, IOSAcceptReviewIntent.pilotGesture),
]

// MARK: - Les preuves

@Suite("IOSSiriPilotTests")
@MainActor
struct IOSSiriPilotTests {
    @Test("siri-iphone-pilotage-pipelines/AC-1 : le lancement part en UN POST /v1/features au corps de la feuille aux modèles par défaut")
    func launchSendsTheSheetRequest() async throws {
        let cards = try await board(stoppable).cards
        let root = try #require(KanbanLaunchRepos.options(cards: cards, projectRoot: nil).first)
        let label = try #require(KanbanLaunchRepos.choices([root]).first?.label)
        let conversation = ScriptedConversation(answers: ["Export CSV", "Exporter la liste"], confirmations: [true])
        let (result, sent) = try await play(nil, on: stoppable, conversation: conversation)

        #expect(conversation.asks == [VoiceSpeechText.launchTitleAsk, VoiceSpeechText.launchNeedAsk], "un seul dépôt : aucune question de dépôt")
        #expect(conversation.confirms == [VoiceGestureText.launchConfirmation(title: "Export CSV", repo: label, need: "Exporter la liste")])
        #expect(result == VoiceIssue.sent(.launchPipeline, target: "Export CSV").phrase)
        try #require(sent.count == 1)
        #expect(sent[0].path == "/v1/features")
        let payload = body(sent[0])
        #expect(payload["repoRoot"] as? String == root)
        #expect(payload["title"] as? String == "Export CSV")
        #expect(payload["description"] as? String == "Exporter la liste")
        #expect(payload["modelReqSpecs"] == nil || payload["modelReqSpecs"] is NSNull)
        #expect(payload["modelImplReview"] == nil || payload["modelImplReview"] is NSNull)

        // Le corps que produit l'appel de la feuille quand ses deux sélecteurs
        // restent sur le choix par défaut.
        let (sheetClient, sheetTransport) = connect(stoppable)
        _ = try await sheetClient.launch(
            repoRoot: root, title: "Export CSV", description: "Exporter la liste", modelReqSpecs: nil, modelImplReview: nil
        )
        let sheet = try #require(posts(sheetTransport.requests).first)
        #expect(sheet.path == sent[0].path)
        #expect(NSDictionary(dictionary: body(sheet)) == NSDictionary(dictionary: payload))
    }

    @Test("siri-iphone-pilotage-pipelines/AC-2 : les dépôts énoncés sont exactement ceux de l'ardoise du Mac, sans question de modèle")
    func launchOffersTheMacRepos() async throws {
        let cards = try await board(everyState).cards
        let choices = KanbanLaunchRepos.choices(KanbanLaunchRepos.options(cards: cards, projectRoot: nil))
        try #require(choices.count == 3)
        let labels = choices.map(\.label)
        let conversation = ScriptedConversation(answers: [labels[1], "Tri rapide", "Trier plus vite"], confirmations: [false])
        let (_, sent) = try await play(nil, on: everyState, conversation: conversation)

        #expect(conversation.asks == [
            VoiceSpeechText.launchRepoAsk(labels: labels),
            VoiceSpeechText.launchTitleAsk,
            VoiceSpeechText.launchNeedAsk,
        ], "dépôt, titre, besoin : aucune autre question, aucune sur les modèles")
        #expect(conversation.confirms == [VoiceGestureText.launchConfirmation(title: "Tri rapide", repo: labels[1], need: "Trier plus vite")])
        #expect(sent.isEmpty)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-3 : la confirmation relit titre, dépôt et besoin dictés ; « non » n'envoie aucun POST")
    func declinedLaunchSendsNothing() async throws {
        let cards = try await board(stoppable).cards
        let root = try #require(KanbanLaunchRepos.options(cards: cards, projectRoot: nil).first)
        let label = try #require(KanbanLaunchRepos.choices([root]).first?.label)
        let conversation = ScriptedConversation(answers: ["  Export CSV ", "Exporter la liste "], confirmations: [false])
        let (result, sent) = try await play(nil, on: stoppable, conversation: conversation)

        #expect(conversation.confirms == [VoiceGestureText.launchConfirmation(title: "Export CSV", repo: label, need: "Exporter la liste")])
        #expect(result == VoiceGestureText.cancelled)
        #expect(sent.isEmpty, "aucune requête feature.launch")
    }

    @Test("siri-iphone-pilotage-pipelines/AC-5 : seule la feature reprenable est proposée, et POST …/resume part pour elle sans confirmation")
    func resumeOffersOnlyTheResumable() async throws {
        let state = MacState()
            .running("export-csv", at: PendingJSON.at(1))
            .lot(on: deadRoot, features: [runningFeature("reprise-auto")], pilotDead: true)
        let target = try await card("reprise-auto", root: deadRoot, in: state)
        let other = try await card("export-csv", in: state)
        try #require(KanbanActionPresentation.resumable(target))
        try #require(!KanbanActionPresentation.resumable(other) && !KanbanActionPresentation.relaunchable(other))

        let conversation = ScriptedConversation(answers: [target.title])
        let (result, sent) = try await play(.resume, on: state, conversation: conversation)

        #expect(conversation.asks == [VoiceSpeechText.pilotAsk(.resume, titles: [target.title], more: 0)])
        #expect(conversation.confirms.isEmpty)
        #expect(sent.map(\.path) == [cardPath("reprise-auto", "resume", root: deadRoot)])
        #expect(result == VoiceIssue.sent(.resume, target: target.title).phrase)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-7 : seule la feature arrêtable est proposée ; « Arrêter les pipelines de ‹dépôt› ? (feature ‹X›) » puis POST …/stop sur « oui », rien sur « non »")
    func stopConfirmsTheRepoWideEffect() async throws {
        let state = stoppable.strayRun("aaaaaaaaaaaaaab1", at: PendingJSON.at(5))
        let target = try await card("export-csv", in: state)
        let cards = try await board(state).cards
        try #require(cards.contains { $0.id.hasPrefix("run:") && !VoicePilot.shows(.stop, on: $0) }, "une carte que l'app ne permet pas d'arrêter")
        let confirmation = VoiceGestureText.stopConfirmation(repo: target.repo, feature: target.title)
        #expect(confirmation.hasPrefix(KanbanText.stopConfirmTitle(repo: target.repo)))

        let accepted = ScriptedConversation(answers: [target.title], confirmations: [true])
        let (result, sent) = try await play(.stop, on: state, conversation: accepted)
        #expect(accepted.asks == [VoiceSpeechText.pilotAsk(.stop, titles: [target.title], more: 0)])
        #expect(accepted.confirms == [confirmation])
        #expect(sent.map(\.path) == [cardPath("export-csv", "stop")])
        #expect(result == VoiceIssue.sent(.stopFeature, target: target.title).phrase)

        let declined = ScriptedConversation(answers: [target.title], confirmations: [false])
        let (cancelled, none) = try await play(.stop, on: state, conversation: declined)
        #expect(declined.confirms == [confirmation])
        #expect(cancelled == VoiceGestureText.cancelled)
        #expect(none.isEmpty)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-8 : specs et revue sont proposées chacune à son jalon, verdict « specs » puis « review » après « oui »")
    func verdictsFollowTheirMilestone() async throws {
        let state = MacState()
            .milestone("specs-pretes", "specs", at: PendingJSON.at(1))
            .milestone("revue-prete", "review", at: PendingJSON.at(2))
        let specs = try await card("specs-pretes", in: state)
        let review = try await card("revue-prete", in: state)

        let specsTalk = ScriptedConversation(answers: [specs.title], confirmations: [true])
        let (specsResult, specsSent) = try await play(.validateSpecs, on: state, conversation: specsTalk)
        #expect(specsTalk.asks == [VoiceSpeechText.pilotAsk(.validateSpecs, titles: [specs.title], more: 0)])
        #expect(specsTalk.confirms == [VoiceGestureText.confirmation(for: .validateSpecs, target: specs.title)])
        #expect(specsSent.map(\.path) == [cardPath("specs-pretes", "verdict")])
        #expect(specsSent.first.map(body)?["verdict"] as? String == IOSHomeText.verdictSpecs)
        #expect(specsResult == VoiceIssue.sent(.validateSpecs, target: specs.title).phrase)

        let reviewTalk = ScriptedConversation(answers: [review.title], confirmations: [true])
        let (reviewResult, reviewSent) = try await play(.acceptReview, on: state, conversation: reviewTalk)
        #expect(reviewTalk.asks == [VoiceSpeechText.pilotAsk(.acceptReview, titles: [review.title], more: 0)])
        #expect(reviewTalk.confirms == [VoiceGestureText.confirmation(for: .acceptReview, target: review.title)])
        #expect(reviewSent.map(\.path) == [cardPath("revue-prete", "verdict")])
        #expect(reviewSent.first.map(body)?["verdict"] as? String == IOSHomeText.verdictReview)
        #expect(reviewResult == VoiceIssue.sent(.acceptReview, target: review.title).phrase)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-9 : les intents de l'app sont les 7 attendus ; ceux de verdict n'émettent que « specs » ou « review »")
    func verdictIntentsArePositiveOnly() async throws {
        let actions = try #require(try actionsData()["actions"] as? [String: Any])
        let types: [Any.Type] = [
            IOSConnectionStatusIntent.self, IOSPendingRequestsIntent.self,
            IOSLaunchFeatureIntent.self, IOSResumeFeatureIntent.self, IOSStopFeatureIntent.self,
            IOSValidateSpecsIntent.self, IOSAcceptReviewIntent.self,
        ]
        let expected = Set(types.map { String(describing: $0) })
        #expect(Set(actions.keys) == expected)
        #expect(IOSValidateSpecsIntent.voiceGesture == .validateSpecs)
        #expect(IOSAcceptReviewIntent.voiceGesture == .acceptReview)

        var verdicts: [String] = []
        for gesture in [IOSValidateSpecsIntent.pilotGesture, IOSAcceptReviewIntent.pilotGesture] {
            let target = try #require(VoicePilot.eligible(gesture, in: try await board(everyState).cards).first)
            let (_, sent) = try await play(gesture, on: everyState, conversation: ScriptedConversation(answers: [target.title], confirmations: [true]))
            verdicts += sent.filter { $0.path.hasSuffix("/verdict") }.compactMap { body($0)["verdict"] as? String }
        }
        #expect(verdicts == [IOSHomeText.verdictSpecs, IOSHomeText.verdictReview])
    }

    @Test("siri-iphone-pilotage-pipelines/AC-11 : pour chaque geste, les features proposées sont exactement celles où l'app affiche le geste")
    func eligibilityMatchesTheAppButtons() async throws {
        let kanban = try await board(everyState)
        let cards = kanban.cards
        try #require(cards.count >= 6)
        let relaunched = Set(HomePresentation.dashboard(kanban).attention
            .filter { HomePresentation.cardAction($0) == .relaunch }
            .map(\.card.id))

        for gesture in VoicePilotGesture.allCases {
            let shown: Set<String> = Set(cards.filter { card in
                let gestures = PipelinesGesture.gestures(of: card)
                switch gesture {
                case .resume:
                    return gestures.contains(.resume) || relaunched.contains(card.id)
                case .stop:
                    return gestures.contains(.stop)
                case .validateSpecs:
                    return gestures.contains(.validateMilestone(kind: .specs))
                case .acceptReview:
                    return gestures.contains(.validateMilestone(kind: .review))
                }
            }.map(\.id))
            let proposed = Set(VoicePilot.eligible(gesture, in: cards).map(\.id))
            #expect(proposed == shown, "\(gesture)")
            #expect(!proposed.isEmpty && proposed.count < cards.count, "\(gesture) : la fixture distingue éligibles et non éligibles")
        }
    }

    @Test("siri-iphone-pilotage-pipelines/AC-12 : un refus 409 du Mac est énoncé avec sa cause, pas un message générique")
    func macRefusalSaysTheCause() async throws {
        let state = MacState().milestone("specs-pretes", "specs", at: PendingJSON.at(1))
        let target = try await card("specs-pretes", in: state)
        let motive = "ce jalon n'est pas attendu"
        let conversation = ScriptedConversation(answers: [target.title], confirmations: [true])
        let (result, sent) = try await play(
            .validateSpecs, on: state, refusals: [cardPath("specs-pretes", "verdict"): .conflict(motive)], conversation: conversation
        )
        #expect(sent.count == 1, "le geste est parti une fois, le Mac l'a refusé")
        #expect(result == VoiceIssue.macRefused(motive: motive).phrase)
        #expect(result.contains(motive))
    }

    @Test("siri-iphone-pilotage-pipelines/AC-13 : iPhone non appairé ou Mac injoignable → la cause est énoncée, aucun geste n'est envoyé, pour chacun des 5 gestes")
    func connectionCausesBlockEveryGesture() async throws {
        let mac = PendingMac([everyState])
        for (_, pilot) in pilotIntents {
            let unpairedTransport = ScriptedClientTransport { mac.respond($0) }
            let unpairedClient = ClientDoubles.model(transport: unpairedTransport, address: macAddress)
            let unpaired = try await run(pilot, client: unpairedClient)
            unpairedClient.stop()

            let silentTransport = ScriptedClientTransport { mac.respond($0) }
            let silentClient = ClientDoubles.pairedModel(
                tokens: CountingTokenStore(["dev-1": "tok-1"]), transport: silentTransport,
                address: macAddress, readinessPacer: ReturningPacer()
            )
            let unreachable = try await run(pilot, client: silentClient)
            silentClient.stop()

            #expect(unpaired == VoiceIssue.notPaired.phrase, "\(String(describing: pilot))")
            #expect(unreachable == VoiceIssue.macUnreachable.phrase, "\(String(describing: pilot))")
            #expect(posts(unpairedTransport.requests + silentTransport.requests).isEmpty)
        }
    }

    @Test("siri-iphone-pilotage-pipelines/AC-14 : iPhone verrouillé → déverrouillage exigé par l'intent, phrase « verrouillé » et ZÉRO requête")
    func lockedDeviceSendsNothing() async throws {
        let mac = PendingMac([everyState])
        for (type, pilot) in pilotIntents {
            #expect(type.authenticationPolicy == .requiresLocalDeviceAuthentication, "\(type)")
            let transport = ScriptedClientTransport { mac.respond($0) }
            let client = ClientDoubles.model(transport: transport, address: macAddress)
            let conversation = ScriptedConversation()
            let result = try await run(pilot, client: client, conversation: conversation, unlocked: false)
            #expect(result == VoiceIssue.deviceLocked.phrase)
            #expect(transport.requests.isEmpty, "\(type) : aucune requête")
            #expect(conversation.dialogs.isEmpty)
        }
    }

    @Test("siri-iphone-pilotage-pipelines/AC-15 : politique littérale et confirmation de chaque intent concordent avec VoiceGesturePolicy pour l'iPhone")
    func intentsMatchThePolicyTable() async throws {
        let cards = try await board(everyState).cards
        let liveRepo = try #require(KanbanLaunchRepos.options(cards: [try await card("export-csv", in: everyState)], projectRoot: nil).first)
        let choices = KanbanLaunchRepos.choices(KanbanLaunchRepos.options(cards: cards, projectRoot: nil))
        let liveLabel = try #require(choices.first { $0.root == liveRepo }?.label)
        for (type, pilot) in pilotIntents {
            #expect(type.authenticationPolicy == VoiceGesturePolicy.authenticationPolicy(for: type.voiceGesture, on: .ios), "\(type)")
            let answers: [String]
            if let pilot {
                let target = try #require(VoicePilot.eligible(pilot, in: cards).first)
                #expect(pilot.voiceGesture == type.voiceGesture)
                answers = [target.title]
            } else {
                answers = [liveLabel, "Titre", "Besoin"]
            }
            let conversation = ScriptedConversation(answers: answers, confirmations: [true])
            let (_, sent) = try await play(pilot, on: everyState, conversation: conversation)
            let needsConfirmation = VoiceGesturePolicy.rule(for: type.voiceGesture, on: .ios).needsConfirmation
            #expect(conversation.confirms.count == (needsConfirmation ? 1 : 0), "\(type)")
            #expect(sent.count == 1, "\(type)")
        }
    }

    @Test("siri-iphone-pilotage-pipelines/AC-16 : les phrases des 5 nouveaux App Shortcuts sont exactement celles de S-9, avec le nom de l'app")
    func pilotShortcutPhrases() throws {
        let shortcuts = try #require(try actionsData()["autoShortcuts"] as? [[String: Any]])
        #expect(shortcuts.count == 7)
        func keys(_ shortcut: [String: Any]) -> [String] {
            (shortcut["phraseTemplates"] as? [[String: Any]] ?? []).compactMap { $0["key"] as? String }
        }
        let expected: [(type: Any.Type, shortTitle: String, image: String, phrases: [String])] = [
            (IOSLaunchFeatureIntent.self, "Lancer une feature", "plus.circle", [
                "Lancer une feature dans ${applicationName}",
                "Nouvelle feature dans ${applicationName}",
                "Lancer une pipeline avec ${applicationName}",
            ]),
            (IOSResumeFeatureIntent.self, "Reprendre une feature", "play.circle", [
                "Reprendre une feature dans ${applicationName}",
                "Relancer une feature dans ${applicationName}",
                "Reprendre une pipeline avec ${applicationName}",
            ]),
            (IOSStopFeatureIntent.self, "Arrêter une feature", "stop.circle", [
                "Arrêter une feature dans ${applicationName}",
                "Arrêter une pipeline avec ${applicationName}",
            ]),
            (IOSValidateSpecsIntent.self, "Valider les specs", "checkmark.seal", [
                "Valider les specs dans ${applicationName}",
                "Valider des specs avec ${applicationName}",
            ]),
            (IOSAcceptReviewIntent.self, "Accepter la revue", "checkmark.bubble", [
                "Accepter la revue dans ${applicationName}",
                "Accepter une revue avec ${applicationName}",
            ]),
        ]
        for entry in expected {
            let name = String(describing: entry.type)
            let shortcut = try #require(shortcuts.first { $0["actionIdentifier"] as? String == name }, "\(name)")
            #expect(keys(shortcut) == entry.phrases, "\(name)")
            #expect((shortcut["shortTitle"] as? [String: Any])?["key"] as? String == entry.shortTitle)
            #expect(shortcut["systemImageName"] as? String == entry.image)
        }
        for shortcut in shortcuts {
            #expect(keys(shortcut).allSatisfy { $0.contains("${applicationName}") })
        }
    }

    /// L'orchestration d'un geste (nil : lancement) sur `client`.
    private func run(
        _ pilot: VoicePilotGesture?,
        client: ConsoleClientModel,
        conversation: ScriptedConversation? = nil,
        unlocked: Bool = true
    ) async throws -> String {
        let conversation = conversation ?? ScriptedConversation()
        if let pilot {
            return try await IOSSiriPilot.perform(pilot, client: client, conversation: conversation, isProtectedDataAvailable: { unlocked })
        }
        return try await IOSSiriPilot.launch(client: client, conversation: conversation, isProtectedDataAvailable: { unlocked })
    }
}
