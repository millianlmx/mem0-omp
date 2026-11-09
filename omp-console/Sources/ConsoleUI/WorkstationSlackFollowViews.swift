// Les canaux Slack suivis, en fin de l'écran Canaux (Mac et iPhone/iPad) : une case par
// canal de l'espace. Le serveur lit les DM et les mentions partout ; un canal coché entre
// en plus dans sa lecture suivante.
//
// Montrée seulement quand Slack est lisible (le serveur relit la liste chez Slack) et que
// le serveur sert la route. Cocher est un geste de l'appareil approbateur : ailleurs les
// cases sont grisées, et le refus du serveur revient sous la liste. Le modèle est
// `channels.slackConversations` ; les mots viennent de `SlackFollowText`.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct SlackFollowSection: View {
    @ObservedObject var conversations: WorkstationSlackConversationsModel
    let isApprover: Bool
    @State private var failure: HarnessFailure?

    var body: some View {
        Group {
            if conversations.availability == .available {
                Section {
                    if conversations.conversations.isEmpty {
                        Text(SlackFollowText.empty)
                            .foregroundStyle(.secondary)
                            .consoleID("channels.slack.empty")
                    }
                    ForEach(conversations.conversations) { conversation in
                        Toggle(isOn: followed(conversation)) {
                            Label {
                                Text(conversation.name)
                            } icon: {
                                if conversation.kind == "private" {
                                    Image(systemName: SlackFollowText.privateSymbol)
                                        .accessibilityLabel(SlackFollowText.privateChannel)
                                }
                            }
                        }
                        .disabled(!isApprover || conversations.busy.contains(conversation.id))
                        .consoleID("channels.slack.follow.\(conversation.id)")
                    }
                    if let failure {
                        Text(failure == .approverOnly ? ChannelText.approverOnly : failure.message)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                            .consoleBanner(tone: .attention)
                            .consoleID("channels.slack.failure")
                    }
                } header: {
                    Text(SlackFollowText.header)
                } footer: {
                    Text(isApprover ? SlackFollowText.hint : ChannelText.approverOnly)
                }
            }
        }
        .task { await conversations.refresh() }
    }

    /// La case d'un canal : cocher envoie le geste, la ligne prend la réponse du serveur.
    private func followed(_ conversation: WorkstationSlackConversation) -> Binding<Bool> {
        Binding(
            get: { conversation.followed },
            set: { next in
                failure = nil
                Task {
                    do {
                        try await conversations.setFollowed(conversation.id, next)
                    } catch let refused as HarnessFailure {
                        failure = refused
                    } catch {}
                }
            }
        )
    }
}
