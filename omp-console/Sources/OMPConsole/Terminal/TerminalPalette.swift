// La palette de couleurs d'un terminal (S-4) : les défauts, la table 16/256 et
// la réponse OSC 11. Aucune E/S, mais AppKit pour résoudre l'apparence.
//
// Un seul point de vérité : `osc11Reply()` rend EXACTEMENT `defaultBackground`,
// la couleur que le rendu peint en fond. La réponse et la peinture ne peuvent
// donc pas diverger (S-4).

import AppKit
import Foundation

/// Une couleur sRGB 8 bits par composante.
public struct TerminalRGB: Equatable, Sendable {
    public var r: UInt8
    public var g: UInt8
    public var b: UInt8

    public init(_ r: UInt8, _ g: UInt8, _ b: UInt8) {
        self.r = r
        self.g = g
        self.b = b
    }

    /// `0xRRGGBB`.
    public init(_ value: UInt32) {
        self.r = UInt8((value >> 16) & 0xFF)
        self.g = UInt8((value >> 8) & 0xFF)
        self.b = UInt8(value & 0xFF)
    }

    /// La même couleur atténuée (SGR 2), pour le rendu : deux tiers de chaque
    /// composante, jamais du noir absolu (le texte reste lisible).
    public var dimmed: TerminalRGB {
        TerminalRGB(r * 2 / 3, g * 2 / 3, b * 2 / 3)
    }

    /// La couleur AppKit correspondante, en sRGB.
    public var nsColor: NSColor {
        NSColor(
            srgbRed: CGFloat(r) / 255,
            green: CGFloat(g) / 255,
            blue: CGFloat(b) / 255,
            alpha: 1
        )
    }

    /// Convertit une `NSColor` quelconque en sRGB ; replie sur du noir si la
    /// conversion échoue (couleur « pattern »).
    init(srgb color: NSColor) {
        guard let converted = color.usingColorSpace(.sRGB) else {
            self = TerminalRGB(0, 0, 0)
            return
        }
        self.r = UInt8((converted.redComponent * 255).rounded())
        self.g = UInt8((converted.greenComponent * 255).rounded())
        self.b = UInt8((converted.blueComponent * 255).rounded())
    }
}

/// Les défauts (fond/avant) et la table complète des couleurs indexées.
public struct TerminalPalette: Equatable, Sendable {
    public var defaultForeground: TerminalRGB
    public var defaultBackground: TerminalRGB

    public init(defaultForeground: TerminalRGB, defaultBackground: TerminalRGB) {
        self.defaultForeground = defaultForeground
        self.defaultBackground = defaultBackground
    }

    /// `.default` → `defaultForeground` ; `.indexed(0…15)` table ANSI, `16…231`
    /// cube 6×6×6, `232…255` gris (`UInt8` borne naturellement à 255) ;
    /// `.rgb` tel quel (déjà borné au parsing).
    public func foreground(_ color: TerminalColor) -> TerminalRGB {
        resolve(color, fallback: defaultForeground)
    }

    /// Idem, mais `.default` → `defaultBackground`.
    public func background(_ color: TerminalColor) -> TerminalRGB {
        resolve(color, fallback: defaultBackground)
    }

    /// Réponse OSC 11 : `ESC ] 11 ; rgb:RGBA/rgb:… BEL`, 16 bits par composante
    /// (chaque octet est dupliqué : `0xNN` → `0xNNNN`).
    public func osc11Reply() -> [UInt8] {
        let body = String(
            format: "%04X/%04X/%04X",
            Int(defaultBackground.r) * 257,
            Int(defaultBackground.g) * 257,
            Int(defaultBackground.b) * 257
        )
        var bytes = Array("\u{1B}]11;rgb:".utf8)
        bytes.append(contentsOf: Array(body.utf8))
        bytes.append(0x07)
        return bytes
    }

    private func resolve(_ color: TerminalColor, fallback: TerminalRGB) -> TerminalRGB {
        switch color {
        case .default:
            return fallback
        case .rgb(let r, let g, let b):
            return TerminalRGB(r, g, b)
        case .indexed(let index):
            return Self.indexed(index)
        }
    }

    /// Table xterm : 16 couleurs système + cube 6×6×6 + 24 gris.
    private static func indexed(_ index: UInt8) -> TerminalRGB {
        switch index {
        case 0...15:
            return ansi[Int(index)]
        case 16...231:
            let value = Int(index) - 16
            return TerminalRGB(level(value / 36), level((value / 6) % 6), level(value % 6))
        default:
            let gray = 8 + 10 * (Int(index) - 232)
            return TerminalRGB(UInt8(gray), UInt8(gray), UInt8(gray))
        }
    }

    /// Les 6 niveaux du cube xterm.
    private static func level(_ step: Int) -> UInt8 {
        switch step {
        case 0: return 0
        case 1: return 95
        case 2: return 135
        case 3: return 175
        case 4: return 215
        default: return 255
        }
    }

    /// Les 16 couleurs ANSI standard (xterm).
    private static let ansi: [TerminalRGB] = [
        TerminalRGB(0x000000), TerminalRGB(0xCD0000), TerminalRGB(0x00CD00), TerminalRGB(0xCDCD00),
        TerminalRGB(0x0000EE), TerminalRGB(0xCD00CD), TerminalRGB(0x00CDCD), TerminalRGB(0xE5E5E5),
        TerminalRGB(0x7F7F7F), TerminalRGB(0xFF0000), TerminalRGB(0x00FF00), TerminalRGB(0xFFFF00),
        TerminalRGB(0x5C5CFF), TerminalRGB(0xFF00FF), TerminalRGB(0x00FFFF), TerminalRGB(0xFFFFFF),
    ]
}

extension TerminalPalette {
    /// La palette d'UNE apparence : le fond et l'avant du texte système, résolus
    /// sous `appearance` puis convertis en sRGB. Recalculée à chaque changement
    /// d'apparence de la vue du terminal ; le rendu et la réponse OSC 11 lisent
    /// toujours cette même instance (S-4). Les couleurs indexées et RVB ne
    /// dépendent pas de l'apparence, comme dans Terminal.app.
    @MainActor
    public static func live(for appearance: NSAppearance) -> TerminalPalette {
        var palette = TerminalPalette(defaultForeground: TerminalRGB(0, 0, 0), defaultBackground: TerminalRGB(0, 0, 0))
        appearance.performAsCurrentDrawingAppearance {
            palette = TerminalPalette(
                defaultForeground: TerminalRGB(srgb: NSColor.textColor),
                defaultBackground: TerminalRGB(srgb: NSColor.textBackgroundColor)
            )
        }
        return palette
    }
}
