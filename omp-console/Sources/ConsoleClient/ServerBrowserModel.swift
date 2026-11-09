// Le modèle observable du NAVIGATEUR DU SERVEUR (écran Poste du Mac) : l'import de la
// session du Chrome de l'utilisateur et la connexion interactive d'un compte (Slack,
// Google), portés par `HarnessModel` comme le poste (même transport, même jeton).
//
// L'état des comptes n'est pas ici : il arrive avec `GET /v1/workstation` dans le
// navigateur `vps` (`WorkstationStatus.serverBrowser`), relu par `WorkstationModel`.
//
// Import ET connexion sont réservés à l'appareil APPROBATEUR : avec un autre jeton, le
// serveur répond 403 et l'échec est `.approverOnly`. Comme pour le reste du poste, c'est
// le serveur qui décide, jamais l'app. Seule la lecture de la connexion déjà ouverte
// (`resumeLogin`) se tait pour un autre jeton : il n'a rien à reprendre.
//
// Les boucles (`watchImport`, `followLogin`) vivent aussi longtemps que la tâche de la vue
// qui les lance : fermer la vue les arrête. Chaque pas est une méthode à part, sans attente.
//
// Aucun texte ici : un échec est un `HarnessFailure`, que les écrans traduisent.

import Combine
import Foundation

/// Ce que devient un import une fois refermé.
public enum ServerBrowserImportOutcome: Equatable, Sendable {
    /// L'extension a répondu avant l'échéance : le serveur a relu l'état du compte.
    case received(String)
    /// L'échéance est passée sans réponse de l'extension.
    case expired(String)
}

@MainActor
public final class ServerBrowserModel: ObservableObject {
    /// Le rythme de rafraîchissement de l'image d'une connexion ouverte.
    public nonisolated static let frameInterval: Duration = .seconds(1)
    /// Le rythme de relecture d'un import ouvert.
    public nonisolated static let importInterval: Duration = .seconds(2)

    /// L'import ouvert, en attente de l'extension ; `nil` : aucun.
    @Published public private(set) var pendingImport: ServerBrowserImport?
    /// Comment le dernier import s'est refermé ; effacé par le suivant.
    @Published public private(set) var importOutcome: ServerBrowserImportOutcome?
    /// La connexion ouverte sur le serveur ; `nil` : aucune.
    @Published public private(set) var login: ServerBrowserLogin?
    /// La dernière image de la page de la connexion.
    @Published public private(set) var frame: ServerBrowserFrame?
    /// Le dernier échec, effacé par le prochain geste réussi.
    @Published public private(set) var failure: HarnessFailure?
    /// Un geste (import, connexion, clic, frappe) attend la réponse du serveur.
    @Published public private(set) var isBusy = false

    private unowned let harness: HarnessModel
    private var inFlight = 0 { didSet { isBusy = inFlight > 0 } }
    /// L'échec affiché vient du rafraîchissement de l'image : le suivant réussi l'efface.
    private var frameFailed = false

    init(harness: HarnessModel) {
        self.harness = harness
    }

    // MARK: - Import de la session de Chrome

    /// Ouvre l'import d'un compte : l'extension Chrome y répond seule, dans les deux minutes.
    @discardableResult
    public func openImport(domain: String) async -> Bool {
        guard let body = try? JSONEncoder().encode(ServerBrowserDomainBody(domain: domain)),
              let reply: ServerBrowserImportReply = await perform("POST", Self.importPath, body: body)
        else { return false }
        pendingImport = reply.opened
        importOutcome = nil
        return true
    }

    /// Relit l'import ouvert. Refermé avant l'échéance : l'extension a répondu ; refermé
    /// après : le délai est passé. Dans les deux cas l'état des comptes est relu.
    public func pollImport(now: Date = Date()) async {
        guard let asked = pendingImport, harness.isConfigured else { return }
        let past = now.timeIntervalSince1970 * 1000 >= asked.expiresAt
        do {
            let read: ServerBrowserImportStatus = try await harness.fetch(HarnessCall(method: "GET", path: Self.importPath))
            if let current = read.current {
                pendingImport = current
                return
            }
            pendingImport = nil
            importOutcome = past ? .expired(asked.domain) : .received(asked.domain)
            await harness.workstation.refresh()
        } catch {
            guard !Task.isCancelled else { return }
            failure = HarnessModel.failure(of: error)
            if past {
                pendingImport = nil
                importOutcome = .expired(asked.domain)
            }
        }
    }

    /// Relit l'import ouvert tant qu'il l'est.
    public func watchImport() async {
        while pendingImport != nil, !Task.isCancelled {
            try? await Task.sleep(for: Self.importInterval)
            guard !Task.isCancelled else { return }
            await pollImport()
        }
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
        pendingImport = nil
        importOutcome = nil
        clearLogin()
        failure = nil
        frameFailed = false
    }

    // MARK: - Échange

    nonisolated static let importPath = "/v1/workstation/vps/cookie-import"
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
