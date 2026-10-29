# Changelog

## Releases: merge and approve, no git commands (2026-10-29)

**In plain words:** to send a new version to the shop, you now merge its pull request and approve it once in GitHub. The git commands (`git tag …`, `git push …`) are no longer needed. A merge that does not change the version sends nothing, and a version is never sent twice. One setting must be changed once: the `release` environment must allow the `main` branch (the updates guide, step 5).

- `.github/workflows/release.yml` runs on every merge to `main`. It releases only when the app's version is not yet published in `ARTEPOOL/artepool-releases`, waits for the owner's approval as before, and adds the version tag afterwards. "Run workflow" starts it again by hand. Decision 0112.

## Installation, part I: power cuts, and the POS's last invoice (2026-10-29)

**In plain words:**

- **A sale the program confirmed survives a power cut.** The database writes every sale to the disk before saying "done". The server setup sets this up, and an update turns it back on if anything turned it off.
- **A sale cut off half way leaves nothing behind.** There is no half invoice, no number is used, and stock and cash do not move. Pressing "Pay" again makes exactly one sale.
- **After every start of the server** (after a power cut too), the integrity checks run once by themselves. Before, they ran only at night.
- Settings → System health → Server PC has a new line, **"Protection from power cuts"**. It shows whether the protection is on, when the database last started, and the result of the check after that start. If anything is off, the owner gets an alert.
- **The POS always shows the shift's last invoice** under "New sale": number, time, total, and a **Reprint** button. After a power cut the cart is empty, and this line tells the cashier whether the last sale went through before ringing it again.

- Migration 0047 (integrity run kind `after_start`, alert `durability_off`). Decision 0111.
- Tests: a sale whose database connection is killed while it waits for its number, and a real database stopped the way a power cut stops it, then recovered. Both check that nothing is half done, the books balance and the numbering has no gap. Plus unit, desktop and screen tests in both languages. CI installs the PostgreSQL 18 server for the power-cut test.

## Invoices (A4): a cancelled invoice says so in the list (2026-10-29)

**In plain words:** an invoice you cancelled (or edited) with a credit note used to show in the list as "Issued · Paid" like any other, and the "Cancelled" filter found nothing: that filter only found drafts thrown away.

- In the list, a cancelled invoice now shows **"Cancelled · CN-…"** (or **"Replaced (edited) · CN-…"**) in red, instead of "Issued" and "Paid". The invoice page shows the same.
- The credit note's row says which invoice it belongs to ("for INV-…").
- The status filter has clear choices: **Draft**, **Issued** (the ones still standing), **Cancelled (by a credit note)** and **Discarded draft**. "All" shows everything except discarded drafts.
- Nothing changed in the accounts or VAT: the invoice is never changed or deleted; the credit note cancels it (decision 0072).

## Updates: "Check now", and clearer messages when an update fails (2026-10-28)

**In plain words:**

- Settings → Backups → Updates has a **"Check now"** button (owner only). The server PC checks for a new version within 5 minutes, and the card says "Checking for updates…" until it has. It still checks by itself every few hours and installs at night, as before.
- After an update, the card no longer shows the version you are already running as a "new version" with "installing now…" and an "Install now" button. It checks again at once and says "Up to date".
- Release notes show one point per line.
- If an update fails, the setup's message and its log now say **why**, not only "exit code 1".
- A PC that once had a **test version** from the GitHub tests says so in plain words: delete the data and install again. Test versions are now named `…-TEST.exe` and warn first that they are never for the shop.
- The "Kiosk lock is off" bar sits above the page instead of covering a card.
- The external drive folder shows "Example: E:\" so it does not look already filled in.

- Migration 0046 (`ops.update_state.check_requested_at`, owner only, audited). Decision 0110.
- Tests: integration (updater, API, upgrade check), unit (version compare, installer names), desktop and screen tests in both languages; the Windows CI checks the reason in the setup's log.

## Installation, part H: the server PC's health, and a certificate that renews itself (2026-10-26)

**In plain words:** Settings → System health now starts with a **"Server PC"** card. It shows, in green, orange or red:

- the last backup (and how long ago it was);
- the backup key;
- free space on the database, backups and Windows disks;
- whether the backup service and the database's continuous copy are working;
- the server certificate and the root certificate, with their end dates;
- the server clock;
- whether a UPS is connected. You confirm it once with a button, and it asks again after six months.

Anything that needs attention also appears on the owner dashboard and as an owner alert, once a day.

**The server certificate now renews itself** 60 days before it ends:
- It happens at night and never while a shift is open.
- The new certificate is checked before it is used.
- The old one is kept and put back if anything fails, and it tries again the next night.
- Every renewal is written in the audit log with the old and new end dates (no keys).
- The other PCs need nothing, because they trust the same root certificate.

The root certificate is renewed by hand with your approval; the screen warns two years ahead.

- Migration 0045 (`ops.server_health`, `system.health.manage`, new alert types).
- Tests: unit, integration (API, renewal, database rules), desktop and screen tests in both languages.

## Installation, part F: the installers, the emergency tool, start at sign-in and the watchdog (2026-10-25)

**In plain words:** ARTÉPOOL now installs like any Windows program.

- **`ARTEPOOL-Server-Setup`** goes on the server PC (the cashier PC). It installs everything by itself:
  - the database and the server, each running in the background as its own Windows service;
  - the backups and the security certificates;
  - one firewall rule for the shop's network only.

  Then it opens the app on the first-run setup. Uninstalling it removes the programs and keeps all the data and backups.
- **`ARTEPOOL-Office-Setup`** goes on the office PCs and the laptop. It needs no internet.
- **"ARTEPOOL – Emergency tool"** is in the server PC's Start menu, so nobody ever types a command at the shop. Windows asks for the administrator's permission first, so a cashier cannot open it. It can:
  - give the owner a temporary password;
  - clear the owner's phone code;
  - make a code to connect a PC;
  - check the system (services, protected secrets, database), line by line in green or red;
  - open the logs folder for support.

  Every change is written to the audit log with its reason. Guide: `docs/runbooks/emergency-tool.md`.
- **On the cashier PC** the app starts by itself when someone signs in to Windows. If it is closed by force while the kiosk lock is on, it comes back within seconds, and the owner gets an alert ("restarted", or "not running" if nothing brought it back).
- **Install and uninstall logs** are kept in `C:\ProgramData\ARTEPOOL\logs\install` for support. They never contain a password, key or token.

**Still to do:** the owner or a technician tests this on clean Windows 11 Home, Windows 11 Pro and Windows 10 Home test machines, using `docs/runbooks/vm-test-part-f.md`. That test covers a real USB stick, the administrator prompt in front of a person, and the cashier PC's restart after it is closed by force. The list of emergency-tool actions in decision 0107 waits for the owner's confirmation.

- Decision 0107. No database change.
- Tests:
  - the install program, end to end against a real database;
  - the emergency actions against a real database, with the audit log and no secret in it;
  - the emergency window in Arabic and English (screen tests and a real browser);
  - the watchdog's rules and the sign-in task (Rust).
- On a Windows runner, each push:
  - builds the installers;
  - installs silently and checks the three services and their own accounts, TLS 1.3, no database on the network, the folder rules, the firewall rule, the secrets, the sign-in task, the watchdog's three cases and the emergency tool's actions;
  - restarts the services, makes the shop's encrypted copy, uninstalls, wipes, installs again and restores it;
  - uninstalls the server and the desktop app;
  - scans every log for every secret.

## Installation, part E (last piece): "Restore from backup" in the setup screen (2026-10-24)

**In plain words:** the first-run setup now offers **Restore from backup** next to New setup. It finds the backup copies by itself on a USB stick or the external drive, and in Downloads, Desktop and Documents (a Google Drive copy is downloaded first from drive.google.com, then it shows up there), newest first; you can also type the file's path. For a Google Drive copy you give your private key, typed or loaded from the key file; it is used only to open the copy and is never saved. You confirm, the screen shows each step (opening, restoring, updating, checking everything, putting it in place, a fresh backup), and at the end it says your data is back, how many old PCs must be enrolled again, and to reconnect Google Drive. Then this PC is enrolled as the point of sale with one press, and everyone signs in with their old password and phone code. If anything is wrong (wrong key, damaged or changed copy), it says so and nothing is changed. The guide is `docs/runbooks/restore-on-new-pc.md`.

- Decision 0102 amended (the Google Drive copy is downloaded first); no database change.
- Also fixed: the server no longer stops when the database closes an idle connection (a PostgreSQL restart or the restore's swap); it opens a new one.
- Tests: the screens in Arabic (an encrypted copy with a wrong then right key, the steps, the result, this PC enrolled with the restore's code; a plain copy with its warning; nothing found and a wrong path; a failed restore; the program not starting); the key found in a key file or a paste; the Windows side finds copies newest first, gives the key only on the program's input, keeps the steps and result, one restore at a time; a real-browser restore in Arabic and English: the shop's encrypted copy on a USB drive, the key file, the restore on a fresh server, this PC enrolled, and a person signs in with their old password and phone code.

## Installation, part E (second piece): the restore engine (2026-10-24)

**In plain words:** the part that brings a backup back on a new server PC is built and tested (the setup screens for it come next). Given a copy (from Google Drive, the external drive or a USB stick) and, for an encrypted one, your private key, it puts the copy into a **separate** database first, brings it up to the current version, and runs **every check** (audit chain, journals, trial balance, stock, numbering). **Only if all pass** does it take the place of the new installation's empty database; that empty one is kept aside, never deleted. Then it puts the copy's master key back (so passwords and phone codes keep working), marks the old PCs "enroll again", gives a one-time code to enroll this PC, and makes a fresh copy with a restore test. A wrong key, a changed copy, a copy of an installation that was never set up, or a PC that is already in use: nothing is replaced. It runs only as a Windows administrator; the database superuser's password is kept protected like the other secrets and is given to this program alone.

- No database change.
- Tests: a full restore of a real copy (old data back, old PCs revoked, the restore in the audit log, the empty database kept aside and closed); a wrong key, a changed audit log, a copy never set up and an installation in use change nothing; a plain external-drive copy restores without a master key; the master key goes back (development: the old key file kept); this PC's enrollment code; the fresh copy and restore test; the Windows services stopped and waited for; the key handed to the launcher on its input, never on the command line; the launcher gives the superuser's password to the restore alone; the bundled program refuses a file that is not a copy.

## Every Windows edition, and a Windows 10 warning (2026-10-24)

**In plain words:** the system is built to run on Windows 10 and Windows 11, every edition (Home, Pro and Enterprise), not only on the shop PC's Windows 10 Pro. Nothing depends on a Pro-only feature: the cashier's limits are set in the registry (Home honours them), disk encryption is recommended where Windows offers it but never required, and the test machines use VirtualBox. Before go-live the installation is tested on Windows 11 Home, Windows 10 Home and Windows 11 Pro. When the setup screen opens on a Windows 10 PC, it now shows a warning that Windows 10 no longer gets free security updates and advises upgrading; the setup continues as usual.

- Decision 0106 (amends 0104); no database change.
- Tests: the warning shows on Windows 10 and the setup goes on; no warning on Windows 11; the PC's Windows build reaches the screen.

## Installation, part E (first piece): the encrypted copy carries the master key (2026-10-22)

**In plain words:** the daily copy that goes to Google Drive now holds, inside its encryption, the server's master key together with the database copy (decision 0102). Only your offline private key opens it. So if the server PC is ever lost, the restore (coming next) brings back everything, including everyone's phone 2-step codes, not only the data. Copies made before today, and the external-drive copies, still restore; after restoring one of those the 2-step codes are set up again. For the technical emergency path there is a new command, `pnpm backup:open`, which opens an encrypted copy with the private key. The shop PC is recorded as Windows 10 Pro.

- No database change.
- Tests: the copy holds the database copy and the master key, only the private key opens it, a changed copy or another key is refused, plain copies still open; the upload test now checks the contents; `backup:open` writes the copy only with the right key and never overwrites a file.

## Installation, part D: the first-run wizard, "New setup" (2026-10-22)

**In plain words:** right after the server is installed, the app on the server PC opens the first-run setup by itself, in Arabic or English. You choose **New setup** ("Restore from backup" is shown but comes with the next part), then in five steps: the **company details** (and the logo if you want), **your owner account**, the **phone code** (scan the QR code, type the 6 digits), your **10 recovery codes** (print or write them; you confirm before going on), and **this PC**, enrolled as the point of sale. Then **Finish**: the setup closes for good and the normal sign-in screen appears. If the app is closed halfway, it starts again where it stopped. The setup works only on the server PC itself, only with the one-time key the installer leaves there (only Windows administrators can read it), and never again once finished. Every step is written to the audit log as "setup wizard".

- Decisions 0092, 0102; no database change beyond part C.
- Tests: the server refuses without the key, with a wrong key, from another PC, before starting and after finishing; a full run gives the company, the owner with the phone code and 10 recovery codes, and this PC as a POS through the real enrollment; the audit trail; the screens in Arabic (a full run, a refused password, picking up halfway, no wizard on other PCs); the Windows side reads only the installer's files and sends only setup steps; a real-browser run in Arabic and English against a fresh server.

## Installation, part C: the first-run state and the server clock guard (2026-10-22)

**In plain words:** two protections in the database, ready for the setup wizard. (1) The database now remembers whether the first-run setup on the server PC was done: "not started", "in progress" or "done". It only moves forward, so once the setup is done it can never be run again, and nobody can delete that record. Databases that already have an owner count as done. (2) **The server clock guard:** if the server PC's clock goes back (someone changes the date, or the battery of the clock fails) by more than 2 minutes before the last thing recorded, nothing can be saved, so nothing is ever recorded "in the past". The screen says: correct the date and time in Windows on the server PC. The owner gets a critical "server clock went back" alert. Once the clock is right again, everything works as before.

- Migration 0043 (`sys.setup_state`, `sys.clock_guard`, `sys.clock_status`); no screen change yet (the wizard is part D, the health screen part H).
- Tests: forward only, one step at a time, the path chosen once, no delete or second row, every change audited, a database with an owner marked done; writes allowed with normal drift (under 2 minutes), refused when the clock is further back, the alert alone let through, the audit chain intact; the server refuses with the right message and raises one alert per day.

## Installation, part B: the server packaged for the shop PC (2026-10-20)

**In plain words:** the server programs can now be packed into one folder for installing on the shop PC (`pnpm build:server`): no source code, no development settings. On the shop PC the settings live in one file (`C:\ProgramData\ARTEPOOL\config\server.json`) that may not contain any password. The five secrets (the master key and the four database passwords) are kept by Windows itself (DPAPI): they open only on that PC, in a folder only Windows and administrators can open. A small program, `artepool-svc`, unlocks them in memory when the server starts and never writes them anywhere in clear. If a secret is missing, does not open, or the folder is open to other users, the server refuses to start and says why. Nothing changes for you yet: you see this when the installer comes (part F).

- Decision 0103; no database change.
- Tests: the packed server, run from a folder outside the project with only the secrets, upgrades an empty database, refuses a common password, creates the owner and answers over TLS 1.3; it refuses to start without its settings file or its master key and never reads a `.env`; the settings file refuses any unknown key; pg_dump and the PDF browser never get a secret; the launcher's secrets (creation, replacement, a missing or swapped file, a folder or file open to others), and on the Windows test machine DPAPI and the folder access rules themselves.

## Barcode scanner: no need to click the search box first (2026-10-20)

**In plain words:** at the point of sale and in Items & stock, a scan now works wherever the cursor is: you no longer have to click in the search box first. At the point of sale the scanned item goes straight into the cart, even when it is not among the items shown on the screen and whatever category is chosen; in Items & stock its card opens. A scan is told apart from a person typing by its speed, so typing is never caught; a scan while a window is open (for example the payment window) is ignored, and the scanner's Enter never presses a button by mistake.

- Tests: scans anywhere (Latin letters with the Arabic keyboard, scanners without Enter), typing left alone, nothing caught in a field or while a window is open; at the point of sale a hidden item found by its barcode and put in the cart; in a real browser at the point of sale and in Items & stock.

## Labels: a language for each element; the English shop name under the Arabic one (2026-10-20)

**In plain words:** when the label was in both languages, the shop's name was written "Arabic / English" on one line, so the English part got cut ("ARTE SWIMMING PO…"). Now "both" always means two lines: the English line under the Arabic one, for the shop name, sale pack, price, "incl. VAT", expiry and batch. And each of these has its own **language** in the label designer: As the design, Arabic, English or Both. For example the price in English only ("AED 120.00") and the shop name in both. A size can have its own choice too (e.g. Arabic price only on 40 × 30). Designs you saved before print exactly as before.

- Decision 0101; no database change.
- Tests: two lines for "both", Arabic first, never "ar / en"; the price in one language; a per-size language; any design with any languages still never overlaps and keeps the barcode readable; the designer and the real label in a browser in Arabic and English.

## Labels: direct printing (TSPL) (2026-10-20)

**In plain words:** in Settings → Devices → "Label printer of this PC" there is a new choice, **Printing way**: "Windows driver" (as before) or **"Direct (TSPL)"**. Direct printing sends the label to the printer in its own language, without the Windows driver in between, so nothing is resized or blurred, and the darkness and speed you set are used. For direct printing you also set the **gap between labels** (usually 2 or 3 mm) and, if labels come out upside down, **"Turn the print round"**. Try it first with "Print test label" and "Print quality test". If direct printing fails, the app does not print again through the driver by itself (the printer might have printed part already, and you would get double labels): it tells you to try again or switch back to "Windows driver".

- Decision 0100; migration 0042 (gap and direction in the PC's label printer settings).
- Tests: the exact printer commands, the label placed under the print head for 50 and 40 mm labels, black stays black, the picture in the job is exactly the drawing, the printing way chosen, no automatic second print, the settings checked by the server and the database.

## Labels for many items at once, and the "price changed" list (2026-10-20)

**In plain words:** Items & stock has a new button, **"Labels for many items"**. You can fill it three ways: add items yourself (search or scan; scanning the same item again adds one more label), take the items of a stock increase or the opening stock (one label per piece that came in), or press **"Price changed"**: every item whose last printed label shows an old price, with the old and the new price side by side. A change of the price, of "price includes VAT", of the VAT category or of the VAT rate all count. You can filter that list by category. Each item starts with one label per piece on hand (0 when there is none; 1 for items sold by kg or metre), and you can change any number. The total is always shown, and above 100 labels the screen asks you to confirm. Every print is now recorded with the price on the label, so after printing the new prices the items leave the list. When labels go through the print dialog (no label printer set on that PC), the screen asks "Did the labels print?" and records only on "Yes".

- Decision 0099; migration 0041 (`inv.label_prints`, audited, never deleted; refuses a record whose price changed while printing).
- Tests: the record, the list for price / includes-VAT / category / rate changes, the category filter, a print whose price changed meanwhile, permissions, default counts, the confirmation above 100, and the whole flow in a real browser in Arabic and English.

## Barcode labels: 40 × 30 takes 10-character item codes (2026-10-20)

**In plain words:** on a 40 × 30 label, item codes like EQUIP-0001 or CLEAN-0001 (items without a supplier barcode) used to be refused. The blank space a scanner needs on both sides of the barcode may now use the label's side margin, always at least 0.5 mm away from the label's edge. The bars stay as wide as before (still easy to scan). A code that still does not fit is refused with "use 50 × 30". With a border on the label, the blank space stays inside the border.

- Decision 0098; no database change.
- Tests: every label keeps the blank space 0.5 mm from the edge; the 40 × 30 labels for EQUIP-0001 and CLEAN-0001 are read back by a barcode reader (also the real drawn label in a browser).

## Barcode labels: the owner's label design, crisper print, scanner fixes (2026-10-20)

**In plain words:** you now design the barcode label yourself in **Settings → Print designer → Barcode label**. Every part can be shown or hidden, moved up or down, made small, medium or large, bold or not, and put right, centre or left. The parts are: Arabic name, English name, sale pack (e.g. "كيس 25 كجم", typed on the item; otherwise its unit), barcode, item code, price, "شامل الضريبة", expiry date and batch number (typed when printing, for pool chemicals), print date, shop name and a free text line. The barcode can never be made smaller than what a scanner reads (bars at least 5 mm, 2 printer dots per bar, empty space at both sides). One design serves every size and adjusts by itself; for one size you can change only what is different (e.g. hide the English name on 40 × 30). The previews show a real item on every active size, and a size the design does not fit says "won't fit" instead of printing a broken label. "Print test label" and "Reset to default design" are in the designer; every save is a new version.

The label is now pure black and white at the printer's own dots (no grey edges), the Arabic letters are slightly bolder, and the label printer has **darkness** and **speed** settings plus a **"Print quality test"** label (fine lines, a black block, small and large text, barcodes at 2 and 3 dots). The barcode scanner works with the Arabic keyboard, and scanning a second time replaces the first code instead of adding to it.

- Decisions 0097, 0098; migrations 0039 (darkness, speed, mode on the label printer) and 0040 (sale pack on items, default label design); runbook `docs/runbooks/label-printer.md`.
- Tests: no overlap and minimum barcode for every size and design, barcodes read back by a barcode reader, only black and white dots in the printed image, the designer (override, save with the version it started from, minimum height, reset), scanner timing in a real browser.
- Next: printing labels for many items at once with the "price changed, label is old" list, then direct TSPL printing.

## Barcode labels, parts 2–5: drawn in millimetres, printed silently (2026-10-20)

**In plain words:** the barcode label is now drawn by the program itself at the label printer's own dots. Every part has its own place: the Arabic name (2 lines, smaller letters if needed, then "…"), the English name if you ask for it and there is room, the barcode (supplier EAN-13 stays EAN-13; bars are whole printer dots), the code, the price ("120.00 درهم" / "AED 120.00") and "شامل الضريبة" when the price includes VAT. Nothing overlaps, and nothing goes outside the printer's 48 mm. The preview is exactly what prints. With the label printer set in Settings → Devices, labels print straight away with no print dialog; "Print test label" helps move the print to the centre if it comes out to one side.

- Decision 0096; migration 0038 (label printer per PC on the server); runbook `docs/runbooks/label-printer.md`.
- Tests: no overlap for every size and long names (property tests), barcodes read back by a barcode reader at 203 and 300 dpi, price order in a real browser in Arabic and English.

## Barcode labels, part 1: sizes for the 2-inch printer (2026-10-20)

**In plain words:** the label sizes now match your label printer (2-inch roll). 50 × 30 mm comes first and is the default, then 50 × 25 and 40 × 30. The sizes that cannot print well on it (25 × 15, 30 × 20, 58 × 40, 100 × 50) are switched off (kept, not deleted). A new size can never be wider than the roll (50 mm). The new label drawing and silent printing follow in the next parts.

- Decision 0096 (updates 0043); migration 0037; rule `LABEL_TOO_WIDE`; PRD 1.30.

## Google Drive in one step (2026-10-19)

**In plain words:** connecting Google Drive is now like any "Sign in with Google": Settings → Backup → Connect Google Drive → Choose account; choose the shop's Google account and press Allow. No IDs or codes to type. The app's registration at Google is built into the installation, so any shop that installs the system just chooses its own account. If the browser does not open, "Connect with a code instead" still works.

- Decision 0095; no database change.

## Backups and System health (2026-10-19)

**In plain words:** the system now protects your data by itself. Every hour it makes a full copy on the server PC; every day it encrypts the newest copy with your backup key and puts it on the dedicated Google Drive account (Google only sees a locked file); every night it checks the books, the stock, the numbering and the audit log. Settings → Backup (owner only) shows all of it: what needs attention, "Back up now", "Restore test" (proves a copy really brings everything back), the external-drive copy (weekly reminder), the backup key (shown once: print it and save it on a USB stick) and the Google Drive connection. Problems also appear on your dashboard.

- Decision 0086 (owner's choices recorded); migration 0036; new backup service `apps/backup` (`pnpm backup:run`, `backup:once`, `backup:restore-test`, `backup:check`, `backup:offline`); runbook `docs/runbooks/backup-and-restore.md`.
- The accountant no longer has the health / restore test / integrity permissions (owner only).

## M6 plan approved (2026-10-19)

**In plain words:** the last building stage before the shop trial is split into five parts, done in this order: backups; the installers with a one-time setup wizard (no console needed); adding the cashier; locking down the cashier's Windows account; the owner's laptop on the shop network. Remote access from outside the shop is not part of Phase 1.

- Decisions 0092 (setup wizard), 0093 (no remote access in Phase 1; 0084 deferred), 0094 (adding the cashier and the laptop); 0025 and 0085 updated; PRD 1.28.

## The owner on the cashier PC lifts the kiosk lock (2026-10-19)

**In plain words:** when you sign in on the cashier PC, its lock lifts by itself; the top of the screen says "القفل متوقف · طول ما المالك داخل". When you sign out or press "Lock screen", the lock is back. The "Unlock with owner code" button (for when you are away and read the code over the phone) now lifts it for 15 minutes instead of 5.

- Decision 0091; migration 0035 (`ops_backup` moves to 0036).

## POS kiosk lock, "Lock screen" button (2026-10-19)

**In plain words:** a cashier PC now stays inside the ARTÉPOOL app. In the Windows app it opens full screen with no close button, and Alt+F4 does nothing (you get an alert). Only you can lift that lock:
- from your office PC: Settings → Devices → the cashier PC → "Turn off…" for 15 minutes, 1 hour or until you turn it back on, with a reason and your phone code;
- or on the cashier PC itself: "Unlock with owner code" and your current phone code, for 5 minutes only.

While it is off, the cashier PC shows "القفل متوقف · حتى الساعة …" at the top, and it comes back on by itself when the time is up. The cashier keeps the same PIN, shift and permissions either way. Every change and every attempt to close the app is in the audit log and in the "POS PC alerts" list (Settings → Devices and your dashboard). The POS screen also has a "Lock screen" button: the same cashier comes back with their PIN, and the shift stays open.

- Decisions 0082, 0083, 0089, 0090; migration 0034 (`ops_backup` moves to 0035).
- Still to come in M6 (installer): the watchdog that restarts the app, start at Windows sign-in, and the cashier Windows account settings (0085).

## The owner dashboard (2026-10-18)

**In plain words:** "Reports" in the side menu now opens your dashboard (owner only): total sales, sales without VAT, VAT due and profit for today, this week, this month, this year or any dates, each compared with the period before; sales day by day; POS vs A4, money per payment method and what is still unpaid; sales per employee; the top 10 items and customers; and right now: cash in the drawers and the safe, what customers owe and how much is late, the stock value and what needs reordering.

- Decision 0081; migration 0033 (`ops_backup` moves to 0034).

## Expected cash for the owner; drop alerts clear themselves (2026-10-18)

**In plain words:** on "My shift" the owner now sees the cash the drawer should hold, all the time; cashiers still count blind. The "transfer to the safe" alert disappears by itself once the drawer is back under AED 3,000 or the shift is closed, so old alerts for small amounts no longer stay on the list.

- Decision 0080; no database change.

## Screen lock can be turned off (2026-10-18)

**In plain words:** the "locked" screen no longer appears when a PC sits unused. In Settings → Devices → Screen lock you can turn it back on for office PCs or cashier PCs and choose the minutes.

- Decision 0079; migration 0032 (`ops_backup` moves to 0033).

## Thermal receipt: phone, email and TRN lines (2026-10-18)

**In plain words:** on the thermal receipt in both languages, the phone, email and TRN lines now read like the A4 invoice: the Arabic label on the right, the English label on the left, the value between them ("Tel: +971… :هاتف"). The email line now has its label too.

## Company details order in the A4 header (2026-10-18)

**In plain words:** the company name in the A4 header stands alone; the lines under it carry labels: address, phone, email, then the TRN (Arabic labels on the Arabic side, English on the English side). With the logo on the side in both languages, the earlier block without labels stays (names, addresses, TRN, phone · email); on the TRN line the Arabic label sits on the right and "TRN:" on the left.

- Decision 0076 updated; no database change.

## The owner remembered on the cashier PC too (2026-10-18)

**In plain words:** on a cashier (POS) PC, the owner now sees "Remember this PC" under the phone code too. After the code once there, the password is enough on that PC until the password changes. Everyone else still types the code on cashier PCs every time.

- Decision 0078; migration 0031 (`ops_backup` moves to 0032).

## The phone code once per PC (2026-10-18)

**In plain words:** the first time you sign in on a PC you type the phone code, with "Remember this PC" already ticked. After that, on that PC, the username and password are enough until your password changes. On another PC the code is asked once there too.

- Decision 0077 (changes 0027); migration 0030 (`ops_backup` moves to 0031).

## Logo in the middle: a letterhead (2026-10-18)

**In plain words:** in Settings → Print designer, choosing the logo in the middle for an A4 document in both languages now prints the Arabic company details on the right, the logo in the middle and the English details on the left, like the company letterhead.

- Decision 0076; no database change.

## The thermal receipt's own logo (2026-10-17)

**In plain words:** in Settings → Print designer → Thermal receipt you can now upload a logo used only on the thermal receipt (a simple black-and-white logo prints best). Without it, the receipt prints the company logo as before. A4 documents keep the company logo.

- Decision 0075; migration 0029 (`ops_backup` moves to 0030).

## Approvals with the code from the approver's phone (2026-10-17)

**In plain words:** a supervisor approves anything (a discount, a return, cancelling an invoice…) by choosing their name and typing the **6-digit code shown now in their phone's verification app**. The code changes every 30 seconds and works once, so watching someone type it is useless. Only people with 2-step turned on can approve: in Settings → Users set the supervisor's sign-in to "password + verification code". The approval PIN from earlier today is removed.

- Decision 0074 (replaces 0073); migration 0028.

## A4 invoices: details from the customer only (2026-10-17)

**In plain words:** the "customer name / address on the invoice" fields are gone. A4 invoices take the name, address and TRN from the customer record. A registered customer, or a customer with a saved address, gets a full tax invoice; the cash customer or a customer without an address gets a simplified one, so an invoice is never blocked for lack of a typed name or address.

- Decision 0071 revised; migration 0027.

## Cancel or edit an issued A4 invoice (2026-10-17)

**In plain words:** an issued A4 invoice now has **Edit invoice** and **Cancel invoice** buttons. The invoice itself never changes, as the tax law requires. A credit note cancels all of it: the goods go back to stock, the VAT is reversed and the money paid is refunded at once. "Edit" then opens a new draft copied from it, where you change the customer or the items and issue it with a new number. Only the owner does it, or approves it for someone else, always with a reason.

- **Decision 0072**; migration 0026 (`invoices.cancel`, owner only; two credit-note reasons).

## A4 invoices: always full tax invoices; reprints in today's design (2026-10-17)

**In plain words:** every A4 invoice now says **"Tax Invoice"**, also for customers who are not VAT-registered. A4 invoices need the customer's name and address: the address comes from the customer or is typed on the invoice, and the cash customer's real name is typed there too. Reprinting an old invoice uses today's colours and layout; its contents never change. On the A4 page the English company name now lines up with the Arabic one, and the total payable is black.

- **Decision 0071**; migration 0025 (format check and issue rule, `FULL_INVOICE_NAME`).
- POS receipts, advance invoices and debit notes are unchanged (0010).

## Receipt printing and the new receipt look (2026-10-17)

**In plain words:** receipts no longer come out as blank pages on printers that do not speak the thermal-printer language. In **Settings → Devices → Receipt printer** choose **Any printer (Windows driver)** for an A4 printer or such a receipt printer. The receipt has a new look after the owner's sample: an Item / Amount table with a separator between items, a large total and a "Paid" box.

- **Decision 0070.** The Windows app prints the receipt image through the printer's driver (GDI), silently, at its real width. The ESC/POS mode is unchanged and still opens the drawer.
- Numbers, phones and dates read left to right inside Arabic. Long values on 58 mm paper go under their label.

## Stuck shifts (2026-10-17)

**In plain words:** a shift left open on a PC that was enrolled again, broke or is gone no longer blocks its cashier. The owner or the accountant closes it from **Shifts & cash → Close as stuck shift**, with a reason and a count of the drawer; the difference stays the cashier's and is accepted as usual. In **Settings → Devices**, every PC shows its drawer, and the owner can **move the drawer** of a revoked PC to the PC enrolled in its place. A PC with an open shift can no longer be revoked.

- **Decision 0069**; migration 0024 (`shifts.force_close` for owner and accountant, enforced by the database).
- **Fixes:** opening a shift on a PC enrolled again under the same name no longer fails with "a record with the same data already exists"; a cashier with a shift open elsewhere is told which PC holds it.

## M4b — Print designer, bank accounts, customer PO number (2026-10-16)

**In plain words:** the owner can now change how every printed document looks, from **Settings → Print designer**, with a **live preview**: the logo (on or off, where, how big), the main colour, the language (Arabic + English, Arabic, English), the text size, the margins (or 58/80 mm paper for the receipt), the texts (welcome line, terms, footer) and which optional fields print. Fields the **UAE VAT law requires are locked** and always print; the list per document is in decision 0064 for the accountant to confirm. **Bank accounts** (several, UAE IBAN checked) live in **Settings → Company**, and the design chooses which one prints. A4 invoices and quotations have an optional **customer PO number**. Every save is a new version; documents already issued reprint exactly as they were.

- **Decisions 0064–0067:** the designer and the **locked fields per document type** (seller name, address and TRN on every tax invoice; customer name, address and TRN on a full tax invoice; number and dates; lines, discount, VAT and totals; earlier payments deducted; on a credit note the original invoice and the reason) — pending the accountant's review; bank accounts; customer PO number; no QR code until e-invoicing.
- **New rule:** a **full tax invoice needs the customer's address**. The address is taken from the customer when the invoice is issued, and the invoice is refused with a clear message when there is none (POS and A4 alike).
- **Database:** migration 0023 — `sys.company_bank_accounts` (UAE IBAN checked with its checksum by the database too, owner only, deactivated with a reason, never deleted), the customer PO number, the full-invoice address rule, receipts (سند قبض) printed with the invoice design, and the receipt language moved from the old setting into the receipt template.
- **Printing:** the A4 renderer follows every option; amount in words in Arabic and English; bank details; item codes; signature boxes. The thermal receipt follows its stored template too (language, 58/80 mm, logo in black and white, cashier name, item codes, amount in words, terms, footer). "Test print" sends a sample through the print dialog, or to the receipt printer on the POS PC.
- **Screens:** Settings → Print designer (four tabs, required fields listed with a lock), Settings → Company → Bank accounts, the PO field on the invoice and quotation editors. Screens in Arabic and English: [docs/screenshots/m4b](screenshots/m4b).
- **Not yet:** the dashboard (next), Settings → Devices and printers (after it), M6.

## M5 — Point of sale, shifts and the cash drawer (2026-10-13)

**In plain words:** the counter can now sell. On a PC enrolled as **POS**, the cashier signs in with the PIN, **opens the shift** with the float, **scans** items (or taps them), and takes **cash, card or both**; the change is worked out and the **receipt prints by itself** (Arabic and English, no print dialog) while the **drawer opens**. Selling **beyond stock**, a **bigger discount** or a **changed price** asks a supervisor's PIN. **Returns** make a credit note and pay back from the shift open now. At the end, the cashier **counts the drawer blind**, may **recount once** with a supervisor, and **closes** with the Z report; the owner or accountant **accepts the over/short**. Proven by 363 unit and screen, 440 integration and 50 browser tests.

- **Decisions 0055–0062** (owner's answers): 80 mm ESC/POS printers with the drawer on the printer; notes 1000–5, coins 1–0.05 and an "other amount"; cash-drop alert above AED 3,000; over/short accepted by the owner or accountant, alert after 3 differences above AED 20 in 30 days; cashier discount limit 5%; returns with approval refunded from the current shift; card = amount + approval code only; receipt in both languages, full invoice for a VAT-registered customer.
- **Database:** migration 0022 — cash movements (`CV-`: opening float, paid-in/out, drops, top-ups, closing transfer, each with its journal entry), drawer events (every opening, No Sale with a reason), the expected cash worked out by the database, variance acceptance (posts to 6910), the 0.10/0.05 coins and other amount, the alert settings and the cashier's 5% limit.
- **POS sale (one transaction):** the `POS-` invoice, any oversell adjustment (pending the storekeeper's review), stock and cost, split payment with change, journal entries, drawer event and audit; a retry after a network drop never sells twice; lines removed from the cart are written to the audit log.
- **Shift:** only on a POS PC; one cashier per drawer; paid-out needs approval; money never leaves the drawer beyond what it holds; the close takes expected, counted and variance from the database; the counted cash goes back to the safe so the drawers account returns to zero.
- **Thermal receipt:** drawn as an image in the app (Arabic always prints right), sent RAW to the printer chosen for this PC in **Settings → Devices** (test receipt and drawer test buttons there); reprints are marked "Copy". The A4 copy of a POS sale opens in Invoices (A4) with the same number.
- **For you:** [docs/runbooks/pos-hardware-test.md](runbooks/pos-hardware-test.md) — the step-by-step check for when the printer and drawer arrive.
- **Not yet:** the receipt's QR code (with e-invoicing), the drawer-open sensor, the print designer (M4b).

## M4 — Invoices (A4), Quotations and Receipts (2026-10-12)

**In plain words:** the office can now do all its customer paperwork. **Quotations** are written, sent, revised and turned into an invoice with the agreed prices. **Tax invoices** (`INV-`) are simplified or full by themselves, from the customer's VAT registration; VAT is worked out per line; a draft has no number until it is issued, and an issued invoice never changes. **Receipts** settle the oldest invoices first; money that settles nothing becomes an advance with its own payment tax invoice, and the **final invoice deducts** those payments and their VAT (the 100,000 + VAT example of decision 0013 gives exactly 31,500 due). **Credit and debit notes**, a **bounced cheque** reversal, **opening balances** and the **statement of account** are in. Everything prints on A4 in Arabic and English through the print dialog. Proven by 344 unit and screen, 412 integration and 48 browser tests.

- **Three sections in the side menu (decision 0045):** Invoices (A4), Quotations and Receipts, each shown to the people allowed to use it.
- **Database:** migrations 0014 (registers, shifts and counts for the POS in M5), 0015 (quotations, tax documents, payments, allocations, opening balances), 0016 (e-invoice outbox and versioned print templates), 0017 and 0018 (fixes, below). The planned later migrations move up by two (cash events are now 0019).
- **Invoices (decisions 0009–0013, 0046):** the shared line editor shows net, VAT and total as you type, with the same arithmetic as the server; a discount above your limit, a changed price, or an unpaid amount above the customer's credit each needs its own supervisor approval; payments can be taken at issue (several methods); earlier payments are ticked to be deducted.
- **Quotations (decision 0049):** valid 15 days unless changed; optional lines are shown but not counted; prices are fixed when sent; a new revision keeps the agreed prices; converting keeps them too.
- **Receipts (decisions 0047, 0048, 0052):** oldest first, chosen invoices, or advance only (with the quotation it is for); a live preview shows what is paid and the VAT inside an advance; a cheque needs its number, date and bank; "Receive payment" opens from an invoice or a customer with the customer already chosen.
- **Notes (decision 0015):** a credit note returns goods to sellable or defective stock at their old cost, or corrects a price; it can pay the money back now; a credit note on a payment invoice reverses it when work is cancelled; debit notes add to what is owed.
- **Customers:** the account card shows what the customer owes, cash or credit, unused advances, the statement of account (printable) and, for the owner, the opening balance (once, decision 0051).
- **Printing (decisions 0008, 0050):** server-made PDFs with the seller details frozen at issue; reprints are counted, marked "Copy" and need the reprint permission.
- **Fixes from the code review:**
  - a draft made from a quotation keeps the agreed prices and discount when saved again;
  - a supervisor's approval of a changed price no longer also allows a discount above the limit;
  - credit and debit notes follow the original invoice line, even if the item's price changed since;
  - a final invoice fully paid by its advances counts as paid and never blocks a later receipt;
  - statements need the statement permission and reprints the reprint permission, on the server too.
- **After the owner's first try:**
  - printing works: the page's security policy now allows the hidden print frame (only for files the app itself makes), and the server falls back to Microsoft Edge to make the PDF;
  - a new invoice starts with the **cash customer**; clicking the customer search shows the customers at once, with **"Add a new customer"**;
  - **search by any words in any order** (items, customers, suppliers); the lists open as soon as the search box is clicked; arrow keys move through them;
  - the item window shows the **current quantity**: for a new stock item it becomes its opening stock, and when editing a change becomes a stock correction ; the storekeeper now adds and edits items (decision 0053, migrations 0019–0020);
  - stock adjustments no longer need a supervisor's approval (decision 0054, migration 0021).
- **Not yet:** the Excel import of opening balances, a separate refund screen (refunds go through a credit note), and the print designer screen (M4b).

## M3 — Inventory and the posting engine (2026-10-12)

**In plain words:** stock is now real. The owner enters the **opening stock** once (by hand or from Excel), people **add, remove, move to defective and write off** stock with a reason, and **counts** compare the shelves with the system without showing the counter the expected number. Every stock change is a numbered document that also writes its **journal entry** in the same moment, so the books always equal the stock value to the fils. The accountant sees the **journal** and the **trial balance**. Barcode labels print in many sizes. Proven by 292 unit and screen, 379 integration and 46 browser tests.

- **Database:** migration 0011 (the stock ledger: movements, balances written only by the database, adjustments, counts, label sizes), 0012 (journal entries `JV-`, gapless, balanced or refused, never posted twice, only in an open month) and 0013 (fixes from the code review, below). The planned later migrations move up by one (cash is now 0014).
- **Average cost (method A, decision 0038):** 4 decimals; the last unit takes exactly what is left, so 10 × 1.2345 → remove 3 → remove 7 ends at exactly 0.00. Stock below zero is refused; 20 people taking the last 5 units at the same moment → exactly 5 succeed.
- **Who sees what (decisions 0040–0042):** cost and values only for the owner and the accountant; above 500.00 AED a supervisor approves with their PIN; opening stock is the owner's alone.
- **Counts (decision 0044):** blind while counting; the reviewer sees system quantity, movements during the count and the difference, gives a reason per difference, and posts one document and one journal entry.
- **Journal and trial balance:** filter by date, source and account; open an entry with its lines, its source document and who posted it; the inventory accounts equal the stock books (tested).
- **Items & stock (design 07):** stock tiles and columns, the "To reorder" filter, a stock card per item with its movements, the stock adjustment dialog, buttons to opening stock, counts and oversell reviews.
- **Barcode labels (decision 0043):** 8 preset sizes and A4 sheets, plus custom sizes in Settings → Lists; printed through the print dialog.
- **Also:** the default warehouse per PC in Settings → Devices (shown with more than one warehouse); dashboard alerts for items to reorder and oversells waiting for review; names instead of user numbers on journal entries and adjustments.
- **Oversells:** the review page is ready; the POS creates them in M5.
- **Fixes from the code review:**
  - a count compares with the locked current stock, so a sale at the same moment is never counted twice or missed;
  - a supervisor's approval is for one exact change and cannot be reused for a bigger one;
  - the 500.00 limit is checked on the value the database calculates, not on a number sent to it;
  - stock never moves for a document that is already posted or cancelled;
  - opening stock is posted once per item;
  - barcode labels print black on white even when the screen is in dark mode.

## M2b — Item purchase price (2026-10-11)

**In plain words:** every stock item and service can now have a **purchase price**, typed on the item screen or in the Excel template. It is without VAT, and **only the owner** sees or changes it. Next to the sale price the owner sees the **profit per unit**. A kit's cost is worked out from its components. This is the data the owner's profit reports (decision 0039) will use once sales exist.

- **Database:** migration 0010 (services may have a cost, kits never; the database refuses a change without the new owner-only permission `items.cost`). The planned later migrations move up by one (inventory is now 0011).
- **Never leaks:** the cost is not in item lists, to the cashier, the storekeeper or the accountant; Excel import of the column is refused for anyone else.
- **Decisions:** [0038](decisions/0038-item-purchase-price-owner-only.md) purchase price; [0039](decisions/0039-owner-reports-dashboard.md) the owner's reports dashboard (four figures, date range, net profit after expenses).
- **Expenses (rent, bills):** approved, but they need the ledger's journal tables (M3), so they are built after M3, not before.

## M2 — Master data and chart of accounts (2026-10-11)

**In plain words:** the owner can now enter everything the shop is built on: the company details printed on tax invoices, items with barcodes and one sale price (with a "Price includes VAT" switch), customers and suppliers, the short lists (units, categories, payment methods, warehouses, technicians, lines of business, reasons), the provisional chart of accounts with its event links, and the monthly accounting periods. Existing items and customers come in from Excel: checked first, then all rows or none. Nothing is ever deleted. Arabic and English, light and dark. Proven by 237 unit and screen, 339 integration and 42 browser tests.

- **Database:** migration 0008 (chart of accounts, event links, monthly periods kept 3 months ahead) and 0009 (master data, price levels, reason codes). Business rules live in the database and answer with a clear rule code the screens translate.
- **Prices and VAT (decisions 0032, 0033):** one sale price to 4 decimals per item, with "Price includes VAT"; the screens always show net, VAT and total, split or added through the shared rounding helper. Four fixed UAE VAT categories; only the owner changes a rate, with a reason, for new documents only. Ready for a second price level later, without building it now.
- **Items (design 07):** stock items, services and kits; barcodes with one main barcode and pack quantities; the code is suggested from the category and never changes; the type is fixed once used; search ignores Arabic letter forms ("مضخه ارضيه" finds "مضخة أرضية").
- **Customers (design 14) and suppliers:** customer type (Individual / Contractor / Company); VAT-registered customers need a TRN (15 digits starting with 100) and get a full tax invoice; phone and TRN are unique; new customers start as cash and only the owner or accountant gives credit, with a reason (decision 0036); the walk-in customer is locked; export to Excel is written to the audit log.
- **Settings:** Company (owner only; logo PNG/JPEG up to 512 KB, checked by content), VAT & numbering (series fixed after their first number, close / reopen with a reason / lock a month for good, e-invoicing waiting for the accountant), and the new Lists section.
- **Accounting:** the provisional chart as a tree (an account in use keeps its type and cannot be deactivated) and the event links, which accept only a suitable account. Go-live waits for the accountant's approval (decision 0035).
- **Excel import (decision 0031):** templates with Arabic and English headers; check first with a row-by-row report; then one transaction for all rows or none; a file changed after the check must be checked again.
- **Every save is protected against "changed by someone else"**: the screen offers to reload instead of overwriting.
- **Fixes found on the way:** Arabic counts now use every Arabic plural form (2 → صفّين, 3–10 → صفوف, 11–99 → صفًا), and the translation check requires them; a React key clash on the Users screen (user 3 next to role 3) is gone.

## M1 — Security core and app shell (2026-10-07)

**In plain words:** only enrolled PCs can talk to the server, over an encrypted connection; people sign in safely (password, cashier PIN on POS PCs, owner's phone code); and the owner manages users, PCs and the audit log in Settings — in Arabic and English, light and dark, matching the approved design. Proven by 164 unit, 260 integration, 26 Rust and 32 browser tests.

- **Database:** migration 0006 adds trusted PCs; migration 0007 makes company details owner-only (decision 0030: the accountant keeps the audit log). The chart of accounts moves to 0008, master data to 0009.
- **Enrolling a PC:** a 10-minute, one-time code that also proves the server is genuine; the PC then trusts only the ARTÉPOOL certificate (TLS 1.3) and keeps its own key in Windows Credential Manager; the key renews itself every year.
- **Signing in:**
  - passwords of 10+ characters, common ones refused, 5 wrong tries lock the account for 15 minutes;
  - cashiers pick their name and type a 4-digit PIN, on POS PCs only; weak PINs refused; blocked after 5 wrong tries until the owner unblocks it;
  - the owner adds a 6-digit code from the phone; 10 one-time recovery codes; an emergency reset on the server PC only;
  - a temporary password or PIN must be replaced at first sign-in;
  - idle screens lock (POS 5 minutes, office 15);
  - **"Trust this PC"** (decision 0027): after the phone code, the owner can skip it on their own PC for 30 days (never on POS PCs); it ends by itself on a new password or 2-step change, and the owner can end it in Settings → Devices;
  - **"Forgot your password?"** (decision 0028): the phone code and one recovery code let the owner choose a new password in the app, even while locked; every other session and trusted PC ends;
  - **last resort on the server PC** (decision 0029): `pnpm owner:reset-password` (reason, temporary password shown once, optional 2-step reset, audited); the owner then sees when and why on the "choose your own password" screen.
- **Every request is checked by the server:** the PC, the session, and a permission declared for every route (the server refuses to start otherwise). Saves are never done twice when retried.
- **Settings (design 13):** users (temporary code shown once, unlock, deactivate with a reason, reactivate — never deleted), roles and permissions (discount limits stored as whole numbers), PCs (new code, rename, revoke with a reason, who is trusted until when, end trust), and the audit log (chain check, filters, before/after, export).
- **The Windows app (Tauri):** one copy per PC; updates only with a valid signature (the key is created in M6); strict security policy.
- **CI:** Linux checks and tests, browser tests in both languages, Rust tests (also against the real server), and a Windows build that produces the installer.

## M0 — Foundations (2026-10-07)

**In plain words:** the invisible backbone is built and proven by 176 automatic tests. There are no screens yet; those come in M1.

- **Database safety rules:**
  - nothing can be deleted
  - nothing can be written without a known user
  - final records cannot change
  - every write is recorded in the audit diary
- **Tamper-evident audit diary:** each entry is sealed with a fingerprint chained to the previous one. A secret change made with full database access is caught at the exact entry (`pnpm demo:audit-tamper`).
- **Gapless numbering:** 13 series (`POS-`, `INV-`, `CN-`, `Q-`, `RCT-`, …). 50 simultaneous requests, some of them cancelled, still give 1, 2, 3… with no gaps or repeats.
- **Money calculator:**
  - integers only: fils, plus 4-decimal unit prices
  - VAT calculated per line
  - discounts spread exactly across lines
  - the same rounding rule in the app and in the database, proven by shared test cases
- **Safe database upgrade tool:** it refuses to run an upgrade file that was edited after use.
- **Users, roles and permissions:**
  - 5 default roles
  - 64 permissions, 11 of which a supervisor can approve once
  - the agreed role matrix
- **Settings:** 22 settings with the agreed defaults (oversell with approval, silent POS receipts, "Copy" on reprints, e-invoicing date pending).
- **Server core:** one transaction per business operation with automatic retry after a deadlock, strict time limits, no secrets in logs, and a `/health` check.
- **Tooling:** CI on GitHub runs everything on PostgreSQL 18. A step-by-step Windows setup guide is included.
