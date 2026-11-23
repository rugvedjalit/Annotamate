# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 2.x (web application) | Yes: security fixes are released for the latest 2.x version |
| 1.x (desktop application) | No |

Please upgrade to the latest release before reporting a problem; it may already be fixed.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub security advisories:

1. Go to <https://github.com/rugvedjalit/Annotamate/security/advisories/new>
   (repository → **Security** → **Report a vulnerability**).
2. Describe the problem, the affected version and how to reproduce it. A minimal proof of concept
   helps a great deal.
3. Say whether and how you would like to be credited.

What to expect:

- an acknowledgement within 7 days;
- an assessment and, for confirmed problems, a plan for the fix;
- a fixed release and a published advisory, with credit to you unless you prefer otherwise.

Please allow time for a fix to be released before disclosing details publicly.

### In scope

- Bypassing authentication, or acting with a role you do not have
- Reading or writing files outside the configured dataset roots
- Cross-site scripting, cross-site request forgery, session fixation or session theft
- Reading another user's direct messages, or data of projects you are not a member of
- Remote code execution, including through uploaded or crafted image and label files
- Vulnerabilities in the published container image that come from this project's configuration

### Out of scope

- Problems that require an administrator account. Administrators are trusted: they choose which
  server folders become projects.
- Problems that require access to the server's file system or database
- Risks of running without HTTPS on an untrusted network, which this document warns against
- Denial of service by authenticated users through sheer volume of requests

## Security model in brief

- **Accounts.** Every request except the health check, the sign-in page and the first-run setup
  needs a signed-in user. Passwords are hashed with argon2id. Sign-in is rate-limited to 10 failed
  attempts per address and user name in 10 minutes.
- **Sessions.** A random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie; only its SHA-256
  hash is stored on the server. Deactivating a user or changing a password revokes sessions.
- **Cross-site requests.** Every state-changing API request must carry a custom header that
  browsers do not send across sites, and no CORS is configured. WebSocket connections are accepted
  only when their `Origin` matches the host.
- **File system.** Every path is resolved (following symbolic links) and must lie inside a
  configured dataset root. Browsers refer to images by numeric ID; paths are accepted only in the
  administrator's folder browser and in project creation, and are validated there.
- **Uploads.** Managers only, image extensions only, size-limited, sanitised file names, existing
  files are never overwritten.
- **Browser.** Strict Content-Security-Policy (same origin only), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`. No third-party resources are loaded.

Details: [docs/architecture.md](docs/architecture.md), section 10.

## Hardening checklist

For anyone operating a server. The [deployment guide](docs/guides/deployment.md) shows how to do
each of these.

**Network**

- [ ] Serve the application over **HTTPS** through a reverse proxy, or reach it only through an SSH
      tunnel or a VPN. Never expose plain HTTP to an untrusted network.
- [ ] Set `ANNOTAMATE_SECURE_COOKIES=true` when using HTTPS.
- [ ] Keep `ANNOTAMATE_HOST=127.0.0.1` when a reverse proxy runs on the same machine, so the
      application cannot be reached around the proxy. With Docker, publish the port on
      `127.0.0.1` only or not at all.
- [ ] Restrict access with a firewall or VPN if the server does not need to be public.
- [ ] Make sure the proxy passes the `Host` header through unchanged; the WebSocket origin check
      depends on it.
- [ ] Set `FORWARDED_ALLOW_IPS` to the proxy's address if it does not run on the same host (never
      `*` when clients can reach the application directly), so that the sign-in rate limit sees
      real client addresses.

**Accounts**

- [ ] Create the administrator account **immediately** after the first start. Until then, whoever
      opens the site first can create it. Alternatively create it beforehand with
      `annotamate user create NAME --admin`.
- [ ] Give every person their own account; do not share accounts.
- [ ] Keep the number of administrators small and give project roles according to need
      (viewer, annotator, reviewer, manager).
- [ ] Deactivate accounts of people who leave. This ends their sessions at once.
- [ ] Use long, unique passwords. The minimum length is 8 characters; a password manager makes
      longer ones painless.

**File system**

- [ ] Run the server as a dedicated, unprivileged user, never as root. The container image and the
      systemd unit do this by default.
- [ ] Keep the dataset roots (`ANNOTAMATE_ROOTS`) as narrow as possible: the folders that hold
      datasets, not `/` or a home directory.
- [ ] Keep the data directory outside the dataset roots and readable only by the service user. It
      contains the database with password hashes, messages and session hashes.
- [ ] With systemd, keep the sandboxing options of the provided unit (`NoNewPrivileges`,
      `ProtectSystem=strict`, `PrivateTmp`, restricted `ReadWritePaths`).
- [ ] With Docker, keep the non-root user, and consider the read-only root file system and dropped
      capabilities used in the provided Compose file.

**Operations**

- [ ] Back up the database and the label folders regularly, and test a restore.
- [ ] Keep Annotamate, the base image, the reverse proxy and the operating system up to date. Watch
      the repository's releases for security fixes.
- [ ] Run exactly one server process. Multiple workers or replicas are not supported.
- [ ] Keep `ANNOTAMATE_MAX_UPLOAD_MB` and the proxy's request-size limit as low as your images allow.
- [ ] Review the server logs occasionally for repeated failed sign-ins.
