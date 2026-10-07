# Set up ARTÉPOOL ERP on your Windows PC (development)

This guide gets the project running on your own Windows PC, so you can test it yourself and continue development there from milestone M1.

| | |
|---|---|
| **Time needed** | About 45 minutes, most of it downloads and installers |
| **You need** | Windows 10 or 11 (64-bit), administrator rights, about 15 GB of free disk space, internet for the downloads, and your GitHub login |
| **At the end** | All checks and tests pass on your PC, and you have watched the system catch a tampered record |

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
- **Before the M0 pull request is merged:** if you haven't merged it on GitHub yet, also run this command to see the M0 work:
  ```
  git checkout m0-foundations
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
Database upgraded: 5 migration(s) applied.
```

## Step 10: Run every check and test

```
pnpm check
pnpm test
```

- `pnpm check` ends with `i18n OK: ar, en have the same texts and placeholders.`
- `pnpm test` runs two groups. Both must say **passed**, with no failures:
  ```
   Test Files  9 passed (9)
        Tests  76 passed (76)
  ...
   Test Files  9 passed (9)
        Tests  100 passed (100)
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

## Step 12: Start the server

```
pnpm dev:server
```
1. Open your browser at http://127.0.0.1:3100/health. You should see a line that starts with `{"status":"ok"` and includes `"schemaVersion":5` (the number of the latest database update).
2. Stop the server with **Ctrl + C** in PowerShell.

---

## Everyday commands

| What | Command |
|---|---|
| Get the latest version from GitHub | `git pull`, then `pnpm install`, then `pnpm db:migrate` |
| Run all checks / all tests | `pnpm check` / `pnpm test` |
| Check the audit diary | `pnpm audit:verify` |
| Start the server | `pnpm dev:server` |

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
| A test fails | Run `pnpm test` again once. If it still fails, copy the full message and send it to Claude. |

## Working with Claude on your PC

Open the `artepool-erp` folder in Claude Code (the Code tab of the Claude desktop app, or `claude` in PowerShell). Claude reads `CLAUDE.md` automatically and continues from the plan in `docs/phase-1-plan.md`.

## Coming in M1 (no need to install yet)

The desktop app needs two more free tools: the **Rust** toolchain and the **Microsoft C++ Build Tools**. Step-by-step instructions will come at the start of M1.
