// Les gestes et retours natifs de l'app iOS (ios-gestes-et-retours-natifs).
//
// AC-2 (S-2) : le tirage des Pipelines relit l'ardoise puis l'état des PR ; le
// mode Graphe de la Mémoire, sans tirage, se relit à chaque passage sans repasser
// par le chargement.
// AC-3 (S-3) : la commande ⌘R s'intitule « Actualiser » dans la barre des menus.
// AC-13 (S-10) : « Sommaire » n'est disponible qu'en mode Liste, après une
// recherche finie ; sinon c'est un bouton désactivé du système.
// AC-8 (S-5) : l'issue d'une commande envoyée au Mac est publiée à SA RÉPONSE,
// jamais à l'envoi, et le retour haptique en découle (succès → `.success`,
// échec → `.error`). Le modèle est un vrai `ConsoleClientModel` alimenté par un
// transport scripté (ClientTestDoubles.swift).
// AC-6, AC-7 (S-4) : le menu contextuel d'un élément ne reprend que les actions
// offertes dans son état courant, plus « Copier », qui copie le lien de la PR,
// sinon le texte principal, dans le presse-papiers système.
// AC-11 (S-8) : avec « Réduire les animations », le défilement automatique de
// l'Accueil se fait d'un saut ; sans lui, il garde l'animation par défaut.

import ConsoleClient
import ConsoleCore
import Foundation
import SwiftUI
import Testing
import UIKit

@testable import OMPConsoleIOS

@MainActor
@Suite("ios-gestes-et-retours-natifs — gestes et retours natifs")
struct IOSGestesNatifsTests {
    private static let macAddress = "127.0.0.1:18787"

    @Test("ios-gestes-et-retours-natifs/AC-8 : l'issue suit la réponse du Mac, jamais l'envoi")
    func commandOutcomeFollowsTheMacResponse() async throws {
        let transport = ScriptedClientTransport { request in
            switch (request.method, request.path) {
            case ("POST", "/v1/cards/carte1/verdict"):
                return ClientDoubles.response(status: 202, json: #"{"accepted":true}"#)
            case ("POST", "/v1/cards/carte1/resume"):
                return ClientDoubles.response(
                    status: 409,
                    json: #"{"error":{"code":"conflict","message":"rien à reprendre"}}"#
                )
            case ("POST", "/v1/session/launch"):
                return ClientDoubles.response(
                    status: 200,
                    json: #"{"state":"running","stateLabel":"En cours","dialogs":[],"transcript":[],"truncated":false}"#
                )
            default:
                return ClientDoubles.response(status: 404, json: #"{"error":{"code":"not_found"}}"#)
            }
        }
        let model = ClientDoubles.model(transport: transport, address: Self.macAddress)
        #expect(model.commandOutcome == nil, "aucune issue avant toute commande")

        // Le Mac accepte : une issue de succès, la première.
        _ = try await model.verdict(cardId: "carte1", verdict: "accept")
        #expect(model.commandOutcome == ClientCommandOutcome(sequence: 1, succeeded: true))

        // Le Mac refuse : une issue d'échec, la suivante ; l'erreur reste relancée.
        await #expect(throws: ClientError.self) {
            _ = try await model.resume(cardId: "carte1")
        }
        #expect(model.commandOutcome == ClientCommandOutcome(sequence: 2, succeeded: false))

        // Une lecture (GET), même en échec, ne publie aucune issue.
        _ = try? await model.store()
        #expect(model.commandOutcome == ClientCommandOutcome(sequence: 2, succeeded: false))

        // Une route d'abord en `perform` direct passe aussi par l'issue.
        _ = try await model.launchHostedSession(repoKey: "depot")
        #expect(model.commandOutcome == ClientCommandOutcome(sequence: 3, succeeded: true))

        // Hors connexion (aucun Mac connu) : refus local, issue d'échec, rien n'est envoyé.
        let offlineTransport = ScriptedClientTransport { _ in
            ClientDoubles.response(status: 202, json: #"{"accepted":true}"#)
        }
        let offline = ClientDoubles.model(transport: offlineTransport, address: "")
        #expect(offline.effectiveEndpoint == nil)
        await #expect(throws: ClientError.notConnected) {
            _ = try await offline.stop(cardId: "carte1")
        }
        #expect(offline.commandOutcome == ClientCommandOutcome(sequence: 1, succeeded: false))
        #expect(offlineTransport.requests.isEmpty)
    }

    @Test("ios-gestes-et-retours-natifs/AC-8 : succès → .success, échec → .error")
    func outcomeMapsToSystemFeedback() {
        #expect(IOSCommandFeedback.feedback(for: nil) == nil)
        #expect(IOSCommandFeedback.feedback(for: ClientCommandOutcome(sequence: 1, succeeded: true)) == .success)
        #expect(IOSCommandFeedback.feedback(for: ClientCommandOutcome(sequence: 2, succeeded: false)) == .error)
    }

    // MARK: - AC-2 : tirer pour actualiser

    @Test("ios-gestes-et-retours-natifs/AC-2 : le tirage des Pipelines relit l'ardoise puis l'état des PR, échec avalé")
    func pipelinesRefreshRereadsTheBoardThenThePullRequests() async {
        let transport = ScriptedClientTransport { request in
            switch (request.method, request.path) {
            case ("POST", "/v1/pull-request-states/refresh"):
                return ClientDoubles.response(status: 202, json: #"{"accepted":true}"#)
            default:
                // GET /v1/store en échec : avalé, la relecture des PR suit quand même.
                return ClientDoubles.response(status: 503, json: #"{"error":{"code":"unavailable","message":"magasin"}}"#)
            }
        }
        let model = ClientDoubles.model(transport: transport, address: Self.macAddress)
        await PipelinesModel.refresh(model)
        #expect(transport.requests.map { "\($0.method) \($0.path)" } == [
            "GET /v1/store",
            "POST /v1/pull-request-states/refresh",
        ])
    }

    @Test("ios-gestes-et-retours-natifs/AC-2 : le graphe se relit à chaque passage en mode Graphe sans repasser par le chargement")
    func graphRereadsOnEveryPassWithoutLoading() async {
        let reader = GraphReader()
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()
        #expect(reader.graphReads == 1)
        #expect(Self.isGraph(model.state))

        // Second passage : la lecture part, le graphe affiché RESTE pendant qu'elle vole.
        model.hide()
        reader.hangs = true
        let pass = Task { await model.activate() }
        while reader.graphReads == 1 { await Task.yield() }
        #expect(model.shown)
        #expect(Self.isGraph(model.state), "le graphe reste affiché, jamais l'état de chargement")
        model.suspend()
        await pass.value
        #expect(reader.cancelledReads == 1)
        #expect(Self.isGraph(model.state))

        // La réponse remplace l'état affiché : vide, puis échec, puis graphe.
        reader.hangs = false
        reader.graph = .success(RemoteMemoryGraphPayload(scope: "projet", nodes: [], links: [], total: 0))
        model.hide()
        await model.activate()
        #expect(model.state == .empty)

        reader.graph = .failure(ClientError.transport(.unreachable("refus")))
        model.hide()
        await model.activate()
        #expect(model.state == .failed(.macUnreachable))

        reader.graph = .success(IOSMemoryGraphRecipe.graphe.payload)
        model.hide()
        await model.activate()
        #expect(Self.isGraph(model.state))
        #expect(reader.graphReads == 5)
    }

    private static func isGraph(_ state: IOSMemoryGraphModel.State) -> Bool {
        if case .graph = state { return true }
        return false
    }

    // MARK: - AC-3 : ⌘R « Actualiser »

    @Test("ios-gestes-et-retours-natifs/AC-3 : « Actualiser » (⌘R) figure dans la barre des menus")
    func refreshCommandIsListedAsActualiser() {
        #expect(IOSKeyboard.refresh.title == "Actualiser")
        #expect(IOSKeyboard.refresh.key == "r")
        #expect(IOSKeyboard.all.contains { $0.title == "Actualiser" && $0.key == "r" })
        #expect(IOSKeyboard.modifiers == .command)
    }

    // MARK: - AC-13 : « Sommaire » vrai bouton désactivé

    @Test("ios-gestes-et-retours-natifs/AC-13 : « Sommaire » n'est disponible qu'après une recherche finie, en mode Liste")
    func summaryAvailability() {
        var available: [(graphShown: Bool, isSearching: Bool, isLoading: Bool)] = []
        for graphShown in [true, false] {
            for isSearching in [true, false] {
                for isLoading in [true, false] {
                    let shown = IOSMemoryModel.summaryAvailable(
                        graphShown: graphShown, isSearching: isSearching, isLoading: isLoading
                    )
                    if shown { available.append((graphShown, isSearching, isLoading)) }
                }
            }
        }
        // Une seule combinaison sur huit : Liste, recherche en cours d'affichage, lecture finie.
        #expect(available.count == 1)
        #expect(available.first.map { !$0.graphShown && $0.isSearching && !$0.isLoading } == true)
    }

    // MARK: - AC-6, AC-7 : menus contextuels

    private static let prLink = "https://example.test/depot/pull/7"

    private static func card(
        column: KanbanColumn,
        phase: PipelinePhase? = nil,
        prUrl: String? = nil,
        marks: [KanbanMark] = [],
        action: KanbanCardAction? = nil
    ) -> KanbanCard {
        KanbanCard(
            id: "feature:abc:slug",
            column: column,
            repo: "depot",
            title: "depot/slug",
            state: "attend",
            phase: phase,
            models: nil,
            prUrl: prUrl,
            startMs: 0,
            endMs: nil,
            marks: marks,
            sources: [],
            action: action
        )
    }

    private static func action(
        worktree: String? = nil,
        slug: String? = "slug",
        waitKind: LotWaitKind? = nil,
        featureState: LotFeatureState? = nil
    ) -> KanbanCardAction {
        KanbanCardAction(
            repoRoot: "/depot",
            repoKey: "abc",
            worktree: worktree,
            slug: slug,
            waitKind: waitKind,
            featureState: featureState,
            run: nil
        )
    }

    @Test("ios-gestes-et-retours-natifs/AC-6 : le menu ne propose que les actions offertes dans l'état courant")
    func contextMenuOffersOnlyCurrentActions() throws {
        let url = try #require(URL(string: Self.prLink))

        // Carte Pipelines reprenable (pilote mort) : « Reprendre », « Copier », « Arrêter… » en dernier.
        let dead = Self.card(column: .echec, marks: [.mort], action: Self.action(featureState: .running))
        #expect(IOSContextMenu.pipelinesCard(dead, gesturesEnabled: true, sending: false) == [.resume, .copy("slug"), .stop])
        // Hors connexion, puis commande en vol : seules les entrées locales restent.
        #expect(IOSContextMenu.pipelinesCard(dead, gesturesEnabled: false, sending: false) == [.copy("slug")])
        #expect(IOSContextMenu.pipelinesCard(dead, gesturesEnabled: true, sending: true) == [.copy("slug")])

        // Jalon specs avec PR : le verdict, la PR, la copie du lien, l'arrêt ; jamais « Fusionner ».
        let specs = Self.card(
            column: .jalonSpecs,
            prUrl: Self.prLink,
            action: Self.action(waitKind: .specs, featureState: .waiting)
        )
        #expect(IOSContextMenu.pipelinesCard(specs, gesturesEnabled: true, sending: false)
            == [.validateSpecs, .openPR(url), .copy(Self.prLink), .stop])
        // Hors connexion, « Ouvrir la PR » reste (local).
        #expect(IOSContextMenu.pipelinesCard(specs, gesturesEnabled: false, sending: false)
            == [.openPR(url), .copy(Self.prLink)])

        // Carte jamais lancée, sans PR : « Lancer » puis « Copier » le titre, aucune PR.
        let waiting = Self.card(column: .enAttente, action: Self.action(slug: nil))
        let launchMenu = IOSContextMenu.pipelinesCard(waiting, gesturesEnabled: true, sending: false)
        #expect(launchMenu == [.launch, .copy("slug")])
        #expect(!launchMenu.contains { if case .openPR = $0 { true } else { false } })

        // Carte « À vous » qui attend une réponse : « Répondre… » connecté, absent hors connexion.
        let question = Self.card(
            column: .questionEnVol,
            action: Self.action(waitKind: .answer, featureState: .waiting)
        )
        let answer = HomeAttention(card: question, nature: .question, prompt: "Quel format ?")
        #expect(IOSContextMenu.homeAttention(answer, gesturesEnabled: true, sending: false) == [.answer, .copy("slug")])
        #expect(IOSContextMenu.homeAttention(answer, gesturesEnabled: false, sending: false) == [.copy("slug")])
        // Avec un contrat localisable (maillon req, worktree) : « Lire le contrat », connecté seulement.
        let besoins = Self.card(
            column: .questionEnVol,
            phase: .req,
            action: Self.action(worktree: "/wt", waitKind: .answer, featureState: .waiting)
        )
        let withContract = HomeAttention(card: besoins, nature: .question, prompt: "Quel format ?")
        #expect(IOSContextMenu.homeAttention(withContract, gesturesEnabled: true, sending: false)
            == [.answer, .readContract, .copy("slug")])
        #expect(IOSContextMenu.homeAttention(withContract, gesturesEnabled: false, sending: false) == [.copy("slug")])

        // « Voir dans Pipelines » reste offert hors connexion.
        let open = HomeAttention(card: Self.card(column: .jalonSpecs), nature: .milestoneSpecs, prompt: "")
        #expect(IOSContextMenu.homeAttention(open, gesturesEnabled: false, sending: false) == [.showInPipelines, .copy("slug")])

        // « Valider les specs » disparaît pendant l'envoi.
        let validate = HomeAttention(card: specs, nature: .milestoneSpecs, prompt: "")
        #expect(IOSContextMenu.homeAttention(validate, gesturesEnabled: true, sending: false) == [.validateSpecs, .copy(Self.prLink)])
        #expect(IOSContextMenu.homeAttention(validate, gesturesEnabled: true, sending: true) == [.copy(Self.prLink)])

        // « À reprendre » : sans `action`, rien à reprendre ; avec, « Reprendre » connecté et hors envoi.
        let pausedBare = Self.card(column: .enCours)
        #expect(IOSContextMenu.homeRow(pausedBare, kind: .paused, gesturesEnabled: true, sending: false) == [.copy("slug")])
        let paused = Self.card(column: .enCours, action: Self.action(featureState: .pending))
        #expect(IOSContextMenu.homeRow(paused, kind: .paused, gesturesEnabled: true, sending: false) == [.resume, .copy("slug")])
        #expect(IOSContextMenu.homeRow(paused, kind: .paused, gesturesEnabled: true, sending: true) == [.copy("slug")])
        #expect(IOSContextMenu.homeRow(paused, kind: .paused, gesturesEnabled: false, sending: false) == [.copy("slug")])
        // « En cours » ne porte jamais « Reprendre » ; une livraison porte sa PR.
        #expect(IOSContextMenu.homeRow(paused, kind: .running, gesturesEnabled: true, sending: false) == [.copy("slug")])
        let delivered = Self.card(column: .prOuverte, prUrl: Self.prLink)
        #expect(IOSContextMenu.homeRow(delivered, kind: .delivered, gesturesEnabled: false, sending: false)
            == [.openPR(url), .copy(Self.prLink)])

        // Sessions et Mémoire : « Copier » seul, et aucun menu pour un texte blanc.
        let memo = RemoteMemoryRow(id: "m1", text: "Un souvenir.", updatedAt: nil, score: nil, tags: [], agentId: "projet")
        #expect(IOSContextMenu.memory(memo) == [.copy("Un souvenir.")])
        let blank = RemoteMemoryRow(id: "m2", text: " \n\t", updatedAt: nil, score: nil, tags: [], agentId: "projet")
        #expect(IOSContextMenu.memory(blank).isEmpty)
        #expect(IOSContextMenu.session(Self.choice(featureTitle: "export-csv")) == [.copy("export-csv")])
        #expect(IOSContextMenu.session(Self.choice(featureTitle: "  ")).isEmpty)

        // Libellés : ceux des contrôles existants ; « Arrêter… » destructif reste le dernier.
        #expect(IOSContextMenu.label(.copy("x")) == MemoryText.copy)
        #expect(IOSContextMenu.label(.stop) == KanbanText.stop)
        #expect(IOSContextMenu.label(.readContract) == ContractText.open)
        #expect(IOSMenuText.copySymbol == "doc.on.doc")
    }

    @Test("ios-gestes-et-retours-natifs/AC-7 : « Copier » copie le lien de la PR, sinon le texte principal")
    func copyCopiesPullRequestLinkElseMainText() {
        let withPR = Self.card(column: .prOuverte, prUrl: Self.prLink)
        #expect(IOSContextMenu.copyText(withPR) == Self.prLink)
        let withoutPR = Self.card(column: .enCours)
        #expect(IOSContextMenu.copyText(withoutPR) == "slug")
        // Une adresse non http(s) est traitée comme une absence de PR.
        let notHTTP = Self.card(column: .prOuverte, prUrl: "pas-une-adresse")
        #expect(IOSContextMenu.copyText(notHTTP) == "slug")

        // Le choix « Copier » remplace le contenu du presse-papiers système.
        IOSPasteboard.copy(IOSContextMenu.copyText(withPR))
        #expect(UIPasteboard.general.string == Self.prLink)
        IOSPasteboard.copy(IOSContextMenu.copyText(withoutPR))
        #expect(UIPasteboard.general.string == "slug")
    }

    // MARK: - AC-11 : Réduire les animations

    @Test("ios-gestes-et-retours-natifs/AC-11 : défilement d'un saut quand Réduire les animations est actif")
    func scrollJumpsWhenReduceMotionIsOn() {
        #expect(IOSMotion.scrollAnimation(reduceMotion: true) == nil)
        #expect(IOSMotion.scrollAnimation(reduceMotion: false) == .default)
    }

    private static func choice(featureTitle: String) -> RunChoice {
        let sessionFile = "/sessions/run.jsonl"
        return RunChoice(
            id: sessionFile,
            sessionFile: sessionFile,
            label: "depot/" + featureTitle,
            repo: "depot",
            featureTitle: featureTitle,
            startedAtMs: 0,
            phase: .impl,
            state: .ended(.done),
            isStale: false,
            target: ViewerTarget(
                sessionFile: sessionFile,
                title: featureTitle,
                subtitle: RunChoice.subtitle(phase: .impl, repo: "depot")
            )
        )
    }
}
