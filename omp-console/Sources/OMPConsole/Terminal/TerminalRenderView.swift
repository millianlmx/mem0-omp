// La zone de rendu du terminal (le shell, et la TUI d'omp qu'il lance) : une grille
// de cellules peinte par CoreText, le curseur, et la traduction clavier → octets du
// PTY (S-5, S-6, BR-3).
//
// Trois décisions structurent ce fichier :
//
//   1. `TerminalKeys.bytes` est une fonction PURE, hors de la vue : la table de
//      S-5 se prouve sans fenêtre ni événement synthétique.
//   2. La construction d'une rangée est une valeur (`TerminalRowRendering`), pas
//      une méthode de la vue : l'invariant de S-3 (largeur typographique de la
//      CTLine == colonnes × largeur de cellule) se teste sans NSView.
//   3. La mesure ne déclenche AU PLUS qu'un redimensionnement par tour de boucle
//      principale (S-6) : `layout()` pose un drapeau, le tour suivant mesure.
//
// Le fond est peint avec la couleur de fond de la palette AVANT la grille : la
// fenêtre n'a jamais de rectangle vide, même quand le shell n'a encore rien écrit.

import AppKit
import CoreText
import SwiftUI

/// La frappe transmise au PTY : le jeu clavier **legacy** de Doc-1 §8, et rien
/// d'autre. Une entrée qui n'est pas dans la table n'est PAS transmise (`nil`).
enum TerminalKeys {
    /// `nil` = aucun octet à envoyer (⌘, Option, F-touches, PageUp/Down,
    /// Début/Fin, ou une touche morte sans texte).
    static func bytes(characters: String?, modifiers: NSEvent.ModifierFlags, keyCode: UInt16) -> [UInt8]? {
        guard let characters, !characters.isEmpty else { return nil }
        let flags = modifiers.intersection(.deviceIndependentFlagsMask)
        // ⌘ et Option sont des gestes de l'app ou du système (S-5) ; le PTY est en
        // mode brut, mais rien de ce qui les porte n'est transmis.
        if flags.contains(.command) || flags.contains(.option) { return nil }

        switch keyCode {
        case 36, 76: return [0x0D]                  // Retour, Entrée du pavé numérique
        case 51: return [0x7F]                      // Retour arrière
        case 48: return [0x09]                      // Tabulation
        case 53: return [0x1B]                      // Échap (il part au PTY, il ne ferme rien)
        case 123: return escape("[D")               // ←
        case 124: return escape("[C")               // →
        case 125: return escape("[B")               // ↓
        case 126: return escape("[A")               // ↑
        default: break
        }

        if flags.contains(.control) {
            guard characters.unicodeScalars.count == 1, let scalar = characters.unicodeScalars.first else {
                return nil
            }
            // AppKit rend déjà l'octet de contrôle pour la plupart des Ctrl+lettre ;
            // la table couvre les formes où il rend le caractère nu.
            if scalar.value >= 0x01, scalar.value <= 0x1F { return [UInt8(scalar.value)] }
            return controlByte(for: scalar).map { [$0] }
        }

        // Les touches de FONCTION (F1…, PageUp/Down, Début/Fin, Suppr. avant) sont
        // livrées avec ce drapeau et portent des scalaires de la zone à usage privé
        // (`U+F700`…) : ni l'un ni l'autre n'est du texte, et aucune n'est transmise
        // (S-5). Le test du `keyCode` ci-dessus a déjà traité flèches et Échap, qui
        // portent eux aussi ce drapeau.
        if flags.contains(.function) { return nil }

        var bytes: [UInt8] = []
        for scalar in characters.unicodeScalars {
            // Aucun octet de contrôle n'est jamais produit (S-5), `0x00` compris.
            if scalar.value < 0x20 || scalar.value == 0x7F { return nil }
            bytes.append(contentsOf: Array(String(scalar).utf8))
        }
        return bytes.isEmpty ? nil : bytes
    }

    private static func escape(_ suffix: String) -> [UInt8] {
        Array(("\u{1B}" + suffix).utf8)
    }

    /// Ctrl + lettre = `0x01`-`0x1A`, Ctrl + `\`/`]`/`^`/`_`/`[` = `0x1C`-`0x1F`/`0x1B`.
    /// `@` et `2` (qui donneraient `0x00`) ne sont pas transmissibles.
    private static func controlByte(for scalar: Unicode.Scalar) -> UInt8? {
        switch scalar {
        case "a"..."z": return UInt8(scalar.value - 0x60)
        case "A"..."Z": return UInt8(scalar.value - 0x40)
        case "\\": return 0x1C
        case "]": return 0x1D
        case "^": return 0x1E
        case "_": return 0x1F
        case "[": return 0x1B
        default: return nil
        }
    }
}

/// Le rendu d'UNE rangée : chaque cellule porte sa police, sa couleur d'avant-plan
/// et son fond. Une cellule de continuation ne contribue aucun caractère (le
/// grapheme large occupe déjà deux colonnes).
enum TerminalRowRendering {
    /// La police d'une cellule : monospace, graisse pour `bold`, italique si le
    /// système en fournit une variante (sinon la police droite, jamais une police
    /// proportionnelle).
    static func font(for attributes: TerminalAttributes, base: NSFont, bold: NSFont, italic: NSFont) -> NSFont {
        var font = attributes.bold ? bold : base
        if attributes.italic { font = italic }
        return font
    }

    static func attributedString(
        for cells: [TerminalCell],
        palette: TerminalPalette,
        base: NSFont,
        bold: NSFont,
        italic: NSFont
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for cell in cells where !cell.isContinuation {
            let attributes = cell.attributes
            var foreground = palette.foreground(attributes.foreground)
            var background = palette.background(attributes.background)
            if attributes.inverse { swap(&foreground, &background) }
            if attributes.dim { foreground = foreground.dimmed }

            var traits: [NSAttributedString.Key: Any] = [
                .font: font(for: attributes, base: base, bold: bold, italic: italic),
                .foregroundColor: foreground.nsColor,
            ]
            // Le fond par défaut est déjà peint par la vue : ne poser l'attribut que
            // quand la cellule en change, pour ne pas créer un run par cellule.
            if background != palette.defaultBackground {
                traits[.backgroundColor] = background.nsColor
            }
            if attributes.underline {
                traits[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            result.append(NSAttributedString(string: cell.text.isEmpty ? " " : cell.text, attributes: traits))
        }
        return result
    }

    static func line(
        for cells: [TerminalCell],
        palette: TerminalPalette,
        base: NSFont,
        bold: NSFont,
        italic: NSFont
    ) -> CTLine {
        let text = attributedString(for: cells, palette: palette, base: base, bold: bold, italic: italic)
        return CTLineCreateWithAttributedString(text)
    }
}

@MainActor
final class TerminalRenderView: NSView {
    /// L'émulateur courant. `nil` avant le premier lancement : la vue n'affiche
    /// alors que le fond de la palette.
    weak var emulator: TerminalEmulator?
    var palette: TerminalPalette = .init(
        defaultForeground: .init(0xE6, 0xE6, 0xE6),
        defaultBackground: .init(0x14, 0x14, 0x14)
    ) {
        didSet { needsDisplay = true }
    }

    /// La zone mesurée, en colonnes × rangées (S-6). Appelé au plus une fois par
    /// tour de boucle principale.
    var onResize: ((Int, Int) -> Void)?
    /// Chaque `keyDown` de S-5, déjà traduit en octets.
    var onKey: (([UInt8]) -> Void)?
    /// L'apparence effective de la vue, à chaque changement (bascule système,
    /// app active ou non) et à chaque installation dans une fenêtre. Rappelé au
    /// tour suivant de la boucle principale : rien n'est publié pendant une mise à
    /// jour SwiftUI.
    var onAppearanceChange: ((NSAppearance) -> Void)?

    private let fontSize: CGFloat = 13
    private lazy var baseFont = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    private lazy var boldFont = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .bold)
    /// L'italique du système SI son avance est celle de la police droite : une
    /// variante plus large décalerait toutes les colonnes suivantes, et la largeur
    /// de cellule doit rester celle du monospace pour TOUTES les cellules (S-3).
    private lazy var italicFont: NSFont = {
        let converted = NSFontManager.shared.convert(baseFont, toHaveTrait: .italicFontMask)
        return advance(of: converted) == advance(of: baseFont) ? converted : baseFont
    }()

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    // MARK: - Apparence

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        reportAppearance()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        reportAppearance()
    }

    private func reportAppearance() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.onAppearanceChange?(self.effectiveAppearance)
        }
    }

    // MARK: - Mesure

    /// L'avance de « M » dans une police donnée : la largeur d'une colonne.
    private func advance(of font: NSFont) -> CGFloat {
        let ctFont = font as CTFont
        var glyph = CTFontGetGlyphWithName(ctFont, "M" as CFString)
        var advance = CGSize.zero
        CTFontGetAdvancesForGlyphs(ctFont, .horizontal, &glyph, &advance, 1)
        return advance.width
    }

    /// Largeur d'une cellule : l'avance de « M » dans la police monospace. C'est la
    /// SEULE largeur employée pour positionner une colonne, glyphe large compris.
    var cellWidth: CGFloat {
        let width = advance(of: baseFont)
        return width > 0 ? width : fontSize * 0.6
    }

    var cellHeight: CGFloat {
        let ctFont = baseFont as CTFont
        return ceil(CTFontGetAscent(ctFont) + CTFontGetDescent(ctFont) + CTFontGetLeading(ctFont))
    }

    /// La marge intérieure, sur les quatre côtés : le texte ne colle jamais au
    /// bord de la fenêtre. Elle est retirée de la zone mesurée, donc la dernière
    /// rangée et la dernière colonne tiennent entières.
    static let contentInset: CGFloat = 10

    /// La grille qui tient dans la zone d'affichage, marges déduites, bornée au
    /// minimum de S-6.
    func measuredGrid() -> (columns: Int, rows: Int) {
        let inset = TerminalRenderView.contentInset
        let columns = Int(floor(max(bounds.width - 2 * inset, 0) / cellWidth))
        let rows = Int(floor(max(bounds.height - 2 * inset, 0) / cellHeight))
        return (max(columns, TerminalRenderView.minimumColumns), max(rows, TerminalRenderView.minimumRows))
    }

    static let minimumColumns = 20
    static let minimumRows = 5

    private var appliedColumns: Int?
    private var appliedRows: Int?
    private var measureScheduled = false

    override func layout() {
        super.layout()
        scheduleMeasure()
    }

    /// Au plus une mesure par tour de boucle principale : une rafale de
    /// redimensionnements n'écrit pas un `ioctl` par pixel (S-6).
    private func scheduleMeasure() {
        guard !measureScheduled else { return }
        measureScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.measureScheduled = false
            let grid = self.measuredGrid()
            guard grid.columns != self.appliedColumns || grid.rows != self.appliedRows else { return }
            self.appliedColumns = grid.columns
            self.appliedRows = grid.rows
            self.onResize?(grid.columns, grid.rows)
        }
    }

    // MARK: - Clavier

    override func keyDown(with event: NSEvent) {
        guard let bytes = TerminalKeys.bytes(
            characters: event.characters,
            modifiers: event.modifierFlags,
            keyCode: event.keyCode
        ) else {
            // Un `keyDown` sans octet est ABSORBÉ sans effet (S-5) : il ne doit pas
            // remonter à la chaîne de répondants et faire « bip ».
            return
        }
        onKey?(bytes)
    }

    // MARK: - Rendu

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.setFillColor(palette.defaultBackground.nsColor.cgColor)
        context.fill(bounds)

        guard let screen = emulator?.screen else { return }
        let rows = min(screen.rows, measuredGrid().rows)

        context.saveGState()
        // La vue est `isFlipped` (contenu ancré en haut à gauche) ; CoreText peint
        // depuis la ligne de base vers le haut : on rétablit une base d'axe montant
        // pour poser les lignes.
        context.translateBy(x: 0, y: bounds.height)
        context.scaleBy(x: 1, y: -1)
        context.textMatrix = .identity

        let descent = CTFontGetDescent(baseFont as CTFont)
        let inset = TerminalRenderView.contentInset
        for row in 0..<rows {
            let line = TerminalRowRendering.line(
                for: screen.line(row),
                palette: palette,
                base: baseFont,
                bold: boldFont,
                italic: italicFont
            )
            context.textPosition = CGPoint(
                x: inset,
                y: bounds.height - inset - CGFloat(row + 1) * cellHeight + descent
            )
            CTLineDraw(line, context)
        }
        context.restoreGState()

        if screen.cursorVisible, screen.cursor.row < rows {
            let cell = CGRect(
                x: inset + CGFloat(screen.cursor.column) * cellWidth,
                y: inset + CGFloat(screen.cursor.row) * cellHeight,
                width: cellWidth,
                height: cellHeight
            )
            context.setFillColor(cursorColor(for: screen).cgColor)
            context.fill(cell)
        }

        // Le rendu a consommé les rangées modifiées : la vue ne se redessine pas
        // tant que rien n'a bougé.
        emulator?.clearChanged()
    }

    /// Le curseur est un rectangle plein de la couleur d'AVANT-PLAN de la cellule
    /// qu'il recouvre (S-4) : la même que celle du glyphe peint, inverse compris.
    private func cursorColor(for screen: TerminalScreen) -> NSColor {
        let row = screen.cursor.row
        let column = screen.cursor.column
        guard row >= 0, row < screen.rows, column >= 0, column < screen.columns else {
            return palette.foreground(.default).nsColor
        }
        let attributes = screen.line(row)[column].attributes
        if attributes.inverse {
            return palette.background(attributes.background).nsColor
        }
        return palette.foreground(attributes.foreground).nsColor
    }
}

struct TerminalViewRepresentable: NSViewRepresentable {
    let emulator: TerminalEmulator?
    let palette: TerminalPalette
    let onResize: (Int, Int) -> Void
    let onKey: ([UInt8]) -> Void
    let onAppearanceChange: (NSAppearance) -> Void

    func makeNSView(context: Context) -> TerminalRenderView {
        let view = TerminalRenderView()
        view.onResize = onResize
        view.onKey = onKey
        view.onAppearanceChange = onAppearanceChange
        view.emulator = emulator
        view.palette = palette
        // Le focus clavier va à la zone de rendu dès que la vue est installée :
        // `view.window` n'est pas encore renseigné à `makeNSView` (motif du pont
        // `WindowAccessor`).
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }

    func updateNSView(_ view: TerminalRenderView, context: Context) {
        view.onResize = onResize
        view.onKey = onKey
        view.onAppearanceChange = onAppearanceChange
        view.emulator = emulator
        view.palette = palette
        if let screen = emulator?.screen, !screen.changedRows.isEmpty {
            view.needsDisplay = true
        }
    }
}
