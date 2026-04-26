---
'freelo-cli': minor
---

Drop the `keytar` dependency. `tokens.json` (mode `0600`, in the platform-appropriate
config directory) is now the sole persistent token store. Env-var auth
(`FREELO_API_KEY` + `FREELO_EMAIL`) remains the recommended path and is unchanged.

This eliminates the `prebuild-install@7.1.3` deprecation warning on `npm install`
and removes the only native binding from the dep tree, making Windows/Linux installs
binary-free.

**Behavior change for existing keychain users.** If you previously stored a token in
the OS keychain (Mac Keychain Access, Windows Credential Manager, libsecret), you'll
need to re-run `freelo auth login` on first use after upgrade — the token will land
in `tokens.json`. The old keychain entry persists harmlessly until you remove it
manually.

The `FREELO_NO_KEYCHAIN` environment variable is no longer recognized (it was a
keychain-skip toggle and there is no longer a keychain). Setting it has no effect.
