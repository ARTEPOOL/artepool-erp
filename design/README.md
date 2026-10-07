# ARTÉPOOL ERP — UI design reference (v1.3)

Approved visual reference for the desktop client. Build the real screens (React + CSS Modules, decision 0001) to match these files. Do not ship these HTML files.

Open `index.html` in a browser to browse every screen. Each screen has a dark preview bar at the top (not part of the product) with a state picker, and an AR/EN switch that flips the text and direction.

## Files

| File | What it is |
|---|---|
| `artepool-tokens.css` | Design tokens (colors, type, spacing, radius, sizes). The client's token layer must use these names and values. |
| `artepool-design-system.md` | Design system (Arabic): roles, components, RTL rules, keyboard shortcuts, and the decisions behind each screen. |
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

Screens 01–03 were designed in ChatGPT; 04–10 and the POS clipping fix were added in v1.3.

## Rules for implementation

- Use the tokens; never hard-code colors, fonts or spacing (golden rule 12).
- Use logical CSS properties (`inline-start/end`, `margin-inline`, `text-align: start`) so one layout serves RTL and LTR.
- Do not use `scrollbar-gutter: stable` in containers that can be RTL; it clips content in Chromium (the v1.2 POS bug).
- Money, codes, TRNs, barcodes and dates sit in LTR-isolated elements (`<bdi>`), with tabular numerals.
- Every status is a name plus an icon, never color alone.
- Sample data in these files is fictional. The seller's legal name in English, address, phone, TRN and bank details must come from company settings.
- Fonts (IBM Plex Sans Arabic) and icons (Lucide) are embedded here for offline preview; in the app, bundle them locally (no CDN).
