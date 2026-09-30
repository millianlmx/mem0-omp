// La grille d'un terminal VT : des VALEURS, pas de vue.
//
// L'écran est un tampon de cellules `rows × columns`, ligne-major, plus un
// curseur et deux réglages hérités de xterm (autowrap, marges de défilement).
// Aucune E/S : `TerminalEmulator` est le seul à appeler ces mutations.
//
// Invariants portés par ce fichier :
//   — une cellule large occupe DEUX colonnes : la première porte le grapheme,
//     la seconde est une continuation (`isContinuation`, `text = ""`) ;
//   — `changedRows` ne se vide que sur `clearChanged()` et il ACCUMULE les
//     rangées touchées, y compris l'ANCIENNE et la NOUVELLE rangée du curseur
//     à chaque déplacement : le rendu ne repeint que ces rangées et le curseur
//     ne laisse donc aucune traînée ;
//   — `resize` n'implémente aucun reflow : le contenu reste ancré en haut à
//     gauche, les cellules nouvelles sont vides, les rangées hors écran sont
//     perdues (B-3 exclut le scrollback).
//
// La largeur en cellules (Doc-4) suit UAX #11 ; Swift 6.4 CLT n'expose PAS de
// propriété East Asian Width sur `Unicode.Scalar.Properties` (vérifié : ni
// `isWide` ni `isFullwidth` n'existent), donc la table des plages W/F est figée
// ci-dessous, dérivée de l'UCD du poste (`python3 -c unicodedata`, UCD 16.0.0,
// même source que la mesure de Doc-4).

import Foundation

// MARK: - Couleurs et attributs

/// Une couleur de cellule à la mode xterm : défaut (palette), indexée (16, 256)
/// ou directe (vraie couleur).
public enum TerminalColor: Equatable, Sendable {
    case `default`
    case indexed(UInt8)
    case rgb(UInt8, UInt8, UInt8)
}

/// Les attributs d'un run de texte (SGR). `inverse` n'est PAS appliqué ici :
/// S-3 impose que l'échange avant/arrière se fasse au moment du rendu.
public struct TerminalAttributes: Equatable, Sendable {
    public var bold = false
    public var dim = false
    public var italic = false
    public var underline = false
    public var inverse = false
    public var foreground: TerminalColor = .default
    public var background: TerminalColor = .default

    public static let plain = TerminalAttributes()
}

/// Une cellule de la grille. `text` porte UN grapheme (les combinants sont
/// ajoutés à la cellule de leur base) ; une cellule de continuation porte
/// `text = ""` et `isContinuation = true`.
public struct TerminalCell: Equatable, Sendable {
    public var text: String = " "
    public var width: Int = 1
    public var isContinuation: Bool = false
    public var attributes: TerminalAttributes = .plain

    public static let blank = TerminalCell()
}

/// Position du curseur, 0-based.
public struct TerminalCursor: Equatable, Sendable {
    public var row: Int
    public var column: Int

    public init(row: Int, column: Int) {
        self.row = row
        self.column = column
    }
}

// MARK: - Écran

/// La grille : tampon actif, curseur, marges de défilement (DECSTBM) et écran
/// alterné (?1049). Valeur, donc copiable et comparable.
public struct TerminalScreen: Equatable, Sendable {
    public private(set) var columns: Int
    public private(set) var rows: Int

    /// Tampon ACTIF, ligne-major (`row * columns + column`). C'est un tableau
    /// stocké, pas calculé : une écriture de cellule reste en place et ne copie
    /// pas tout l'écran (un tampon calculé ferait une copie COW par caractère).
    private var buffer: [TerminalCell]

    /// L'écran normal garé pendant que l'écran alterné est actif (?1049h) ;
    /// `nil` quand on est sur l'écran normal.
    private var stashedNormalBuffer: [TerminalCell]?

    /// Le curseur de l'écran normal, rendu par `?1049l` (DECSC implicite).
    private var alternateSavedCursor: TerminalCursor?

    /// Rangée du curseur et colonne, bornées à l'écran.
    public var cursor: TerminalCursor {
        didSet {
            guard cursor != oldValue else { return }
            // Exigence du rendu : l'ancienne ET la nouvelle rangée changent,
            // sinon le curseur laisse une traînée derrière lui.
            if cursor.row != oldValue.row {
                changedRows.insert(oldValue.row)
                changedRows.insert(cursor.row)
            }
        }
    }

    public var cursorVisible: Bool = true {
        didSet {
            guard cursorVisible != oldValue else { return }
            changedRows.insert(cursor.row)
        }
    }

    public var autowrap: Bool = true

    public private(set) var scrollTop: Int = 0
    public private(set) var scrollBottom: Int = 23

    /// Rangées modifiées depuis le dernier `clearChanged()`. ACCUMULE.
    public private(set) var changedRows: Set<Int> = []

    /// Vrai pendant un écran alterné (`?1049h`).
    public var isAlternate: Bool { stashedNormalBuffer != nil }

    /// Une écriture a atteint la dernière colonne et la suivante doit passer à
    /// la ligne (xterm « pending wrap ») : n'est armé que si `autowrap`.
    private var wrapPending = false

    public init(columns: Int = 80, rows: Int = 24) {
        let cols = max(1, columns)
        let rws = max(1, rows)
        self.columns = cols
        self.rows = rws
        self.cursor = TerminalCursor(row: 0, column: 0)
        self.scrollTop = 0
        self.scrollBottom = rws - 1
        self.buffer = Array(repeating: .blank, count: cols * rws)
        self.stashedNormalBuffer = nil
        // Tout l'écran est à peindre au premier rendu.
        self.changedRows = Set(0..<rws)
    }

    // MARK: Accès en lecture

    /// La grille complète `[row][column]`, pour le rendu.
    public var cells: [[TerminalCell]] {
        (0..<rows).map { row in
            Array(buffer[(row * columns)..<((row + 1) * columns)])
        }
    }

    /// Les cellules d'une rangée.
    public func line(_ row: Int) -> [TerminalCell] {
        guard row >= 0, row < rows else { return [] }
        return Array(buffer[(row * columns)..<((row + 1) * columns)])
    }

    /// Le texte visible d'une rangée : les cellules de continuation ne
    /// contribuent rien, les cellules vides contribuent leur espace. La chaîne
    /// fait donc `columns` caractères SAUF si la rangée contient des cellules
    /// larges (deux colonnes pour un seul caractère).
    public func text(row: Int) -> String {
        guard row >= 0, row < rows else { return "" }
        var out = ""
        for column in 0..<columns {
            let cell = buffer[row * columns + column]
            if cell.isContinuation { continue }
            out += cell.text
        }
        return out
    }

    // MARK: Écriture de cellules

    /// Écrit un grapheme à la position du curseur, avec sa largeur en cellules.
    /// Autowrap désactivé : au-delà de la dernière colonne, la dernière cellule
    /// est écrasée (et le curseur y reste). Un grapheme large qui ne tient pas
    /// dans la dernière colonne est tronqué à une cellule.
    public mutating func write(_ grapheme: String, width: Int, attributes: TerminalAttributes) {
        guard columns > 0, rows > 0 else { return }
        if width <= 0 { return }
        let cellWidth = min(width, columns)

        if cellWidth == 2, cursor.column == columns - 1 {
            guard autowrap else {
                buffer[index(cursor.row, columns - 1)] = TerminalCell(
                    text: grapheme, width: 2, isContinuation: false, attributes: attributes
                )
                markChanged(cursor.row)
                wrapPending = false
                return
            }
            carriageReturn()
            lineFeed()
        } else if wrapPending, autowrap {
            carriageReturn()
            lineFeed()
        }

        let row = cursor.row
        let column = cursor.column
        buffer[index(row, column)] = TerminalCell(
            text: grapheme, width: cellWidth, isContinuation: false, attributes: attributes
        )
        if cellWidth == 2, column + 1 < columns {
            buffer[index(row, column + 1)] = TerminalCell(
                text: "", width: 1, isContinuation: true, attributes: attributes
            )
        }
        markChanged(row)

        let next = column + cellWidth
        if next >= columns {
            cursor.column = columns - 1
            wrapPending = autowrap
        } else {
            cursor.column = next
            wrapPending = false
        }
    }

    /// Rattache un combinant (largeur 0) à la cellule de sa base : celle qui
    /// précède le curseur, en sautant l'éventuelle cellule de continuation.
    public mutating func appendCombining(_ text: String) {
        guard columns > 0, cursor.column > 0 else { return }
        var column = cursor.column - 1
        if buffer[index(cursor.row, column)].isContinuation, column > 0 { column -= 1 }
        let cell = buffer[index(cursor.row, column)]
        buffer[index(cursor.row, column)] = TerminalCell(
            text: cell.text + text,
            width: cell.width,
            isContinuation: false,
            attributes: cell.attributes
        )
        markChanged(cursor.row)
    }

    // MARK: Contrôles C0

    public mutating func carriageReturn() {
        cursor.column = 0
        wrapPending = false
    }

    /// `LF`/`VT`/`FF`/`ESC D` : descend d'une rangée et DÉFILE si le curseur est
    /// sur la marge basse (la ligne qui sort est perdue : pas de scrollback).
    public mutating func lineFeed() {
        wrapPending = false
        if cursor.row == scrollBottom {
            scrollUp(1)
        } else {
            place(row: cursor.row + 1, column: cursor.column)
        }
    }

    /// `ESC M` : remonte d'une rangée, ou défile vers le bas sur la marge haute.
    public mutating func reverseIndex() {
        wrapPending = false
        if cursor.row == scrollTop {
            scrollDown(1)
        } else {
            place(row: cursor.row - 1, column: cursor.column)
        }
    }

    public mutating func backspace() {
        wrapPending = false
        if cursor.column > 0 { cursor.column -= 1 }
    }

    /// Tabulation suivante, pas de 8 ; bornée à la dernière colonne.
    public mutating func tab() {
        wrapPending = false
        let next = ((cursor.column / 8) + 1) * 8
        cursor.column = min(next, columns - 1)
    }

    // MARK: Déplacements du curseur

    public mutating func moveUp(_ count: Int) {
        place(row: cursor.row - count, column: cursor.column)
    }

    public mutating func moveDown(_ count: Int) {
        place(row: cursor.row + count, column: cursor.column)
    }

    public mutating func moveForward(_ count: Int) {
        place(row: cursor.row, column: cursor.column + count)
    }

    public mutating func moveBackward(_ count: Int) {
        place(row: cursor.row, column: cursor.column - count)
    }

    /// `CNL` : rangée suivante, colonne 0 (ne défile pas).
    public mutating func nextLine(_ count: Int) {
        place(row: cursor.row + count, column: 0)
    }

    /// `CPL` : rangée précédente, colonne 0.
    public mutating func previousLine(_ count: Int) {
        place(row: cursor.row - count, column: 0)
    }

    /// `CHA` : colonne absolue (1-based en entrée, déjà décrémentée par l'appelant).
    public mutating func setColumn(_ column: Int) {
        place(row: cursor.row, column: column)
    }

    /// `CUP`/`HVP` : position absolue, 0-based.
    public mutating func moveTo(row: Int, column: Int) {
        place(row: row, column: column)
    }

    // MARK: Marges et défilement

    /// `DECSTBM` : marges du défilement, 0-based et incluses. Un intervalle
    /// invalide (haute ≥ basse, hors écran) remet les marges pleines.
    public mutating func setScrollRegion(top: Int, bottom: Int) {
        if top >= 0, bottom < rows, top < bottom {
            scrollTop = top
            scrollBottom = bottom
        } else {
            scrollTop = 0
            scrollBottom = rows - 1
        }
        place(row: 0, column: 0)
    }

    /// `SU` : défilement vers le haut DANS les marges.
    public mutating func scrollUp(_ count: Int) {
        guard count > 0, scrollBottom >= scrollTop else { return }
        let span = scrollBottom - scrollTop + 1
        let n = min(count, span)
        for row in scrollTop..<(scrollBottom - n + 1) {
            let source = (row + n) * columns
            let destination = row * columns
            for column in 0..<columns { buffer[destination + column] = buffer[source + column] }
        }
        for row in (scrollBottom - n + 1)...scrollBottom { clearRow(row) }
        markRows(scrollTop..<rows)
    }

    /// `SD` : défilement vers le bas DANS les marges.
    public mutating func scrollDown(_ count: Int) {
        guard count > 0, scrollBottom >= scrollTop else { return }
        let span = scrollBottom - scrollTop + 1
        let n = min(count, span)
        for row in stride(from: scrollBottom, through: scrollTop + n, by: -1) {
            let source = (row - n) * columns
            let destination = row * columns
            for column in 0..<columns { buffer[destination + column] = buffer[source + column] }
        }
        for row in scrollTop..<(scrollTop + n) { clearRow(row) }
        markRows(scrollTop..<rows)
    }

    /// `IL` : insère `count` rangées vides à la rangée du curseur, dans les
    /// marges ; sans effet si le curseur est hors des marges.
    public mutating func insertLines(_ count: Int) {
        guard count > 0, cursor.row >= scrollTop, cursor.row <= scrollBottom else { return }
        let n = min(count, scrollBottom - cursor.row + 1)
        for row in stride(from: scrollBottom, through: cursor.row + n, by: -1) {
            let source = (row - n) * columns
            let destination = row * columns
            for column in 0..<columns { buffer[destination + column] = buffer[source + column] }
        }
        for row in cursor.row..<(cursor.row + n) { clearRow(row) }
        markRows(scrollTop..<rows)
    }

    /// `DL` : supprime `count` rangées à partir du curseur, dans les marges.
    public mutating func deleteLines(_ count: Int) {
        guard count > 0, cursor.row >= scrollTop, cursor.row <= scrollBottom else { return }
        let n = min(count, scrollBottom - cursor.row + 1)
        for row in cursor.row..<(scrollBottom - n + 1) {
            let source = (row + n) * columns
            let destination = row * columns
            for column in 0..<columns { buffer[destination + column] = buffer[source + column] }
        }
        for row in (scrollBottom - n + 1)...scrollBottom { clearRow(row) }
        markRows(scrollTop..<rows)
    }

    // MARK: Effacements

    /// `ED` : `0` sous le curseur, `1` au-dessus, `2` tout, `3` sans effet
    /// (scrollback, hors périmètre).
    public mutating func eraseInDisplay(_ mode: Int) {
        switch mode {
        case 0:
            for row in (cursor.row + 1)..<rows { clearRow(row) }
            clearCells(row: cursor.row, range: cursor.column..<columns)
            markRows(cursor.row..<rows)
        case 1:
            for row in 0..<cursor.row { clearRow(row) }
            clearCells(row: cursor.row, range: 0..<(cursor.column + 1))
            markRows(0..<(cursor.row + 1))
        case 2:
            for row in 0..<rows { clearRow(row) }
            markRows(0..<rows)
        default:
            break
        }
    }

    /// `EL` : `0` à droite, `1` à gauche, `2` toute la rangée.
    public mutating func eraseInLine(_ mode: Int) {
        switch mode {
        case 0:
            clearCells(row: cursor.row, range: cursor.column..<columns)
        case 1:
            clearCells(row: cursor.row, range: 0..<(cursor.column + 1))
        case 2:
            clearCells(row: cursor.row, range: 0..<columns)
        default:
            return
        }
        markChanged(cursor.row)
    }

    // MARK: Écran alterné

    /// `?1049h` : gare l'écran normal, bascule sur un tampon vierge et remet le
    /// curseur en haut à gauche. `?1049l` : restaure l'écran normal et le
    /// curseur. Un `l` sans `h` est sans effet.
    public mutating func setAlternateScreen(_ enabled: Bool) {
        if enabled {
            guard stashedNormalBuffer == nil else { return }
            alternateSavedCursor = cursor
            stashedNormalBuffer = buffer
            buffer = Array(repeating: .blank, count: rows * columns)
            scrollTop = 0
            scrollBottom = rows - 1
            cursor = TerminalCursor(row: 0, column: 0)
            wrapPending = false
        } else {
            guard let normal = stashedNormalBuffer else { return }
            buffer = normal
            stashedNormalBuffer = nil
            scrollTop = 0
            scrollBottom = rows - 1
            cursor = alternateSavedCursor ?? TerminalCursor(row: 0, column: 0)
            alternateSavedCursor = nil
            wrapPending = false
        }
        markRows(0..<rows)
    }

    // MARK: Redimensionnement

    /// Redimensionne SANS reflow : contenu ancré en haut à gauche, nouvelles
    /// cellules vides, rangées hors écran perdues. Toutes les rangées de la
    /// nouvelle taille redeviennent modifiées.
    public mutating func resize(columns newColumns: Int, rows newRows: Int) {
        let cols = max(1, newColumns)
        let rws = max(1, newRows)
        guard cols != columns || rws != rows else { return }
        buffer = Self.resized(buffer, fromColumns: columns, fromRows: rows, toColumns: cols, toRows: rws)
        if let normal = stashedNormalBuffer {
            stashedNormalBuffer = Self.resized(normal, fromColumns: columns, fromRows: rows, toColumns: cols, toRows: rws)
        }
        columns = cols
        rows = rws
        scrollTop = 0
        scrollBottom = rws - 1
        cursor = TerminalCursor(row: min(cursor.row, rws - 1), column: min(cursor.column, cols - 1))
        wrapPending = false
        markRows(0..<rws)
        // Le déplacement du curseur a pu marquer son ANCIENNE rangée, qui peut
        // ne plus exister après un rétrécissement : `changedRows` ne contient
        // que des rangées valides.
        changedRows = changedRows.filter { $0 >= 0 && $0 < rws }
    }

    // MARK: changedRows

    public mutating func clearChanged() {
        changedRows.removeAll()
    }

    // MARK: Interne

    private func index(_ row: Int, _ column: Int) -> Int {
        row * columns + column
    }

    /// Déplace le curseur en bornant à l'écran et désarme le retour à la ligne.
    private mutating func place(row: Int, column: Int) {
        cursor = TerminalCursor(
            row: min(max(row, 0), rows - 1),
            column: min(max(column, 0), columns - 1)
        )
        wrapPending = false
    }

    private mutating func markChanged(_ row: Int) {
        guard row >= 0, row < rows else { return }
        changedRows.insert(row)
    }

    private mutating func markRows(_ range: Range<Int>) {
        changedRows.formUnion(range.clamped(to: 0..<rows))
    }

    private mutating func clearRow(_ row: Int) {
        let start = row * columns
        for column in 0..<columns { buffer[start + column] = .blank }
    }

    private mutating func clearCells(row: Int, range: Range<Int>) {
        let valid = range.clamped(to: 0..<columns)
        let start = row * columns
        for column in valid { buffer[start + column] = .blank }
    }

    private static func resized(
        _ source: [TerminalCell],
        fromColumns: Int,
        fromRows: Int,
        toColumns: Int,
        toRows: Int
    ) -> [TerminalCell] {
        var target = Array(repeating: TerminalCell.blank, count: toColumns * toRows)
        let copyRows = min(fromRows, toRows)
        let copyColumns = min(fromColumns, toColumns)
        for row in 0..<copyRows {
            for column in 0..<copyColumns {
                target[row * toColumns + column] = source[row * fromColumns + column]
            }
        }
        return target
    }
}

// MARK: - Largeur en cellules (UAX #11)

public enum TerminalWidth {
    /// Largeur d'un scalaire : `0` pour un combinant (Mn/Me) ou un « default
    /// ignorable code point », `2` pour une plage East Asian Width W ou F,
    /// `1` sinon — les « ambiguous » restent à 1, comme la mesure de Doc-4.
    public static func of(_ scalar: Unicode.Scalar) -> Int {
        let properties = scalar.properties
        switch properties.generalCategory {
        case .nonspacingMark, .enclosingMark:
            return 0
        default:
            break
        }
        if properties.isDefaultIgnorableCodePoint { return 0 }
        return isWide(scalar.value) ? 2 : 1
    }

    /// Largeur d'un grapheme : le maximum des largeurs de ses scalaires. Un
    /// grapheme base + combinant vaut donc la largeur de sa base, et une
    /// séquence emoji (ZWJ) vaut 2.
    public static func of(_ text: String) -> Int {
        var width = 0
        for scalar in text.unicodeScalars { width = max(width, of(scalar)) }
        return width
    }

    /// Plages `[début, fin]` incluses des scalaires de largeur 2 (East Asian
    /// Width W ou F), triées. Dérivées de l'UCD 16.0.0 du poste.
    private static let wideRanges: [(UInt32, UInt32)] = [
        (0x1100, 0x115F), (0x231A, 0x231B), (0x2329, 0x232A), (0x23E9, 0x23EC),
        (0x23F0, 0x23F0), (0x23F3, 0x23F3), (0x25FD, 0x25FE), (0x2614, 0x2615),
        (0x2630, 0x2637), (0x2648, 0x2653), (0x267F, 0x267F), (0x268A, 0x268F),
        (0x2693, 0x2693), (0x26A1, 0x26A1), (0x26AA, 0x26AB), (0x26BD, 0x26BE),
        (0x26C4, 0x26C5), (0x26CE, 0x26CE), (0x26D4, 0x26D4), (0x26EA, 0x26EA),
        (0x26F2, 0x26F3), (0x26F5, 0x26F5), (0x26FA, 0x26FA), (0x26FD, 0x26FD),
        (0x2705, 0x2705), (0x270A, 0x270B), (0x2728, 0x2728), (0x274C, 0x274C),
        (0x274E, 0x274E), (0x2753, 0x2755), (0x2757, 0x2757), (0x2795, 0x2797),
        (0x27B0, 0x27B0), (0x27BF, 0x27BF), (0x2B1B, 0x2B1C), (0x2B50, 0x2B50),
        (0x2B55, 0x2B55), (0x2E80, 0x2E99), (0x2E9B, 0x2EF3), (0x2F00, 0x2FD5),
        (0x2FF0, 0x303E), (0x3041, 0x3096), (0x3099, 0x30FF), (0x3105, 0x312F),
        (0x3131, 0x318E), (0x3190, 0x31E5), (0x31EF, 0x321E), (0x3220, 0x3247),
        (0x3250, 0xA48C), (0xA490, 0xA4C6), (0xA960, 0xA97C), (0xAC00, 0xD7A3),
        (0xF900, 0xFAFF), (0xFE10, 0xFE19), (0xFE30, 0xFE52), (0xFE54, 0xFE66),
        (0xFE68, 0xFE6B), (0xFF01, 0xFF60), (0xFFE0, 0xFFE6), (0x16FE0, 0x16FE4),
        (0x16FF0, 0x16FF1), (0x17000, 0x187F7), (0x18800, 0x18CD5), (0x18CFF, 0x18D08),
        (0x1AFF0, 0x1AFF3), (0x1AFF5, 0x1AFFB), (0x1AFFD, 0x1AFFE), (0x1B000, 0x1B122),
        (0x1B132, 0x1B132), (0x1B150, 0x1B152), (0x1B155, 0x1B155), (0x1B164, 0x1B167),
        (0x1B170, 0x1B2FB), (0x1D300, 0x1D356), (0x1D360, 0x1D376), (0x1F004, 0x1F004),
        (0x1F0CF, 0x1F0CF), (0x1F18E, 0x1F18E), (0x1F191, 0x1F19A), (0x1F200, 0x1F202),
        (0x1F210, 0x1F23B), (0x1F240, 0x1F248), (0x1F250, 0x1F251), (0x1F260, 0x1F265),
        (0x1F300, 0x1F320), (0x1F32D, 0x1F335), (0x1F337, 0x1F37C), (0x1F37E, 0x1F393),
        (0x1F3A0, 0x1F3CA), (0x1F3CF, 0x1F3D3), (0x1F3E0, 0x1F3F0), (0x1F3F4, 0x1F3F4),
        (0x1F3F8, 0x1F43E), (0x1F440, 0x1F440), (0x1F442, 0x1F4FC), (0x1F4FF, 0x1F53D),
        (0x1F54B, 0x1F54E), (0x1F550, 0x1F567), (0x1F57A, 0x1F57A), (0x1F595, 0x1F596),
        (0x1F5A4, 0x1F5A4), (0x1F5FB, 0x1F64F), (0x1F680, 0x1F6C5), (0x1F6CC, 0x1F6CC),
        (0x1F6D0, 0x1F6D2), (0x1F6D5, 0x1F6D7), (0x1F6DC, 0x1F6DF), (0x1F6EB, 0x1F6EC),
        (0x1F6F4, 0x1F6FC), (0x1F7E0, 0x1F7EB), (0x1F7F0, 0x1F7F0), (0x1F90C, 0x1F93A),
        (0x1F93C, 0x1F945), (0x1F947, 0x1F9FF), (0x1FA70, 0x1FA7C), (0x1FA80, 0x1FA89),
        (0x1FA8F, 0x1FAC6), (0x1FACE, 0x1FADC), (0x1FADF, 0x1FAE9), (0x1FAF0, 0x1FAF8),
        (0x20000, 0x2FFFD), (0x30000, 0x3FFFD),
    ]

    /// Recherche dichotomique dans la table triée.
    private static func isWide(_ value: UInt32) -> Bool {
        var low = 0
        var high = wideRanges.count - 1
        while low <= high {
            let middle = (low + high) / 2
            let range = wideRanges[middle]
            if value < range.0 {
                high = middle - 1
            } else if value > range.1 {
                low = middle + 1
            } else {
                return true
            }
        }
        return false
    }
}
