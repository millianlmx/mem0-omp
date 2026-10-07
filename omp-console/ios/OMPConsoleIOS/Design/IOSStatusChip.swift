// La pastille d'état de la coque iOS (S-1, BR-2) : un point teinté et le MOT de
// l'état, sur une capsule teintée à 15 %.
//
// Équivalent iOS de `omp-console/Sources/OMPConsole/Design/StatusBadge.swift`
// (même forme, même règle : le mot porte le sens, la couleur ne fait que le
// doubler). Le mapping des tons est IDENTIQUE à celui de macOS (`StatusBadge`),
// déclaré ici en extension locale : le noyau `ConsoleCore` n'importe pas SwiftUI
// (garde « Noyau partagé » de `scripts/check.sh`).

import ConsoleCore
import SwiftUI

struct IOSStatusChip: View {
    let status: ConsoleStatus

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(status.tone.tint)
                .frame(width: 8, height: 8)
            Text(status.text)
                .foregroundStyle(.primary)
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(status.tone.tint.opacity(0.15)))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("ios.status")
    }
}

extension ConsoleTone {
    /// La teinte qui double le mot d'un état — le mapping macOS, ton pour ton.
    var tint: Color {
        switch self {
        case .neutral: return .gray
        case .info: return .blue
        case .attention: return .orange
        case .success: return .green
        case .danger: return .red
        case .paused: return .yellow
        }
    }

    /// La couleur du mot posé SUR la teinte : blanc, sauf sur le jaune.
    var onTint: Color {
        self == .paused ? .black : .white
    }
}
