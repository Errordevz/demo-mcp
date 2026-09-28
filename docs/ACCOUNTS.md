# DEMO accounts — registration, sign-in, email verification, password recovery

DEMO has three identity systems and they are deliberately independent:

| System | Who it proves | Where it is used | Never used for |
| --- | --- | --- | --- |
| **DEMO website account** (this document) | a person with an email address and password | the site's account dashboard, and the optional "sign in" step of the MCP consent page | gatekeeping public MCP tools |
| **MCP OAuth 2.1 + PKCE** ([`MCP-OAUTH.md`](MCP-OAUTH.md)) | an MCP client (ChatGPT) acting per tool | protected tools (`roblox_account_*`, `jev_decide`) | the website account session |
| **Roblox OAuth** ([`ROBLOX.md`](ROBLOX.md)) | a Roblox player | linking a Roblox account to a DEMO identity | website sign-in |

Public `/mcp` initialization, discovery, resources and public tools stay open
without any login. The website session (`demo_session`) and the MCP OAuth
`access_token` are separate credentials with separate lifetimes.

## 1. What a person can do

* Register with email + password (+ an optional display name), and receive a
  verification email with both an 8-character code and a one-click link.
* Sign in, sign out, stay signed in across refreshes (30-day absolute session),
  list sessions, revoke one session or all others.
* Change the display name; request a fresh verification email.
* Change the password by proving the current one.
* Recover a forgotten password end to end: `Forgot password` → emailed
  single-use link → new password → the change is confirmed by email and every
  previous session is revoked.
* Delete the account (password + `DELETE` confirmation): every session, the
  email index, the verification record, and the linked Roblox grant go away.

Verification is required before Roblox linking when
`ACCOUNT_REQUIRE_VERIFIED_FOR_LINKING=true` (the shipped value). Unverified
accounts can still sign in — they are simply told what is missing.

## 2. HTTP contract (all under `/account`, JSON, `no-store`)

| Route | Purpose | Success shape |
| --- | --- | --- |
| `GET /account/session` | session probe | `{ ok, signedIn, accountsAvailable, emailDelivery, verificationRequired, account?, session? }` |
| `POST /account/register` | create account | `201 { ok, registered, authenticated, account, emailDelivery, verification }`; a duplicate/taken email answers `200 { ok, registered, authenticated:false }` with no session (non-enumerating) |
| `POST /account/login` | sign in | `{ ok, authenticated, account, emailDelivery, verificationRequired }` |
| `POST /account/logout` | end this session | `{ ok }` + cleared cookie |
| `GET /account/me`, `POST /account/profile` | read / set display name | `{ ok, account }`; `409 display_name_taken` |
| `POST /account/verify/request` | (re)send verification | `{ ok, verification }`; `429` inside the 60 s cooldown |
| `POST /account/verify/confirm` | confirm | `{ token }` works with **no session** (emailed link, single-use); `{ code }` requires the session; expired/reused/unknown → `410` |
| `POST /account/password/forgot` | start recovery | uniform `200` whatever the address |
| `POST /account/password/reset` | finish recovery | `{ ok, reset, sessionsRevoked, emailVerified }` |
| `POST /account/password/change` | change password | `{ ok, changed, otherSessionsRevoked }` |
| `GET /account/sessions`, `POST /account/sessions/revoke`, `POST /account/sessions/revoke-others` | session management | `{ ok, sessions }` / `{ ok, revoked }` |
| `POST /account/delete` | delete account | `{ ok, deleted }` |

Every POST passes the same-origin gate (`Origin` must match the request host,
or `Sec-Fetch-Site` must not be `cross-site`) and requires a JSON body of at
most 8 KB.

## 3. Email delivery

The DEMO sender identity is **`demomcp7@gmail.com`**. Owning that mailbox does
not by itself grant permission to send *as* it — the sending path has to be one
the mailbox's provider accepts. Three modes are supported, and the account
system works without any of them (it simply says email is off instead of
promising a message that can never arrive).

### 3.1 `gmail` — send as the mailbox itself (the DEMO sender identity)

This is the only way to send from `demomcp7@gmail.com`, because Gmail refuses
to relay for a mailbox you cannot authenticate as.

1. On the Google account for `demomcp7@gmail.com`, enable **2-Step
   Verification** (App Passwords do not exist without it).
2. Create an **App Password** (Google Account → Security → App passwords →
   "Mail" / "Other (custom name)").
3. Store it as a Worker secret — never in the repo, never in the dashboard's
   plain vars, never in a response or log:

   ```bash
   wrangler secret put SMTP_PASSWORD
   ```

That is the whole setup: `EMAIL_PROVIDER=gmail` and
`EMAIL_FROM="DEMO MCP <demomcp7@gmail.com>"` are already in `wrangler.jsonc`,
and the SMTP username defaults to the `EMAIL_FROM` address. The Worker connects
to `smtp.gmail.com:465` with implicit TLS. No DNS, SPF, DKIM or DMARC work is
needed on the DEMO side — Gmail sends from Google's own infrastructure, and the
message's `Reply-To` is the same mailbox.

### 3.2 `resend` — an HTTP API, for a domain you own

Resend can only send from a domain whose DNS records you control and have
verified. `gmail.com` is not such a domain, so the configuration refuses it and
explains why rather than failing per send. Use it with, for example,
`EMAIL_FROM="DEMO MCP <auth@yourdomain.example>"` and keep
`demomcp7@gmail.com` as `EMAIL_REPLY_TO`; set the `RESEND_API_KEY` secret.

### 3.3 `smtp` — any authenticated relay

`SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` + the `SMTP_PASSWORD` secret.
Port 465 uses implicit TLS, port 587 uses STARTTLS; port 25 is refused (the
runtime cannot connect to it) and plaintext submission is refused for any
non-loopback host, because the App Password would cross the network in the
clear.

### 3.4 Variables and secrets

| Name | Kind | Meaning |
| --- | --- | --- |
| `EMAIL_PROVIDER` | var | `gmail` (shipped), `resend`, `smtp`, or unset for "email off" |
| `EMAIL_FROM` | var | `DEMO MCP <demomcp7@gmail.com>` — the visible sender |
| `EMAIL_REPLY_TO` | var | optional reply-to (defaults to the sender) |
| `ACCOUNT_EMAIL_TIMEOUT_MS` | var | how long a send may block a request (default 8000) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME` | vars | only for `smtp` / `gmail` |
| `SMTP_PASSWORD` | **secret** | Gmail App Password (or relay password) |
| `RESEND_API_KEY` | **secret** | only for `resend` |

A rejected send is reported as a failure with the provider's stage and code
(for example `rcpt_to 550`), and the account page shows that reason — the UI
never claims a message went out when the provider refused it.

## 4. Security properties (implemented, tested)

* Passwords: PBKDF2-HMAC-SHA256, 210,000 iterations, per-user salt, constant-time
  compare, rehash-on-sign-in when the parameters change; policy 10–128 chars,
  letters + digits, small breached denylist. Nothing is ever stored or logged in
  clear text.
* Tokens: opaque random values; only SHA-256 hashes are stored. Verification
  codes (8 characters, unambiguous alphabet) expire in 30 minutes with an
  attempt counter; link and reset tokens are single-use and are superseded when
  a new one is issued.
* Sessions: `<random>.<random>` cookie, hash-only storage, `HttpOnly`,
  `SameSite=Lax`, `Secure` on https/localhost, 30-day absolute TTL, listed and
  revocable per session.
* Abuses: per-minute rate limits on register/login/verify/forgot, a 60-second
  resend cooldown, a 5-attempt code lockout, and equal-cost hashing for unknown
  emails. Register and forgot answers are uniform, and duplicates are
  non-enumerating — only display names are public (that is the point of a
  handle), so a taken name is reported as `409`.
* CSRF: every mutating route is POST + same-origin and JSON-only.
* Isolation: sessions, profile, and session-revocation are scoped to the
  authenticated account; a foreign session id is invisible and cannot be
  revoked. See `tests/account.test.ts` → *account isolation*.

## 5. Local end-to-end testing

The whole flow can be exercised locally against a real Durable Object and a
real SMTP conversation. `.dev.vars` (gitignored) points the Worker at a local
sink:

```
EMAIL_PROVIDER=smtp
EMAIL_FROM=DEMO MCP <demomcp7@gmail.com>
SMTP_HOST=127.0.0.1
SMTP_PORT=2525
SMTP_SECURE=false
SMTP_USERNAME=demomcp7@gmail.com
SMTP_PASSWORD=local-sink-only-not-a-real-credential
```

Run a sink on `127.0.0.1:2525` that answers `220/250/354/235` and writes DATA
to a file, start `wrangler dev --local`, then drive the API with `curl` (send
`Origin: http://127.0.0.1:8787` — the same-origin gate is real):

```bash
curl -sS -c jar -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8787' \
  -X POST http://127.0.0.1:8787/account/register \
  -d '{"email":"you@example.test","password":"correct-horse-9","passwordConfirm":"correct-horse-9"}'
```

Read the code/link out of the sink's log, confirm the link without a cookie,
then sign out, sign back in, and run the reset flow. Plaintext SMTP is allowed
only for loopback hosts for exactly this reason.

## 6. Fixed on this branch

Registration reported no definite success on the live site even though the
account was created. Root cause: `POST /account/register` returned
`201 { ok, registered, account, verification }` and set the `demo_session`
cookie, but the single-page app decided success by reading `d.authenticated`,
a field the endpoint never returned. Every successful sign-up therefore fell
through to the ambiguous "if this email is not already registered…" message and
never adopted the session — while `GET /account/session` with the same cookie
reported `signedIn: true`. The endpoint now returns `authenticated`
explicitly (true only when the account really exists and a session was issued),
and the UI requires `authenticated && account` before it claims anything.

The second half of the same problem was delivery: the deployment reported
`accounts.emailDelivery: false` (no provider configured), so the code and link
in the verification email could never arrive while the UI still said "check
your inbox". The UI now renders the server's own delivery report, including the
reason and the name of the missing secret, instead of a promise.
