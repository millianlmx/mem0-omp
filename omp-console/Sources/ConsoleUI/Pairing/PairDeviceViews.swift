// L'APPAIRAGE PAR QR CODE, côté écrans (omp-harness pairing.ts) : la feuille « Appairer un iPhone »
// du Mac, qui crée un ticket à usage unique et l'affiche en QR code, et la confirmation de l'iPhone
// quand l'appareil photo ouvre le lien `ompconsole://pair…` dans l'app.
//
// Les mots sont ceux de `PairingText` ; l'échange et le ticket passent par `HarnessModel`
// (HarnessPairLink.swift). Le QR code est toujours noir sur blanc (`PairQRCode`).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille du Mac : le nom de l'appareil, le droit d'approuver (offert au seul client approbateur),
/// le QR code, le temps qu'il lui reste et de quoi en refaire un.
public struct PairDeviceSheet: View {
    @ObservedObject var server: HarnessModel
    /// La mémoire du projet à joindre au ticket (celle d'un serveur lue par le Mac), ou `nil`.
    let memory: @MainActor () -> HarnessPairMemory?
    @Environment(\.dismiss) private var dismiss

    @State private var label = PairingText.defaultLabel
    @State private var approver = false
    @State private var invite: HarnessPairInvite?
    @State private var code: CGImage?
    @State private var failure: HarnessFailure?
    @State private var isCreating = false

    public init(server: HarnessModel, memory: @escaping @MainActor () -> HarnessPairMemory? = { nil }) {
        self.server = server
        self.memory = memory
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(PairingText.labelField, text: $label)
                        .consoleID("pair.label")
                    // Seul un client approbateur peut en appairer un autre : le serveur refuse sinon.
                    if server.canPairApprover {
                        Toggle(PairingText.approverToggle, isOn: $approver)
                            .consoleID("pair.approver")
                    }
                }
                Section {
                    if let invite, let code {
                        codeBlock(invite, code)
                    } else {
                        Label(PairingText.explanation, systemImage: PairingText.codeSymbol)
                            .foregroundStyle(.secondary)
                            .consoleReadable()
                    }
                    Button(invite == nil ? PairingText.create : PairingText.renew) { Task { await create() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(isCreating)
                        .consoleID("pair.create")
                    if isCreating {
                        ProgressView(PairingText.creating)
                    }
                }
                if let failure {
                    Section {
                        ConsoleFailureBanner(failure: failure)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PairingText.title)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { dismiss() }
                }
            }
        }
        .consoleSheetSize(minWidth: 420, minHeight: 440)
        .consoleID("pair.sheet")
    }

    /// Le code, l'explication et le temps restant ; passé l'échéance, le code disparaît (un scan échouerait).
    private func codeBlock(_ invite: HarnessPairInvite, _ code: CGImage) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(spacing: 12) {
                if invite.isExpired(at: context.date) {
                    Label(PairingText.expired, systemImage: "clock.badge.exclamationmark")
                        .foregroundStyle(.secondary)
                        .consoleID("pair.expired")
                } else {
                    Image(decorative: code, scale: 1)
                        .interpolation(.none)
                        .resizable()
                        .aspectRatio(1, contentMode: .fit)
                        .frame(maxWidth: 260)
                        .accessibilityElement()
                        .accessibilityLabel(PairingText.codeLabel)
                        .accessibilityHint(PairingText.codeHint)
                        .accessibilityAddTraits(.isImage)
                        .consoleID("pair.code")
                    Text(PairingText.explanation)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .consoleReadable()
                    Text(PairingText.remaining(seconds: invite.secondsLeft(at: context.date)))
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .consoleID("pair.remaining")
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func create() async {
        isCreating = true
        defer { isCreating = false }
        do {
            let created = try await server.createPairInvite(
                label: label, approver: approver && server.canPairApprover, memory: memory()
            )
            // Un code que le système ne sait pas dessiner n'est pas un code : rien à scanner.
            guard let image = PairQRCode.image(for: created.link.url.absoluteString) else {
                failure = .unreadable
                return
            }
            invite = created
            code = image
            failure = nil
        } catch {
            // Une annulation (feuille fermée) n'est pas une panne du serveur.
            if error is CancellationError { return }
            failure = (error as? HarnessFailure) ?? .unreachable
            // Un échec ne laisse pas à l'écran le code d'avant : il est peut-être déjà consommé ou expiré.
            invite = nil
            code = nil
        }
    }
}

extension View {
    /// La confirmation d'un lien d'appairage ouvert dans l'app (`drafts.pairRequest`), puis son résultat
    /// (`drafts.pairOutcome`). La confirmation NOMME le serveur : l'échange n'a lieu qu'après « Appairer ».
    public func pairLinkConfirmation(server: HarnessModel, drafts: HarnessDrafts) -> some View {
        modifier(PairLinkConfirmation(server: server, drafts: drafts))
    }
}

private struct PairLinkConfirmation: ViewModifier {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                drafts.pairRequest.map { PairingText.confirmTitle(address: $0.address) } ?? "",
                isPresented: Binding(get: { drafts.pairRequest != nil }, set: { if !$0 { drafts.pairRequest = nil } }),
                titleVisibility: .visible,
                presenting: drafts.pairRequest
            ) { link in
                Button(PairingText.confirm) { Task { await pair(link) } }
                    .consoleID("pair.confirm")
                Button(PipelineServerText.cancel, role: .cancel) {}
            } message: { _ in
                Text(PairingText.confirmMessage)
            }
            .alert(
                outcomeTitle,
                isPresented: Binding(get: { drafts.pairOutcome != nil }, set: { if !$0 { drafts.pairOutcome = nil } }),
                presenting: drafts.pairOutcome
            ) { _ in
                Button(PairingText.acknowledge) {}
            } message: { outcome in
                Text(outcome.message)
            }
            .overlay {
                if drafts.isPairing {
                    ProgressView(PairingText.pairing)
                        .padding(20)
                        .background(.regularMaterial, in: .rect(cornerRadius: ConsolePlatform.cardRadius))
                }
            }
    }

    private var outcomeTitle: String {
        if case .paired = drafts.pairOutcome { return PairingText.successTitle }
        return PairingText.failureTitle
    }

    private func pair(_ link: HarnessPairLink) async {
        drafts.pairRequest = nil
        drafts.isPairing = true
        let outcome = await server.pair(with: link)
        drafts.isPairing = false
        if case .paired = outcome { server.startLive() }
        drafts.pairOutcome = outcome
    }
}
