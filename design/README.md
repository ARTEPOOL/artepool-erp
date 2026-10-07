# ARTÉPOOL ERP — UI design reference (v2, simple)

Approved visual reference for the desktop client. Build the real screens (React + CSS Modules, decision 0001) to match these files. Do not ship these HTML files.

Open `index.html` in a browser to browse every screen. Each screen has an AR/EN switch, a light/dark switch, and (where a screen has several states) a small dark preview pill at the bottom to pick the state. The pill is not part of the product.

v2 replaces v1.3. The owner approved a simpler look: light grey background, white cards with thin borders and no shadows, turquoise only where it matters, short calm motion, and light and dark modes.

## Files

| File | What it is |
|---|---|
| `artepool-tokens.css` | Design tokens for light and dark modes (colors, type, spacing, radius, sizes, motion). The client's token layer must use these names and values. |
| `artepool-components.css` | Reference styles for shared components (cards, buttons, chips, fields, shell, motion keyframes). |
| `artepool-design-system.md` | Design system v2 (Arabic): principles, colors in both modes, components, motion rules, screen list. |
| `screens/01-login.html` | Sign-in: password, PIN for cashiers, owner 2-step code, server status, error states |
| `screens/02-dashboard.html` | App shell (sidebar, top bar) and owner dashboard |
| `screens/03-pos.html` | POS counter (1366×768, no page scroll) |
| `screens/04-payment.html` | Payment dialog: cash, card, split, short cash, success |
| `screens/05-a4-invoices.html` | A4 documents list: invoices, advance payments, credit notes, quotations, drafts |
| `screens/06-invoice-form.html` | New tax invoice / quotation / advance payment invoice |
| `screens/07-items-stock.html` | Items and stock with item detail panel |
| `screens/08-shift-close.html` | Shift close: blind count, supervisor review, Z report |
| `screens/09-a4-tax-invoice.html` | Printed A4 bilingual tax invoice (one page; original and copy) |
| `screens/10-thermal-receipt.html` | 80 mm simplified tax invoice receipt (original and copy) |
| `screens/11-print-designer.html` | Print designer (Settings): live preview, logo, colour, print language, optional fields, texts, paper; tax fields locked (decision 0020) |
| `screens/12-reports.html` | Reports: sales, VAT return summary with the quarterly export package and annual archive, stock, cash and shifts, profit and loss |
| `screens/13-settings.html` | Settings: company, users and role permissions, VAT and numbering, devices and printers, backup, audit log; links to the print designer |


## Rules for implementation

- Use the tokens; never hard-code colors, fonts or spacing (golden rule 12).
- Use logical CSS properties (`inline-start/end`, `margin-inline`, `text-align: start`) so one layout serves RTL and LTR.
- Do not use `scrollbar-gutter: stable` in containers that can be RTL; it clips content in Chromium (the v1.2 POS bug).
- Money, codes, TRNs, barcodes and dates sit in LTR-isolated elements (`<bdi>`), with tabular numerals.
- Every status is a name plus an icon, never color alone.
- Motion: POS animations at most 150 ms, other screens at most 250 ms; never animate money amounts; disable all motion when the OS asks for reduced motion.
- Printed documents (09, 10) and the print designer preview stay black on white in dark mode.
- 09 and 10 show the default template. The print designer (11) changes the template; the real renderers must read the template version stored on each document.
- Sample data in these files is fictional. The seller's legal name in English, address, phone, TRN and bank details must come from company settings.
- Fonts (IBM Plex Sans Arabic) and icons (Lucide) are embedded here for offline preview; in the app, bundle them locally (no CDN).
