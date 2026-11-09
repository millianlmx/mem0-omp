// Le modèle observable du NAVIGATEUR DU SERVEUR (écran Poste du Mac) : la connexion
// interactive d'un compte (Slack, Google), portée par `HarnessModel` comme le poste (même
// transport, même jeton).
//
// L'état des comptes et la source de la copie du profil Chrome ne sont pas ici : ils
// arrivent avec `GET /v1/workstation` (`WorkstationStatus.serverBrowser`,
// `mirrorBrowser`), relus et réglés par `WorkstationModel`.
//
// La connexion est réservée à l'appareil APPROBATEUR : avec un autre jeton, le serveur
// répond 403 et l'échec est `.approverOnly`. Comme pour le reste du poste, c'est le
// serveur qui décide, jamais l'app. Seule la lecture de la connexion déjà ouverte
// (`resumeLogin`) se tait pour un autre jeton : il n'a rien à reprendre.
//
// La boucle `followLogin` vit aussi longtemps que la tâche de la vue qui la lance : fermer
// la vue l'arrête. Chaque pas est une méthode à part, sans attente.
//
// Aucun texte ici : un échec est un `HarnessFailure`, que les écrans traduisent.

import Combine
import Foundation

@MainActor
public final class ServerBrowserModel: ObservableObject {
    /// Le rythme de rafraîchissement de l'image d'une connexion ouverte.
    public nonisolated static let frameInterval: Duration = .seconds(1)
    /// La connexion ouverte sur le serveur ; `nil` : aucune.
    @Published public private(set) var login: ServerBrowserLogin?
    /// La dernière image de la page de la connexion.
    @Published public private(set) var frame: ServerBrowserFrame?
    /// Le dernier échec, effacé par le prochain geste réussi.
    @Published public private(set) var failure: HarnessFailure?
    /// Un geste (connexion, clic, frappe) attend la réponse du serveur.
    @Published public private(set) var isBusy = false

    private unowned let harness: HarnessModel
    private var inFlight = 0 { didSet { isBusy = inFlight > 0 } }
    /// L'échec affiché vient du rafraîchissement de l'image : le suivant réussi l'efface.
    private var frameFailed = false

    init(harness: HarnessModel) {
        self.harness = harness
    }

    // MARK: - Connexion interactive

    /// Ouvre la connexion d'un compte sur sa page de départ (`ServerBrowserAccount.loginURL`).
    @discardableResult
    public func startLogin(url: String) async -> Bool {
        guard let body = try? JSONEncoder().encode(ServerBrowserLoginBody(url: url)),
              let reply: ServerBrowserLoginReply = await perform("POST", Self.loginPath, body: body)
        else { return false }
        guard let started = reply.login else {
            failure = .unreadable
            return false
        }
        login = started
        frame = nil
        return true
    }

    /// Relit la connexion déjà ouverte sur le serveur (une autre session de l'app, ou
    /// avant un redémarrage). Un serveur qui n'a pas la route, ou un jeton qui n'est pas
    /// l'approbateur, n'a rien à reprendre : aucun échec.
    public func resumeLogin() async {
        guard harness.isConfigured else { return }
        do {
            let call = HarnessCall(method: "GET", path: Self.loginPath)
            let reply = try await harness.exchange(call)
            if reply.status == 404 {
                clearLogin()
                return
            }
            let read: ServerBrowserLoginReply = try harness.decode(reply, for: call)
            login = read.login
            if read.login == nil { frame = nil }
        } catch HarnessFailure.approverOnly {
            clearLogin()
        } catch {
            guard !Task.isCancelled else { return }
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Relit l'image de la page. Un échec garde la dernière image, se dit, puis relit la
    /// connexion : le serveur y explique pourquoi elle est refusée, ou qu'elle est fermée.
    public func refreshFrame() async {
        guard login != nil, harness.isConfigured else { return }
        do {
            let read: ServerBrowserFrame = try await harness.fetch(HarnessCall(method: "GET", path: Self.framePath))
            guard login != nil else { return }
            frame = read
            if frameFailed {
                failure = nil
                frameFailed = false
            }
        } catch {
            guard !Task.isCancelled, login != nil else { return }
            failure = HarnessModel.failure(of: error)
            frameFailed = true
            await resumeLogin()
        }
    }

    /// Rafraîchit l'image de la connexion ouverte, une fois par `frameInterval`, tant que
    /// la connexion est ouverte et que le serveur ne la refuse pas.
    public func followLogin() async {
        while login != nil, login?.error == nil, !Task.isCancelled {
            await refreshFrame()
            try? await Task.sleep(for: Self.frameInterval)
        }
    }

    /// Renvoie un geste à la page, puis relit l'image pour montrer son effet.
    @discardableResult
    public func send(_ input: ServerBrowserInput) async -> Bool {
        guard login != nil, let body = try? JSONEncoder().encode(input),
              let _: ServerBrowserSent = await perform("POST", Self.inputPath, body: body)
        else { return false }
        await refreshFrame()
        return true
    }

    /// Termine la connexion : la page du serveur se ferme et l'état du compte est relu.
    @discardableResult
    public func finishLogin() async -> Bool {
        guard let _: ServerBrowserClosed = await perform("DELETE", Self.loginPath, body: nil) else { return false }
        clearLogin()
        await harness.workstation.refresh()
        return true
    }

    /// Oublie tout ce qui a été lu : le serveur a changé (ou a été oublié).
    func reset() {
        clearLogin()
        failure = nil
        frameFailed = false
    }

    // MARK: - Échange

    nonisolated static let loginPath = "/v1/workstation/vps/login"
    nonisolated static let framePath = "/v1/workstation/vps/login/frame"
    nonisolated static let inputPath = "/v1/workstation/vps/login/input"

    private func clearLogin() {
        login = nil
        frame = nil
    }

    /// Un geste : la réponse décodée, ou `nil` avec l'échec retenu.
    private func perform<Reply: Decodable>(_ method: String, _ path: String, body: Data?) async -> Reply? {
        guard harness.isConfigured else { return nil }
        inFlight += 1
        defer { inFlight -= 1 }
        do {
            let reply: Reply = try await harness.fetch(HarnessCall(method: method, path: path, body: body))
            failure = nil
            frameFailed = false
            return reply
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }
}
