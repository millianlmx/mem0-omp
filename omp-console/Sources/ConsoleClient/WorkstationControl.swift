// Les gestes de la TOUR DE CONTRÔLE sur le poste de travail, en plus de ceux de
// `WorkstationModel` : l'arrêt d'urgence, l'annulation d'une action, son détail et sa
// capture, la transcription d'une réunion, une action commandée depuis l'app, les
// demandes et les automatisations, le navigateur par défaut et la navigation gardée.
//
// L'arrêt d'urgence est permis à tout client du poste (un lecteur aussi) : arrêter est
// toujours permis. Les demandes, automatisations et réglages exigent le jeton
// APPROBATEUR ; avec un autre, le serveur répond 403 et l'échec est `.approverOnly`.
// Comme pour l'approbation, c'est le serveur qui décide, jamais l'app.

import Foundation

extension WorkstationModel {
    // MARK: - Arrêt d'urgence et annulation

    /// L'arrêt d'urgence : le poste passe en pause, toute action en file, en cours ou à
    /// approuver est annulée et le service de l'agent est coupé. Seul l'approbateur reprend.
    @discardableResult
    public func stop() async -> Bool {
        guard let harness, harness.isConfigured else { return false }
        isStopping = true
        defer { isStopping = false }
        do {
            let call = HarnessCall(method: "POST", path: "/v1/workstation/stop", body: Data("{}".utf8))
            let reply: WorkstationStopReply = try harness.decode(try await harness.exchange(call), for: call)
            status = reply.status
            failure = nil
            await refresh()
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            return false
        }
    }

    /// Annule une action qui n'a pas abouti (en file, en cours, à approuver) : elle passe
    /// `refused`, sa raison dans `error`.
    @discardableResult
    public func cancel(_ action: WorkstationAction) async -> Bool {
        let seq = action.seq
        guard let reply: WorkstationActionReply = await write("POST", "/v1/workstation/actions/\(seq)/cancel", body: Data("{}".utf8), busySeq: seq)
        else { return false }
        apply(reply.action)
        await refresh()
        return true
    }

    // MARK: - Détails

    /// Une action et sa capture, si le serveur en garde une ; `nil` en cas d'échec.
    public func action(_ seq: Int) async -> WorkstationActionView? {
        try? await get("/v1/workstation/actions/\(seq)")
    }

    /// La capture JPEG d'une action `screenshot` ; `nil` sans capture (ou passé sa rétention).
    public func capture(_ seq: Int) async -> WorkstationCapture? {
        try? await optional("/v1/workstation/actions/\(seq)/capture")
    }

    /// Une réunion et sa transcription ; `nil` en cas d'échec.
    public func meeting(_ id: String) async -> WorkstationMeetingDetail? {
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        return try? await get("/v1/workstation/meetings/\(encoded)")
    }

    /// Une demande et les actions de son job, les plus anciennes d'abord.
    public func request(_ id: String) async -> WorkstationRequestDetail? {
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        return try? await get("/v1/workstation/requests/\(encoded)")
    }

    // MARK: - Commander une action

    /// Dépose une action d'origine « session » : ouvrir une page, ou changer celle d'un
    /// onglet. Gardée par le serveur comme toute autre (hôtes permis, fenêtre de l'agent).
    @discardableResult
    public func command(_ draft: WorkstationCommandDraft) async -> WorkstationAction? {
        guard draft.isComplete else {
            failure = .rejected("")
            return nil
        }
        let body = WorkstationCommandBody(
            kind: draft.kind.rawValue,
            params: draft.params,
            rationale: draft.rationale.trimmingCharacters(in: .whitespacesAndNewlines),
            browserId: draft.browserId
        )
        guard let encoded = try? JSONEncoder().encode(body),
              let reply: WorkstationActionReply = await write("POST", "/v1/workstation/actions", body: encoded)
        else { return nil }
        lastCommand = reply.action
        await refresh()
        return reply.action
    }

    // MARK: - Demandes

    /// Pose une demande en langage naturel ; le job `poste-demande` la mène dans le navigateur.
    @discardableResult
    public func createRequest(_ instruction: String, browserId: String? = nil) async -> WorkstationRequest? {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let encoded = try? JSONEncoder().encode(WorkstationRequestBody(instruction: text, browserId: browserId)),
              let reply: WorkstationRequestReply = await write("POST", "/v1/workstation/requests", body: encoded)
        else { return nil }
        await refresh()
        return reply.request
    }

    /// Annule une demande en file ou en cours.
    @discardableResult
    public func cancelRequest(_ request: WorkstationRequest) async -> Bool {
        guard let id = request.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let _: WorkstationRequestReply = await write("POST", "/v1/workstation/requests/\(id)/cancel", body: Data("{}".utf8))
        else { return false }
        await refresh()
        return true
    }

    // MARK: - Automatisations

    /// Garde une tâche automatisable du profil comme automatisation (cron facultatif).
    @discardableResult
    public func createAutomation(version: Int, task: Int, browserId: String? = nil, schedule: String = "") async -> WorkstationAutomation? {
        let cron = schedule.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = WorkstationAutomationBody(version: version, task: task, browserId: browserId, schedule: cron.isEmpty ? nil : cron)
        guard let encoded = try? JSONEncoder().encode(body),
              let reply: WorkstationAutomationReply = await write("POST", "/v1/workstation/automations", body: encoded)
        else { return nil }
        await refresh()
        return reply.automation
    }

    /// Lance une automatisation tout de suite : une demande part en file.
    @discardableResult
    public func launchAutomation(_ automation: WorkstationAutomation) async -> WorkstationRequest? {
        guard let id = automation.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let reply: WorkstationRequestReply = await write("POST", "/v1/workstation/automations/\(id)/launch", body: Data("{}".utf8))
        else { return nil }
        await refresh()
        return reply.request
    }

    /// Supprime une automatisation ; ses demandes restent.
    @discardableResult
    public func deleteAutomation(_ automation: WorkstationAutomation) async -> Bool {
        guard let id = automation.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let _: WorkstationRemoved = await write("DELETE", "/v1/workstation/automations/\(id)", body: nil)
        else { return false }
        await refresh()
        return true
    }

    // MARK: - Navigateurs et navigation gardée

    /// Choisit le navigateur par défaut ; `nil` revient au premier vu.
    @discardableResult
    public func setDefaultBrowser(_ id: String?) async -> Bool {
        await saveNavigation(WorkstationNavigationBody(defaultBrowser: id.map { .set($0) } ?? .reset))
    }

    /// Choisit le navigateur dont l'extension copie en continu tout le profil Chrome dans le
    /// navigateur du serveur ; `nil` arrête la copie (`null` explicite dans le JSON).
    @discardableResult
    public func setMirrorBrowser(_ id: String?) async -> Bool {
        await saveNavigation(WorkstationNavigationBody(mirrorBrowser: id.map { .set($0) } ?? .reset))
    }

    /// Pose les hôtes permis (vide : tout hôte) ; `nil` revient à la configuration du serveur.
    @discardableResult
    public func setAllowedHosts(_ hosts: [String]?) async -> Bool {
        await saveNavigation(WorkstationNavigationBody(allowedHosts: hosts.map { .set($0) } ?? .reset))
    }

    /// Active ou coupe la garde anti-exfiltration ; `nil` revient à la configuration du serveur.
    @discardableResult
    public func setExfiltrationGuard(_ on: Bool?) async -> Bool {
        await saveNavigation(WorkstationNavigationBody(exfiltrationGuard: on.map { .set($0) } ?? .reset))
    }

    private func saveNavigation(_ body: WorkstationNavigationBody) async -> Bool {
        guard let encoded = try? JSONEncoder().encode(body),
              let read: WorkstationStatus = await write("PUT", "/v1/workstation/settings", body: encoded)
        else { return false }
        status = read
        return true
    }

    // MARK: - Échange

    /// Une écriture : la réponse décodée, ou `nil` avec l'échec retenu. `busySeq` marque
    /// l'action concernée le temps de l'échange ; sinon le modèle est « en enregistrement ».
    private func write<Reply: Decodable>(_ method: String, _ path: String, body: Data?, busySeq: Int? = nil) async -> Reply? {
        guard let harness, harness.isConfigured else { return nil }
        if let busySeq { busy.insert(busySeq) } else { isSaving = true }
        defer { if let busySeq { busy.remove(busySeq) } else { isSaving = false } }
        do {
            let call = HarnessCall(method: method, path: path, body: body)
            let reply: Reply = try harness.decode(try await harness.exchange(call), for: call)
            failure = nil
            return reply
        } catch {
            failure = HarnessModel.failure(of: error)
            return nil
        }
    }
}

/// `DELETE /v1/workstation/automations/{id}` : `{removed}`.
struct WorkstationRemoved: Decodable {}
