# The public pages Google asks for (decision 0095)

Google requires a home page, a privacy policy and terms of service on a domain the publisher owns
before the app's registration can be published "In production"
([google-registration.md](../runbooks/google-registration.md), step 3b).

| File | What it is |
|---|---|
| `index.html` | Home page: what ARTEPOOL ERP is, and what the Google connection is for |
| `privacy.html` | Privacy policy: `drive.file` only, encrypted copies, nothing shared, the Limited Use statement, how to withdraw consent |
| `terms.html` | Short terms of use |
| `site.css` | Plain styles, light and dark |

Before publishing, replace every `{{CONTACT_EMAIL}}` with the public contact address. The pages hold
no secret and no customer data.

## Hosting

- **On an existing website:** upload the four files into a folder (for example `artepool-erp/`).
- **On GitHub Pages (free):** create a **public** repository in the `ARTEPOOL` organisation named
  `artepool.github.io`, add the four files at its root, then **Settings → Pages → Build and
  deployment → Deploy from a branch → `main` / `(root)` → Save**. The pages are then at
  `https://artepool.github.io/`. If Google does not accept that address as an authorized domain, buy
  a domain and set it under **Settings → Pages → Custom domain** (GitHub gives it HTTPS for free).
- Either way, verify the domain in Google Search Console with the software's Google account.

Keep this folder and the published pages the same; change the date at the top of the policy when it
changes.
