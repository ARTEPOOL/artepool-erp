# 0068 — The app's fonts: GE SS TV for Arabic, Tw Cen MT for English

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Decided by** | Owner |

## Decision
- **Arabic letters:** GE SS TV Medium (Boutros International), on every screen, every A4 printout and the thermal receipt.
- **Digits and English body text:** they never use the Arabic font, because it draws 0–9 as Arabic-Indic digits, which must not appear in prices, totals, TRNs or IBANs. They stay in IBM Plex Sans Arabic, which reads well in tables and forms.
- **English headings:** Tw Cen MT Condensed Extra Bold (Monotype), for titles and headings only, on screens (h1–h3, the `--font-heading` token) and on A4 printouts (title, company name, section headings). It is too narrow and heavy for tables and body text. The thermal receipt keeps one font.
- **Licence:** the owner confirmed the licence allows bundling the fonts in the app and printing with them.

## How it works
- The file is in `assets/fonts/`. A `@font-face` with a `unicode-range` limited to Arabic letters makes the browser use it for Arabic only. Every other character falls through to the next font in `--font-family`.
- The A4 renderer embeds the same file in each printout, so the server prints the same shapes on any PC.

## Consequences
- Only one Arabic weight (Medium) exists; bold Arabic is drawn by the browser from it. A Bold file can be added later without code changes beyond its `@font-face`.
- Documents issued before this change reprint with the new font: fonts are not part of the stored template version.
