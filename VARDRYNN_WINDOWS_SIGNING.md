# Signing the Windows app

Windows builds are signed with **Azure Artifact Signing** (formerly Trusted Signing). electron-builder signs `vardrynn.exe`, the setup exe and its uninstaller during the CI build, with a Microsoft timestamp. A signed build passes SmartScreen without the "unknown publisher" block, and it is the only kind of Windows installer CI puts into a release, so it is also what the in-app updater installs.

Without the settings below the build still works but is unsigned, and CI leaves the installer out of the release.

## One-time Azure setup (about an hour of work, then 1-7 days for identity checks)

1. **Azure subscription.** Sign in at portal.azure.com with a pay-as-you-go subscription. For an individual certificate, the billing account must be of type *Individual*, and its legal name and address must exactly match your government ID: that name becomes the certificate's publisher name. Individual validation is limited to some countries (the US and Canada at least); check the current quickstart.
2. **Register the provider.** Subscription → Resource providers → `Microsoft.CodeSigning` → Register.
3. **Create the signing account.** Search for *Artifact Signing accounts* → Create. Pick a region (note it, the endpoint depends on it, for example East US is `https://eus.codesigning.azure.net/`) and the **Basic** tier (about USD 10 a month).
4. **Give yourself the verifier role.** On the account → Access control (IAM) → Add role assignment → *Artifact Signing Identity Verifier* → your own user.
5. **Identity validation.** Account → Identity validations → New → **Public** → Individual (or Organization if you have a registered business). Complete the ID check Microsoft emails you. Wait for *Completed*.
6. **Certificate profile.** Account → Certificate profiles → Create → **Public Trust**, choose the completed validation. Note the profile name.
7. **An app for CI.** Microsoft Entra ID → App registrations → New (for example `vardrynn-ci-signing`). Note its *Application (client) ID* and *Directory (tenant) ID*. Under Certificates & secrets, create a client secret and copy its value (shown once). Set a reminder before it expires.
8. **Let the app sign.** On the signing account → Access control (IAM) → Add role assignment → *Artifact Signing Certificate Profile Signer* → the app from step 7.

## GitHub settings (MichaelOlave/x-minecraft-launcher → Settings → Secrets and variables → Actions)

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `AZURE_TENANT_ID` | Directory (tenant) ID |
| Secret | `AZURE_CLIENT_ID` | Application (client) ID |
| Secret | `AZURE_CLIENT_SECRET` | the client secret value |
| Variable | `VARDRYNN_AZURE_SIGNING_ENDPOINT` | region endpoint, e.g. `https://eus.codesigning.azure.net/` |
| Variable | `VARDRYNN_AZURE_SIGNING_ACCOUNT` | signing account name |
| Variable | `VARDRYNN_AZURE_SIGNING_PROFILE` | certificate profile name |
| Variable | `VARDRYNN_PUBLISHER_NAME` | the certificate's common name, exactly (your legal name for an individual) |

Or with the CLI: `gh secret set AZURE_CLIENT_SECRET --repo MichaelOlave/x-minecraft-launcher` and `gh variable set VARDRYNN_PUBLISHER_NAME --repo MichaelOlave/x-minecraft-launcher --body "..."`.

## Producing and checking a signed build

1. Actions → **Build** → Run workflow with `publish: dev`. The Windows job installs Microsoft's `TrustedSigning` PowerShell module and signs while packaging.
2. The **Verify Windows signatures** step prints each file's status and signer. It fails the run if a file is unsigned, signed by another name, or not timestamped.
3. The release job adds `vardrynn-<version>-setup-x64.exe` to the signed `release.json` as `win32-x64` and uploads it to the dev bucket.
4. On a Windows PC: download the setup exe in a browser, run it, and check that the prompt names your publisher and has no "unknown publisher" warning. In File Explorer, Properties → Digital Signatures should show the signature on the setup exe, `vardrynn.exe` and `Uninstall Vardrynn.exe` in `%LOCALAPPDATA%\Programs\Vardrynn`.
5. Updating: install an older dev build, publish a newer one, then use the launcher's update button. It should quit, update silently and reopen on the new version.

A new certificate has little SmartScreen reputation at first. Artifact Signing certificates usually avoid the full block, but a few early users may still see a warning until downloads build up reputation.

## Local signing

Set the same seven values in `xmcl-electron-app/.env` on a Windows machine and run `pnpm build:all`. Signing does not work from macOS or Linux.
