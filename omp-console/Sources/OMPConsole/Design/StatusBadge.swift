// Les deux formes de l'état en un mot.
//
// - `StatusBadge` (S-11 de omp-console-redesign) : un point et un mot sur une
//   capsule teintée, dans le CONTENU (cartes, lignes, tableaux). Le MOT dit
//   l'état ; la couleur ne fait que le doubler (accessibilité : un lecteur
//   d'écran lit le mot, un daltonien le lit aussi).
// - `StatusPill` (2026-10-02, demande de l'utilisateur) : l'état d'une SESSION
//   ouverte — visionneuse, Session OMP, Projet —, dans la barre d'outils ou
//   l'en-tête : une pilule Liquid Glass aux bords arrondis, teintée de la
//   couleur de l'état, le mot en blanc (en noir sur le jaune de « En pause »).
//   Dans une barre d'outils, poser `.sharedBackgroundVisibility(.hidden)` sur
//   l'article : la pilule est son propre verre.

import ConsoleCore
import SwiftUI

struct StatusBadge: View {
    let status: ConsoleStatus

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(status.tone.tint)
                .frame(width: 7, height: 7)
            Text(status.text)
                .foregroundStyle(.primary)
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(status.tone.tint.opacity(0.15)))
        .accessibilityElement(children: .combine)
    }
}

struct StatusPill: View {
    let status: ConsoleStatus

    var body: some View {
        Text(status.text)
            .font(.callout.weight(.semibold))
            .foregroundStyle(status.tone.onTint)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .glassEffect(.regular.tint(status.tone.tint), in: .capsule)
            .fixedSize()
            .accessibilityElement(children: .combine)
    }
}

extension ConsoleTone {
    /// La teinte qui double le mot d'un état.
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

    /// La couleur du mot posé SUR la teinte (pilule) : blanc, sauf sur le jaune.
    var onTint: Color {
        self == .paused ? .black : .white
    }
}
