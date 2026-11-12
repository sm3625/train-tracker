# Turning On Password-Reset Email (Brevo)

Password reset is fully built (the routes, tokens, rate limits and the page's reset view), but no email goes out
yet. Until the steps below are done, `POST /v1/auth/reset` answers 503 and "Forgot your password?" says reset
isn't set up yet. Everything else in accounts and trips works without email.

## Where things stand

| Piece | State |
|---|---|
| Mail interface and Brevo adapter (`worker/src/mail.js`) | Done |
| Reset routes and email text (`worker/src/accounts.js`) | Done, tested with the `log` mailer |
| `MAIL_PROVIDER = "brevo"` in `worker/wrangler.toml` | Done |
| `MAIL_FROM` in `worker/wrangler.toml` | **Placeholder** (`noreply@example.com`) |
| `BREVO_API_KEY` in `.env` | **Missing** |
| Worker deployed with D1 and migrations 0001 and 0002 | **Not yet** |
| A real reset email sent and the link tested | **Not yet** |

## Remaining work

### 1. Brevo account (by hand, in the browser)
- [ ] Sign up at https://www.brevo.com. The free plan sends 300 emails a day.
- [ ] Go to **Senders, Domains & Dedicated IPs → Senders → Add a sender** and click the link Brevo emails you.
      Brevo will only send from a verified address.
- [ ] Go to **SMTP & API → API Keys** and create a key. It starts with `xkeysib-`.

### 2. Local config
- [ ] Add the key to `.env` at the repo root. `.env` is git-ignored, and the pre-commit hook refuses commits
      that contain the key.
      ```
      BREVO_API_KEY=xkeysib-...
      ```
- [ ] Set the verified sender in `worker/wrangler.toml`. This file is committed to a public repo, so use an
      address you're fine publishing:
      ```toml
      MAIL_FROM = "Trackside <the-address-you-verified>"
      ```
      The address must exactly match the one verified in Brevo, or Brevo rejects every send.
- [ ] Check that `SITE_URL` in `worker/wrangler.toml` is still the live page
      (`https://trackside-pearl.vercel.app/`). Reset links are built from it.

### 3. Deploy
- [ ] `cd worker && npm run deploy`. This uploads `BREVO_API_KEY` as a Worker secret, creates the D1
      database, applies `migrations/0001_accounts.sql` and `0002_trips_and_resets.sql`, and deploys.
- [ ] After that, commit and push the page (`index.html`, `data/`, `.github/`, and the worker changes).
      Deploy the worker first, so the page never calls routes that don't exist yet.

### 4. Verify end to end
- [ ] Run `npx wrangler tail` in `worker/` and leave it open. Send failures only show up there: the reset
      route always answers 202, so it never reveals whether an account exists.
- [ ] On the live site, create an account with an inbox you can check, sign out, and use **Forgot your password?**
- [ ] Confirm the email arrives, and check the spam folder too.
- [ ] Open the link, set a new password, and check that:
  - the page signs you in
  - `#reset=` disappears from the address bar
  - other signed-in sessions are signed out
  - the same link fails the second time
- [ ] Ask for 4 resets within an hour and confirm the 4th is refused (the limit is 3 per account per hour).

## Known limits and possible follow-ups

- **Spam folder.** A sender on a free email domain like Gmail may land in spam, because Brevo isn't one of
  Gmail's own servers. If that becomes a problem:
  - use your own domain, verified in Brevo with its SPF and DKIM records, or
  - switch to Resend: set `MAIL_PROVIDER = "resend"` and put `RESEND_API_KEY` in `.env`. Resend needs a
    verified domain.
- **Silent send failures.** A failed send is only logged (`reset email: Brevo: HTTP 4xx`). An alert or a retry
  could be added later.
- **No automated test against the real Brevo API.** The adapter's request shape (`sender`, `to`,
  `textContent`, `htmlContent`) follows Brevo's v3 `/smtp/email` docs and is only proven by step 4.
- **Plain-looking email.** The email is plain text plus minimal HTML. A styled template is optional polish.

## Reference

- Mail settings: `worker/src/mail.js` (header comment)
- Reset flow: `worker/src/accounts.js`, section "password reset"
- Secrets uploaded on deploy: `OPTIONAL` in `worker/publish.mjs`
- Local testing without email: `node worker/dev.mjs` uses `MAIL_PROVIDER: 'log'` and prints reset links to
  the console.
