// L'émulateur VT : la machine à états qui transforme les octets du maître du PTY
// en mutations de la grille (S-3).
//
// La liste des séquences supportées est CLOSE (S-3) : tout ce qui n'y est pas est
// consommé sans effet et sans corrompre la grille. L'inventaire mesuré du flux
// réel d'omp (Doc-1) est la raison d'être de chaque cas : listes SGR mixtes,
// `LF` qui défile, autowrap `?7l`, sondes DA1/OSC 11/CPR.
//
// Trois principes :
//   — les réponses (DA1, CPR, OSC 11) sont émises AU POINT DE PARSING, dans
//     l'ordre du flux : la sonde d'omp lit la position du curseur à cet instant ;
//   — le décodage UTF-8 est incrémental : un caractère coupé entre deux `feed`
//     n'affiche jamais de U+FFFD parasite (les séquences invalides sont
//     simplement ignorées) ;
//   — les chaînes OSC/APC/PM/DCS ne peignent rien et leur tampon est borné à
//     4 096 octets, au-delà duquel la chaîne est abandonnée.

import Foundation

@MainActor
public final class TerminalEmulator {
    /// Rappel des réponses à écrire sur le maître (DA1, CPR, OSC 11).
    public var onReply: (([UInt8]) -> Void)?

    /// La palette, relue à chaque OSC 11 : le modèle la recalcule au changement
    /// d'apparence et la réponse suit (S-4).
    public var palette: TerminalPalette

    private var _screen: TerminalScreen

    /// La grille courante (lecture seule pour l'appelant).
    public var screen: TerminalScreen { _screen }

    private var state: State = .ground
    private var csiBytes: [UInt8] = []
    private var stringBytes: [UInt8] = []
    private var stringOverflow = false
    private var utf8 = UTF8Decoder()
    private var attributes = TerminalAttributes.plain
    private var savedCursor = TerminalCursor(row: 0, column: 0)
    private var savedAttributes = TerminalAttributes.plain

    private enum State {
        case ground
        case escape
        case charset
        case csi
        case osc
        case oscEscape
        case string
        case stringEscape
    }

    public init(columns: Int, rows: Int, palette: TerminalPalette) {
        self._screen = TerminalScreen(columns: columns, rows: rows)
        self.palette = palette
    }

    // MARK: Entrée

    public func feed(_ bytes: [UInt8]) {
        for byte in bytes { consume(byte) }
    }

    public func resize(columns: Int, rows: Int) {
        _screen.resize(columns: columns, rows: rows)
    }

    public func clearChanged() {
        _screen.clearChanged()
    }

    // MARK: Machine à états

    private func consume(_ byte: UInt8) {
        switch state {
        case .ground: consumeGround(byte)
        case .escape: consumeEscape(byte)
        case .charset: state = .ground
        case .csi: consumeCSI(byte)
        case .osc: consumeOSC(byte)
        case .oscEscape: consumeOSCEscape(byte)
        case .string: consumeString(byte)
        case .stringEscape: consumeStringEscape(byte)
        }
    }

    private func consumeGround(_ byte: UInt8) {
        if byte == 0x1B {
            utf8.reset()
            state = .escape
        } else if byte < 0x20 || byte == 0x7F {
            // Un contrôle coupe toujours une séquence UTF-8 en cours.
            utf8.reset()
            control(byte)
        } else if let text = utf8.append(byte) {
            emit(text)
        }
    }

    /// C0 : seuls BEL (dans les chaînes), BS, HT, LF/VT/FF et CR ont un effet.
    private func control(_ byte: UInt8) {
        switch byte {
        case 0x08: _screen.backspace()
        case 0x09: _screen.tab()
        case 0x0A, 0x0B, 0x0C: _screen.lineFeed()
        case 0x0D: _screen.carriageReturn()
        default: break
        }
    }

    /// Écrit un grapheme : largeur > 0 → cellule(s) ; largeur 0 (combinant) →
    /// rattaché à la cellule précédente.
    private func emit(_ text: String) {
        let width = TerminalWidth.of(text)
        if width <= 0 {
            _screen.appendCombining(text)
        } else {
            _screen.write(text, width: width, attributes: attributes)
        }
    }

    private func consumeEscape(_ byte: UInt8) {
        switch byte {
        case 0x1B:
            state = .escape
        case 0x5B: // [
            csiBytes = []
            state = .csi
        case 0x5D: // ]
            stringBytes = []
            stringOverflow = false
            state = .osc
        case 0x50, 0x5E, 0x5F: // P ^ _ : DCS/PM/APC, consommés sans rien afficher
            stringBytes = []
            stringOverflow = false
            state = .string
        case 0x37: // 7 : DECSC
            savedCursor = _screen.cursor
            savedAttributes = attributes
            state = .ground
        case 0x38: // 8 : DECRC
            _screen.moveTo(row: savedCursor.row, column: savedCursor.column)
            attributes = savedAttributes
            state = .ground
        case 0x44: // D : index
            _screen.lineFeed()
            state = .ground
        case 0x4D: // M : reverse index
            _screen.reverseIndex()
            state = .ground
        case 0x28, 0x29, 0x2A, 0x2B, 0x23: // ( ) * + # : jeux de caractères
            state = .charset
        default: // = > (clavier applicatif) et tout le reste : consommés
            state = .ground
        }
    }

    private func consumeCSI(_ byte: UInt8) {
        if byte == 0x1B {
            csiBytes = []
            state = .escape
            return
        }
        if byte >= 0x40, byte <= 0x7E {
            let final = byte
            let bytes = csiBytes
            csiBytes = []
            state = .ground
            executeCSI(final: final, bytes: bytes)
            return
        }
        if byte >= 0x20, byte <= 0x3F, csiBytes.count < 64 {
            csiBytes.append(byte)
        }
        // C0 dans une CSI : ignorés.
    }

    // MARK: CSI

    private func executeCSI(final: UInt8, bytes: [UInt8]) {
        var privatePrefix: UInt8?
        var intermediates: [UInt8] = []
        var paramBytes: [UInt8] = []
        for byte in bytes {
            if byte >= 0x20, byte <= 0x2F {
                intermediates.append(byte)
            } else if byte >= 0x30, byte <= 0x3F {
                if privatePrefix == nil, paramBytes.isEmpty, intermediates.isEmpty, Self.isPrivateMarker(byte) {
                    privatePrefix = byte
                } else if Self.isPrivateMarker(byte) {
                    // marqueur privé tardif (forme non supportée) : ignoré
                } else {
                    paramBytes.append(byte)
                }
            }
        }
        let params = parseParams(paramBytes)

        switch final {
        case 0x41: _screen.moveUp(value(params, 0))
        case 0x42: _screen.moveDown(value(params, 0))
        case 0x43: _screen.moveForward(value(params, 0))
        case 0x44: _screen.moveBackward(value(params, 0))
        case 0x45: _screen.nextLine(value(params, 0))
        case 0x46: _screen.previousLine(value(params, 0))
        case 0x47: _screen.setColumn(value(params, 0) - 1)
        case 0x48, 0x66: // H, f : CUP/HVP
            _screen.moveTo(row: value(params, 0) - 1, column: value(params, 1) - 1)
        case 0x64: // d : VPA
            _screen.moveTo(row: value(params, 0) - 1, column: _screen.cursor.column)
        case 0x4A: _screen.eraseInDisplay(value(params, 0, default: 0))
        case 0x4B: _screen.eraseInLine(value(params, 0, default: 0))
        case 0x4C: _screen.insertLines(value(params, 0))
        case 0x4D: _screen.deleteLines(value(params, 0))
        case 0x53: _screen.scrollUp(value(params, 0)) // S : SU
        case 0x54: _screen.scrollDown(value(params, 0)) // T : SD
        case 0x72: // r : DECSTBM
            _screen.setScrollRegion(top: value(params, 0) - 1, bottom: value(params, 1, default: _screen.rows) - 1)
        case 0x6D: // m : SGR — `>…m` (modifyOtherKeys) n'est PAS du SGR
            if privatePrefix == nil { applySGR(params) }
        case 0x63: // c : DA1 (la forme privée `>c` n'a pas de réponse)
            if privatePrefix == nil { reply(Array("\u{1B}[?1;2c".utf8)) }
        case 0x6E: // n : DSR
            handleDSR(params)
        case 0x68: // h : DECSET
            if privatePrefix == 0x3F { setModes(params, enabled: true) }
        case 0x6C: // l : DECRST
            if privatePrefix == 0x3F { setModes(params, enabled: false) }
        default:
            break // t, p, q (DECSCUSR avec ESPACE compris), u, $p… : consommés
        }
        _ = intermediates
    }

    private static func isPrivateMarker(_ byte: UInt8) -> Bool {
        byte == 0x3F || byte == 0x3E || byte == 0x3C || byte == 0x3D || byte == 0x21
    }

    /// Paramètre d'indice `index`, ou `fallback` s'il manque. Un sous-paramètre
    /// vide vaut `0` (déjà fait par `parseParams`).
    private func value(_ params: [Int], _ index: Int, default fallback: Int = 1) -> Int {
        index < params.count ? params[index] : fallback
    }

    private func parseParams(_ bytes: [UInt8]) -> [Int] {
        guard !bytes.isEmpty else { return [] }
        var result: [Int] = []
        var current = 0
        var hasDigits = false
        for byte in bytes {
            if byte >= 0x30, byte <= 0x39 {
                current = min(current * 10 + Int(byte - 0x30), 999_999)
                hasDigits = true
            } else if byte == 0x3B || byte == 0x3A {
                result.append(hasDigits ? current : 0)
                current = 0
                hasDigits = false
            }
        }
        result.append(hasDigits ? current : 0)
        return result
    }

    private func handleDSR(_ params: [Int]) {
        switch value(params, 0, default: 0) {
        case 5:
            reply(Array("\u{1B}[0n".utf8))
        case 6:
            let cursor = _screen.cursor
            reply(Array("\u{1B}[\(cursor.row + 1);\(cursor.column + 1)R".utf8))
        default:
            break
        }
    }

    private func setModes(_ params: [Int], enabled: Bool) {
        for mode in params {
            switch mode {
            case 25: _screen.cursorVisible = enabled
            case 7: _screen.autowrap = enabled
            case 1049: _screen.setAlternateScreen(enabled)
            default:
                break // souris 1000/1002/1003/1006, 2004, 5522, 2031, 2026, 2048 : acceptés et ignorés
            }
        }
    }

    // MARK: SGR

    private func applySGR(_ params: [Int]) {
        if params.isEmpty {
            attributes = .plain
            return
        }
        var index = 0
        while index < params.count {
            let code = params[index]
            switch code {
            case 0: attributes = .plain
            case 1: attributes.bold = true
            case 2: attributes.dim = true
            case 3: attributes.italic = true
            case 4: attributes.underline = true
            case 7: attributes.inverse = true
            case 22: attributes.bold = false; attributes.dim = false
            case 23: attributes.italic = false
            case 24: attributes.underline = false
            case 27: attributes.inverse = false
            case 39: attributes.foreground = .default
            case 49: attributes.background = .default
            case 30...37: attributes.foreground = .indexed(UInt8(code - 30))
            case 90...97: attributes.foreground = .indexed(UInt8(code - 90 + 8))
            case 40...47: attributes.background = .indexed(UInt8(code - 40))
            case 100...107: attributes.background = .indexed(UInt8(code - 100 + 8))
            case 38, 48:
                index = applyExtendedColor(code: code, params: params, index: index)
            default:
                break // paramètre inconnu : ignoré
            }
            index += 1
        }
    }

    /// `38;5;n` / `48;5;n` (256) et `38;2;r;g;b` / `48;2;r;g;b` (direct).
    /// Rend le dernier indice consommé (les sous-paramètres en trop sont
    /// ignorés ; un indexé hors 0…255 retombe sur la couleur par défaut, une
    /// composante > 255 est bornée).
    private func applyExtendedColor(code: Int, params: [Int], index: Int) -> Int {
        let isForeground = code == 38
        guard index + 1 < params.count else { return index }
        switch params[index + 1] {
        case 5:
            guard index + 2 < params.count else { return index + 1 }
            let n = params[index + 2]
            let color: TerminalColor = (0...255).contains(n) ? .indexed(UInt8(n)) : .default
            if isForeground { attributes.foreground = color } else { attributes.background = color }
            return index + 2
        case 2:
            guard index + 4 < params.count else { return index + 1 }
            let color = TerminalColor.rgb(
                clampByte(params[index + 2]),
                clampByte(params[index + 3]),
                clampByte(params[index + 4])
            )
            if isForeground { attributes.foreground = color } else { attributes.background = color }
            return index + 4
        default:
            return index + 1
        }
    }

    private func clampByte(_ value: Int) -> UInt8 {
        UInt8(min(max(value, 0), 255))
    }

    // MARK: Chaînes

    private func consumeOSC(_ byte: UInt8) {
        if byte == 0x07 {
            finishOSC()
        } else if byte == 0x1B {
            state = .oscEscape
        } else if !stringOverflow {
            if stringBytes.count < 4096 {
                stringBytes.append(byte)
            } else {
                stringBytes = []
                stringOverflow = true
            }
        }
    }

    private func consumeOSCEscape(_ byte: UInt8) {
        if byte == 0x5C { // \ : ST
            finishOSC()
        } else if byte == 0x1B {
            // reste en attente d'un éventuel `\`
        } else {
            state = .osc
            if !stringOverflow {
                if stringBytes.count < 4096 {
                    stringBytes.append(byte)
                } else {
                    stringBytes = []
                    stringOverflow = true
                }
            }
        }
    }

    /// Seul OSC 11 (couleur de fond) reçoit une réponse ; 0/2 (titre), 8 (lien,
    /// son texte est du texte normal), 9, 66, 99, 133, 1337 sont ignorés.
    private func finishOSC() {
        let payload = stringBytes
        let overflow = stringOverflow
        stringBytes = []
        stringOverflow = false
        state = .ground
        guard !overflow else { return }
        let command = payload.prefix { $0 != 0x3B }
        guard String(decoding: command, as: UTF8.self) == "11" else { return }
        reply(palette.osc11Reply())
    }

    private func consumeString(_ byte: UInt8) {
        if byte == 0x1B { state = .stringEscape }
    }

    private func consumeStringEscape(_ byte: UInt8) {
        if byte == 0x5C {
            state = .ground
        } else if byte == 0x1B {
            state = .stringEscape
        } else {
            state = .string
        }
    }

    private func reply(_ bytes: [UInt8]) {
        onReply?(bytes)
    }
}

// MARK: - Décodage UTF-8 incrémental

/// Décodeur UTF-8 qui ne rend QUE des séquences valides : une séquence coupée
/// attend le `feed` suivant, une séquence invalide est ignorée sans produire de
/// U+FFFD. Les octets de contrôle et `ESC` ne passent jamais par lui.
private struct UTF8Decoder {
    private var buffer: [UInt8] = []
    private var expected = 0

    mutating func reset() {
        buffer = []
        expected = 0
    }

    mutating func append(_ byte: UInt8) -> String? {
        if buffer.isEmpty {
            switch byte {
            case 0x20...0x7E:
                return String(UnicodeScalar(byte))
            case 0xC2...0xDF:
                buffer = [byte]
                expected = 2
                return nil
            case 0xE0...0xEF:
                buffer = [byte]
                expected = 3
                return nil
            case 0xF0...0xF4:
                buffer = [byte]
                expected = 4
                return nil
            default:
                return nil // 0x80…0xC1 et 0xF5…0xFF : jamais un début valide
            }
        }
        guard (0x80...0xBF).contains(byte) else {
            // Octet inattendu au milieu d'une séquence : on resynchronise et on
            // REJOUE l'octet comme un nouveau début, sans le perdre.
            reset()
            return append(byte)
        }
        buffer.append(byte)
        guard buffer.count == expected else { return nil }
        let decoded = String(decoding: buffer, as: UTF8.self)
        reset()
        // Une seule scalaire : rejette les surlongueurs et les substituts, que
        // `String(decoding:)` transformerait en plusieurs U+FFFD.
        guard decoded.unicodeScalars.count == 1 else { return nil }
        return decoded
    }
}
