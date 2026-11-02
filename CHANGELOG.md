# Changelog

## 0.1.2

- Fix: signing in to the web UI through remote access (self-expose) was refused as a cross-site request, and so was every change made after signing in remotely
- The sign-in page no longer shows the first-password hint for unrelated errors
- New `TUINNEL_CLOUDFLARED` setting to use an already installed `cloudflared` instead of a downloaded copy; `doctor` now reports the `cloudflared` that is actually used

## 0.1.1

- Releases are built and published by GitHub Actions with npm provenance, and go live after approval on npm
- Tests run on Linux and macOS for every change, and are more reliable on slower machines
- No changes to how tuinnel-plus behaves

## 0.1.0

First release of tuinnel-plus, based on [tuinnel](https://github.com/NickDunas/tuinnel) by Nick Dunas.

- Background service (`tuinnel-plus serve`) that owns all tunnels; the terminal dashboard and CLI talk to it, so tunnels keep running after you close them
- Web UI with live status, logs and metrics, password-protected, with light/dark theme
- Optional remote access to the web UI through its own Cloudflare tunnel (`tuinnel-plus expose`)
- macOS login item (`tuinnel-plus service install`)
- Terminal dashboard: log filter and scrolling, tunnel search, command palette (Ctrl+K)
- `TUINNEL_HOME` to keep a completely separate state directory
- `remove` deletes the tunnel's DNS record and Cloudflare tunnel, not just the local entry
