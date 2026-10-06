import ConsoleCore
import SwiftUI

/// L'écran d'attente d'une section : son nom, son icône et le libellé d'attente
/// unique. C'est le seul écran livré par ce segment — chaque section en aura un
/// vrai plus tard, sans que la navigation change.
struct SectionPlaceholderView: View {
    let section: ConsoleSection

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: section.systemImage)
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(.secondary)
            Text(section.title)
                .font(.title2)
            Text(IOSText.waiting)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(section.title)
        .accessibilityIdentifier("ios.placeholder." + section.rawValue)
    }
}
