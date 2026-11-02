# Roadmap

What's planned for tuinnel-plus, roughly in order. Ideas and feedback are welcome in the [issues](https://github.com/mrpap/tuinnel-plus/issues).

## Next

- **Install with Homebrew** — `brew install mrpap/tap/tuinnel-plus`, with releases published automatically from version tags
- **More protocols** — SSH, RDP and plain TCP tunnels (SMB as a TCP preset), managed like any other tunnel, with a ready-to-copy `cloudflared access` command for connecting
- **Linux service** — `tuinnel-plus service install` for systemd
- **Verified downloads** — check the checksum of the `cloudflared` binary it downloads
- **Web UI hardening** — end live updates on sign-out or password change, block embedding in other sites, stricter checks on the web UI's own subdomain, and no restart button on the tunnel that serves the dashboard itself
- **Safer forms** — ask before Esc closes a form with unsaved changes
- **One writer for the config** — `add` and `up` save new tunnels through the running service instead of writing the config file themselves

## Later

- **Cloudflare Access** — put a login (email code, SSO, service tokens) in front of any tunnel; pairs well with SSH and RDP, including browser-based access
- **Health checks and alerts** — restart tunnels whose local server stops answering, and notify when a tunnel goes down
- **Request inspector** — see the requests coming through a tunnel in the web UI
- **Project profiles** — start and stop a group of tunnels together
- **UDP** — via Cloudflare WARP private routing
- **Unix socket targets**
- **Windows support**
- **Homebrew core** — plain `brew install tuinnel-plus`, once the project qualifies
