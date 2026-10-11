# Set up ARTÉPOOL ERP on your Windows PC (development)

This guide gets the project running on your own Windows PC, so you can test it yourself and continue development there.

| | |
|---|---|
| **Time needed** | About 90 minutes, most of it downloads, installers and the first build of the Windows app |
| **You need** | Windows 10 or 11 (64-bit), administrator rights, about 25 GB of free disk space, internet for the downloads, your GitHub login, and your phone with an authenticator app (Microsoft Authenticator or Google Authenticator) |
| **At the end** | All checks and tests pass on your PC, you have watched the system catch a tampered record, and the ARTÉPOOL app runs on your PC: enrolled, with you signed in as the owner |

Type commands exactly as shown. Wherever this guide says **PowerShell**:
1. Press the Windows key.
2. Type `PowerShell`.
3. Open **Windows PowerShell**. Use "Run as administrator" only where the step says so.

---

## Step 1: Install Git (the tool that downloads the project)

1. Go to https://git-scm.com/download/win and download **64-bit Git for Windows Setup**.
2. Run it and click **Next** on every screen. The default options are correct.
3. Open **PowerShell** and type:
   ```
   git --version
   ```
   You should see something like `git version 2.x`.

## Step 2: Install Node.js 24 (the engine the system runs on)

1. Go to https://nodejs.org and download the **LTS** version for Windows (**.msi**). It must be version **24**.
2. Run it and click **Next**.
   - On the "Tools for Native Modules" screen, **leave the box unticked**. Those tools are not needed.
3. **Close and reopen PowerShell**, then type:
   ```
   node --version
   ```
   You should see `v24.` followed by more numbers.

## Step 3: Turn on pnpm (the tool that installs the project's libraries)

1. Open **PowerShell as administrator**: right-click it, then choose **Run as administrator**. Type:
   ```
   corepack enable pnpm
   ```
2. Close it. Open a **normal** PowerShell and type:
   ```
   pnpm --version
   ```
   - If it asks "Do you want to continue? [Y/n]", type `Y`.
   - You should see `10.` followed by more numbers.

## Step 4: Install PostgreSQL 18 (the database)

1. Go to https://www.postgresql.org/download/windows/, click **Download the installer**, and download **PostgreSQL 18.x** for **Windows x86-64**.
2. Run the installer:
   - **Components:** keep *PostgreSQL Server* and *Command Line Tools*. *pgAdmin 4* is optional. Untick *Stack Builder*.
   - **Data directory:** keep the default.
   - **Password:** choose a strong password for the database administrator account (named `postgres`). **Write it down**: you will need it in Step 7.
   - **Port:** keep `5432`.
   - **Locale:** keep the default.
3. Finish the installer. If it offers to launch Stack Builder at the end, untick that box.
4. PostgreSQL now runs automatically in the background (Windows service `postgresql-x64-18`).

> Security note: on a development PC the default settings are fine. The installer only accepts database connections from this PC itself. The production server setup in milestone M6 locks the database down further.

## Step 5: Install Visual Studio Code (recommended)

1. Go to https://code.visualstudio.com, download it for Windows, and install with the default options.
2. When you open the project folder later, VS Code will suggest three extensions (ESLint, Prettier, Vitest). Click **Install**.

## Step 6: Download the project from GitHub

In **PowerShell**:
```
cd $HOME
mkdir Projects
cd Projects
git clone https://github.com/adretaae-ctrl/artepool-erp.git
cd artepool-erp
```

- **Login:** a browser window may open asking you to sign in to GitHub. Sign in with the account that owns the `artepool-erp` repository.
- **Before the M1 pull request is merged:** if you haven't merged it on GitHub yet, also run this command to see the M1 work:
  ```
  git checkout m1-security-shell
  ```

## Step 7: Create your private settings file (.env)

Still in the `artepool-erp` folder:
```
copy .env.example .env
notepad .env
```
In Notepad, change these lines and save:

| Line | What to type |
|---|---|
| `PG_SUPERUSER_PASSWORD=` | The PostgreSQL password you wrote down in Step 4 |
| `ARTEPOOL_MIGRATOR_PASSWORD=` | Invent a password: at least 16 letters and digits |
| `ARTEPOOL_API_PASSWORD=` | Invent a **different** password |
| `ARTEPOOL_BACKUP_PASSWORD=` | Invent a **different** password |
| `ARTEPOOL_MAINT_PASSWORD=` | Invent a **different** password |

> The `.env` file stays on your PC only. Git ignores it automatically, so it is never uploaded to GitHub. Don't email or share it.

## Step 8: Install the project's libraries

```
pnpm install
```
The first time this takes 2–5 minutes. It ends with `Done in …`.

## Step 9: Create the database and bring it up to date

```
pnpm db:setup
pnpm db:migrate
```

You should see:
```
Database roles are ready (artepool_owner, _migrator, _api, _backup, _maint).
Database "artepool_dev" created. Next: pnpm db:migrate
...
Applied 0001_extensions_schemas_helpers.sql (… ms)
Applied 0002_audit.sql (… ms)
Applied 0003_auth_core.sql (… ms)
Applied 0004_sys_core.sql (… ms)
Applied 0005_auth_devices.sql (… ms)
Applied 0006_device_trust.sql (… ms)
Applied 0007_company_edit_owner_only.sql (… ms)
Database upgraded: 7 migration(s) applied.
```

## Step 10: Run every check and test

```
pnpm check
pnpm test
```

- `pnpm check` ends with `i18n OK: ar, en have the same texts and placeholders.`
- `pnpm test` runs two groups. Both must say **passed**, with no failures (the numbers grow as the project grows; at the end of M1 they are):
  ```
   Test Files  23 passed (23)
        Tests  164 passed (164)
  ...
   Test Files  22 passed (22)
        Tests  260 passed (260)
  ```

## Step 11: See the safety features with your own eyes

```
pnpm audit:verify
```
This checks the audit diary of your database and should say:
`OK — the audit chain is intact: … entries checked, none changed, none missing.`

```
pnpm demo:audit-tamper
```
This creates a throwaway practice database and does some normal work in it. Then it **secretly edits one record behind the system's back**, the way someone with full database access might. The check catches the edit:
`BROKEN — the audit chain shows tampering. Problem: Entry #… was changed after it was written.`

The practice database is deleted at the end. Your own database is never touched.

## Step 12: Start the server (HTTPS)

The server only speaks HTTPS (TLS 1.3), with ARTÉPOOL's own certificate. Create the master key and the certificates once:
```
pnpm dev:secrets
pnpm tls:init
```
- `dev:secrets` creates the key that protects your 2-step secret (`.secrets\master.key`).
- `tls:init` creates the private ARTÉPOOL certificate authority and the server's certificate (`.secrets\tls\`). It covers this PC's name, `localhost` and `127.0.0.1`.
- The `.secrets` folder stays on your PC; Git never uploads it.

Then start the server and leave this PowerShell window open:
```
pnpm dev:server
```
In a **second** PowerShell window, in the `artepool-erp` folder, check it answers:
```
curl.exe --cacert .secrets\tls\ca.crt https://localhost:3100/health
```
You should see a line that starts with `{"status":"ok"` and includes `"schemaVersion":7`.

> A web browser would warn that the connection is "not private": your browser does not know the ARTÉPOOL certificate, and that is correct. The ARTÉPOOL app learns it safely when you enroll the PC (Step 16).

## Step 13: Create the owner account

In the second PowerShell window:
```
pnpm owner:create
```
It asks for your name in Arabic and English, a username, and a password (at least 10 characters; a short sentence is easy to remember). You set up the 2-step code on your phone at your first sign-in.

## Step 14: Install Rust and the Microsoft C++ Build Tools (for the Windows app)

1. **C++ Build Tools:** go to https://visualstudio.microsoft.com/visual-cpp-build-tools/ and download **Build Tools for Visual Studio**. Run it, tick **Desktop development with C++**, and click **Install** (about 6 GB).
2. **Rust:** go to https://rustup.rs and download **rustup-init.exe** (64-bit). Run it and press **Enter** to accept the default installation.
3. **Close and reopen PowerShell**, then type:
   ```
   cargo --version
   ```
   You should see `cargo 1.` followed by more numbers.
4. **WebView2** (the browser engine inside the app) is already part of Windows 11. On Windows 10, if the app later shows a blank window, install the **Evergreen Standalone Installer** from https://developer.microsoft.com/microsoft-edge/webview2/.

## Step 15: Start the ARTÉPOOL app

Keep the server from Step 12 running. In the second PowerShell window:
```
pnpm dev:desktop
```
The first time, Rust builds the app: about 5–10 minutes. Later starts take seconds. The ARTÉPOOL window opens on **Enroll this PC**.

## Step 16: Enroll this PC and sign in

1. Open a **third** PowerShell window in the `artepool-erp` folder and type:
   ```
   pnpm device:code
   ```
   It shows a code like `K7Q-4MX-92P`. It works **once**, for **10 minutes**.
2. In the app:
   - **Server address:** `localhost`
   - **Enrollment code:** the code from step 1
   - **PC name:** for example `My office PC`; **Type of PC:** **Office**
   - Click **Enroll this PC**. The sign-in screen appears, with "Connected to main server".
3. Sign in with the owner username and password from Step 13.
4. **Set up the 2-step code:** open your authenticator app on your phone, add an account, and scan the QR code on the screen. Type the 6-digit code the phone shows.
   - Next time, under the 6-digit code, you can tick **Trust this PC for 30 days**. On this PC you will then sign in with the password alone; every other PC still asks for the phone code. Do not tick it on a PC other people use.
5. **Recovery codes:** print them (or write them down) and keep them in a safe place. Tick the box and click **Continue**.
6. You are in. Open **Settings** to see Users & permissions, Devices and the Audit log.

> The device key is kept in **Windows Credential Manager** under "ARTEPOOL ERP". The app never shows it, and the server stores only a fingerprint of it.

## Step 17 (optional): Run the screen tests and the Rust tests

```
pnpm --filter @artepool/desktop exec playwright install chromium
pnpm test:e2e
pnpm test:rust
```
- `test:e2e` opens the real screens in a hidden browser against a throwaway database, in Arabic and English, light and dark. It ends with `42 passed`. Screenshots are saved in `apps\desktop\e2e-screens\`.
- `test:rust` checks the app's secure side (enrollment, TLS rules, the device key). Every group says `test result: ok`.

---

## Everyday commands

| What | Command |
|---|---|
| Get the latest version from GitHub | `git pull`, then `pnpm install`, then `pnpm db:migrate` |
| Run all checks / all tests | `pnpm check` / `pnpm test` |
| Check the audit diary | `pnpm audit:verify` |
| Start the server | `pnpm dev:server` |
| Start the ARTÉPOOL app | `pnpm dev:desktop` |
| A one-time code to enroll another PC (or use Settings → Devices) | `pnpm device:code` |
| Emergency: owner password lost together with the phone or the recovery codes (server PC only) | `pnpm owner:reset-password` |
| Screen tests / Rust tests | `pnpm test:e2e` / `pnpm test:rust` |

## If something goes wrong

| Message | What to do |
|---|---|
| `pnpm is not recognized` | Close and reopen PowerShell. If it persists, repeat Step 3. |
| `Unsupported engine` or `ERR_PNPM_UNSUPPORTED_ENGINE` | Node.js is not version 24. Repeat Step 2, then reopen PowerShell. |
| `password authentication failed for user "postgres"` | `PG_SUPERUSER_PASSWORD` in `.env` is not the password from Step 4. |
| `PostgreSQL 18 or newer is required` | An older PostgreSQL is using port 5432. Uninstall it in Windows "Apps", or put the PostgreSQL 18 port in `PGPORT` in `.env`. |
| `connect ECONNREFUSED 127.0.0.1:5432` | The database is not running. Press Windows + R, type `services.msc`, find **postgresql-x64-18** and click **Start**. |
| `Filename too long` during `git clone` | Run `git config --global core.longpaths true`, delete the half-downloaded folder, and repeat Step 6. |
| `Missing setting …` | A line in `.env` is empty. Compare it with `.env.example`. |
| `The secure connection is not set up … Run: pnpm tls:init` | Run `pnpm tls:init` (Step 12). |
| `The master key file … could not be read` | Run `pnpm dev:secrets` (Step 12). |
| `linker 'link.exe' not found` while building the app | The C++ Build Tools are missing. Repeat Step 14.1, then reopen PowerShell. |
| The app shows "Can't reach the main server" | The server from Step 12 is not running. Start it and click **Try again**. |
| "The code is wrong or expired, or the server … is not the ARTÉPOOL server" | Check the code; each code works once for 10 minutes. Create a new one with `pnpm device:code`. |
| You forgot your password (owner, or anyone with the 2-step code) | On the sign-in screen click **Forgot your password?** → **Choose a new password**. You need the 6-digit code from the phone and one of your printed recovery codes. |
| The owner lost the password **and** the phone or the recovery codes | On the server PC, in the `artepool-erp` folder: `pnpm owner:reset-password`. Type the reason, answer whether the phone is lost too, then type `RESET`. Sign in with the temporary password it shows (once) and choose your own. |
| You forgot your username | It is the name you typed after `Username` in `pnpm owner:create`: lower-case English letters and digits. |
| You want to enroll this PC again from scratch (development only) | Open **Credential Manager** → **Windows Credentials**, remove **ARTEPOOL ERP**, and restart the app. |
| A test fails | Run `pnpm test` again once. If it still fails, copy the full message and send it to Claude. |

## Working with Claude on your PC

Open the `artepool-erp` folder in Claude Code (the Code tab of the Claude desktop app, or `claude` in PowerShell). Claude reads `CLAUDE.md` automatically and continues from the plan in `docs/phase-1-plan.md`.
