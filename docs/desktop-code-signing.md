# Desktop code signing & notarization (macOS + Windows)

This guide takes the **MoxxyAI Workspaces** desktop app from *unsigned (ad-hoc)*
to **Developer ID signed + notarized** on macOS, so users never see the
"damaged" / "unidentified developer" Gatekeeper prompts. It also covers
optional Windows Authenticode signing.

You only need a **paid Apple Developer Program** membership
(<https://developer.apple.com/programs/> — \$99/yr). Everything below is done
once; after that, every `desktop-v*` release is signed automatically by CI.

The release workflow (`.github/workflows/release-desktop.yml`) is already wired
to **activate signing automatically when the secrets exist** and fall back to
the current ad-hoc/unsigned build when they don't. So the entire task is:
**create the credentials → paste them into GitHub Secrets → tag a release.**

---

## macOS

### Step 1 — Create a "Developer ID Application" certificate

This is the cert that signs apps distributed *outside* the Mac App Store.

**Easiest path (Xcode):**

1. Install Xcode (App Store) and sign in: **Xcode ▸ Settings ▸ Accounts**, add
   your Apple ID, select your Team.
2. Click **Manage Certificates… ▸ + ▸ Developer ID Application**. Xcode creates
   the cert and its private key in your login Keychain.

**Manual path (no Xcode):**

1. Keychain Access ▸ **Certificate Assistant ▸ Request a Certificate From a
   Certificate Authority…** → save a `CertificateSigningRequest.certSigningRequest`
   to disk ("Saved to disk", leave CA email blank).
2. <https://developer.apple.com/account/resources/certificates/list> ▸ **+** ▸
   **Developer ID Application** ▸ upload the CSR ▸ download the `.cer`.
3. Double-click the `.cer` to import it into Keychain Access.

> If you've never created a Developer ID cert for this team before, Apple may
> require you to be the **Account Holder** (or be granted access). See
> <https://developer.apple.com/help/account/create-certificates/create-developer-id-certificates/>.

### Step 2 — Export the cert as a `.p12` and base64-encode it

1. **Keychain Access ▸ login ▸ My Certificates**. Find
   **Developer ID Application: <Your Name> (<TEAMID>)**. Expand it — it must
   show a private key underneath (if not, the export won't work).
2. Right-click the certificate ▸ **Export…** ▸ format **Personal Information
   Exchange (.p12)** ▸ set a strong password (you'll need it as a secret) ▸ save
   as `moxxy-desktop.p12`.
3. Base64-encode it (single line, copied to your clipboard):

   ```sh
   base64 -i moxxy-desktop.p12 | pbcopy
   ```

### Step 3 — Create notarization credentials

Notarization is Apple scanning the signed app and issuing a "ticket". Pick **one**
method. **App Store Connect API key is recommended** (doesn't expire, no 2FA).

**Method A — App Store Connect API key (recommended)**

1. <https://appstoreconnect.apple.com/access/integrations/api> ▸ **Team Keys** ▸
   generate a key with the **Developer** role.
2. Download the `AuthKey_XXXXXXXXXX.p8` (one-time download). Note the **Key ID**
   (the `XXXXXXXXXX`) and the **Issuer ID** (UUID at the top of the page).
3. Base64-encode the key:

   ```sh
   base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy
   ```

**Method B — Apple ID + app-specific password**

1. <https://account.apple.com> ▸ **Sign-In and Security ▸ App-Specific
   Passwords** ▸ **+** ▸ name it `moxxy-notarize` ▸ copy the generated password
   (form `abcd-efgh-ijkl-mnop`).
2. Find your **Team ID**: <https://developer.apple.com/account> ▸ **Membership
   details ▸ Team ID** (10 chars, e.g. `AB12CD34EF`).

### Step 4 — Add the GitHub repo secrets

Repo ▸ **Settings ▸ Secrets and variables ▸ Actions ▸ New repository secret**.

Always add:

| Secret | Value |
|---|---|
| `CSC_LINK` | the base64 of `moxxy-desktop.p12` (Step 2) |
| `CSC_KEY_PASSWORD` | the `.p12` export password (Step 2) |

Then add **either** Method A **or** Method B from Step 3:

| Method A (API key) | Method B (Apple ID) |
|---|---|
| `APPLE_API_KEY` = base64 of the `.p8` | `APPLE_ID` = your Apple ID email |
| `APPLE_API_KEY_ID` = the Key ID | `APPLE_APP_SPECIFIC_PASSWORD` = the app-specific password |
| `APPLE_API_ISSUER` = the Issuer ID | `APPLE_TEAM_ID` = your 10-char Team ID |

> The workflow only turns on signing when `CSC_LINK` is present, and only
> notarizes when one of the credential sets above is present. With none set, it
> builds exactly as it does today (ad-hoc, unsigned).

### Step 5 — Release

Push a tag and the **Release Desktop** workflow signs + notarizes + staples the
DMG automatically:

```sh
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

(Or run it from the Actions tab via **workflow_dispatch** — note that produces
artifacts but no GitHub Release; only `desktop-v*` tags publish a release.)

### Step 6 — Verify a build is properly signed

Download the DMG, then on a Mac:

```sh
# 1. The .app is signed with a Developer ID (not "adhoc")
codesign -dv --verbose=4 "/Applications/MoxxyAI Workspaces.app" 2>&1 | grep -E 'Authority|TeamIdentifier|flags'
#   → Authority=Developer ID Application: <you> (<TEAMID>), flags=…runtime…

# 2. Gatekeeper accepts it (this is the real test)
spctl -a -vvv -t install "/Applications/MoxxyAI Workspaces.app"
#   → accepted, source=Notarized Developer ID

# 3. The notarization ticket is stapled (works offline)
xcrun stapler validate "/Applications/MoxxyAI Workspaces.app"
#   → The validate action worked!
```

A correctly notarized build opens with a **double-click, no warning** — no
right-click→Open, no `xattr`.

---

## What the repo already does for you

When the secrets above exist, CI does all of this — you don't edit anything:

- **`apps/desktop/package.json` ▸ `build.mac`** declares `hardenedRuntime: true`
  and points at **`build/entitlements.mac.plist`** (Electron needs the JIT /
  unsigned-executable-memory entitlements under the hardened runtime). These are
  no-ops when the build isn't signed.
- **`release-desktop.yml`** has a **Configure signing** step that, when
  `CSC_LINK` is set, flips `CSC_IDENTITY_AUTO_DISCOVERY` on and enables
  `--config.mac.notarize` for the package step (electron-builder reads the
  `APPLE_*` env vars). When `CSC_LINK` is absent it leaves the ad-hoc path
  untouched.
- The **ad-hoc signing** in `build/after-pack.cjs` is skipped automatically when
  a real Developer ID cert is present (so we never double-sign).

So the only thing that changes between an unsigned and a signed release is the
**presence of the secrets**.

---

## Windows (optional)

Windows SmartScreen warnings are cleared by an Authenticode (preferably **EV** /
OV) code-signing certificate from a CA (DigiCert, Sectigo, SSL.com, …). EV certs
ship on a hardware token / use a cloud HSM, which doesn't fit headless CI without
the CA's signing service. The common setups:

- **Azure Trusted Signing** (<https://learn.microsoft.com/azure/trusted-signing/>)
  — Microsoft's managed signing; integrates with CI via `azure/trusted-signing-action`.
- **SSL.com eSigner** / **DigiCert KeyLocker** — cloud HSM + a CLI you call from CI.

To wire it, set `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (for a file-based OV cert)
or the provider's action, and electron-builder signs the `.exe`. Until then,
Windows builds remain unsigned (users click **More info → Run anyway**).

---

## Troubleshooting

- **`The specified item could not be found in the keychain` / no identity** —
  `CSC_LINK`/`CSC_KEY_PASSWORD` wrong, or the `.p12` was exported **without** its
  private key (re-export from *My Certificates*, expanding to confirm the key).
- **`You must first sign the relevant contracts…`** — accept the latest Apple
  Developer agreements at <https://developer.apple.com/account> before issuing
  the cert / notarizing.
- **Notarization `Invalid` / `Team is not yet configured`** — the API key needs
  the **Developer** role; the Apple ID must be on the team; double-check
  `APPLE_API_ISSUER` (Issuer ID, not Key ID).
- **`Hardened Runtime` crash / "killed: 9" at launch** — a missing entitlement;
  ensure `build/entitlements.mac.plist` includes
  `com.apple.security.cs.allow-jit` and
  `com.apple.security.cs.allow-unsigned-executable-memory` (it does).
- **Still "damaged" after signing** — the build wasn't notarized (check the
  notarize step ran) or the ticket wasn't stapled; re-run `stapler validate`.
