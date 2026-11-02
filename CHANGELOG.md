# Changelog

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
