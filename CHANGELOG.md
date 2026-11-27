# Changelog

## 0.1.5

- When the background service is running, `add`, `up` and `password set` go through it instead of writing the config file themselves, so a change made at the same moment in the web UI or the service can no longer be overwritten. `add` now also creates the Cloudflare tunnel and DNS record right away, like the web UI, so a wrong zone or token shows up immediately
- Tunnels added to the config file by hand are picked up by the running service when you run `add` or `up`, and now also appear in open web UI and terminal dashboards without a reconnect
- Creating a tunnel without a Cloudflare API token now says to run `tuinnel-plus init`, in the web UI too
- `add` warns when another tunnel already uses the same port
- Fix: after the terminal dashboard's first-run setup, it showed "No tunnels configured yet" even when tunnels existed, and a tunnel added from another terminal could cut the setup off
- Fix: the bars under "Responses by status" in a tunnel's metrics were always empty
- Fix: opening the web UI directly on Settings showed remote access as off even when it was on, so pressing Save there turned it off
- Fix: when the terminal dashboard reconnected to a restarted service, a tunnel change that happened during the reconnect could be missed, so the dashboard showed an old state
- The terminal dashboard and CLI notice a service that stopped answering and reconnect instead of waiting forever, and wait longer between attempts while it keeps failing
- The web UI shows the version on its own row at the bottom of the sidebar
- Fix: the version shown in the web UI and by `--version` came from `package.json` when tuinnel-plus started, so a build could show a newer version than it was built from. The version is now fixed when tuinnel-plus is built, and a build made from anything other than a release also shows its commit, for example `0.1.4 (702daf5)` from `--version`
- The release and CI workflows use the Node 24 versions of GitHub's checkout and setup-node actions

## 0.1.4

- `tuinnel-plus service install` now works on Linux too: it sets up a systemd user service that starts at boot and restarts if it crashes. It turns on lingering when your system allows it, so the service also runs on a headless machine where nobody logs in; otherwise it shows the one command to run. `service status` and `service uninstall` work on Linux as well
- The README explains lingering for people who write their own systemd unit
- Fix: `service install` said it had succeeded even when the service could not start, for example because tuinnel-plus was already running outside it; it now says so and tells you which process to stop (macOS and Linux)
- The downloaded `cloudflared` is checked against the SHA-256 checksum GitHub publishes for it, and is not installed if it doesn't match
- Fix: pressing Esc in the terminal dashboard's Add and Edit forms threw away what you had typed; it now asks first
- Fix: signing out or changing the password did not stop live updates in browser tabs that were already open; those tabs now go back to the sign-in page, while the tab you changed the password in stays signed in
- Fix: other websites could show the web UI inside a frame; browsers now refuse to
- Fix: the subdomain for remote access to the web UI was not checked like other subdomains
- Fix: the web UI offered to restart the tunnel it was reached through, which cut off your own connection; the button is gone, and such a restart is refused

## 0.1.3

- Fix: buttons and menu entries in the web UI sometimes needed a second click while tunnels were busy
- Fix: a tunnel's log history did not load if a live log line had arrived before the Logs tab was opened
- The README shows a short demo of the web UI

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
