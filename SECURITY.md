# Security policy

cubr is run by one person. Reports about https://cubr.dev or this code are very welcome. This page says how to send one and what to expect.

## Reporting a problem

Email **hello@cubr.dev** with "security" in the subject. Please don't open a public issue, pull request or discussion for anything that could put people's accounts or data at risk.

A good report has:
- **What's affected:** the page, the API route or the file and line;
- **How to reproduce it:** steps, a request or a short script;
- **What an attacker gains:** whose data, which actions;
- **How to credit you,** if you'd like to be.

You can expect:
- **A reply within a week,** usually sooner.
- **A fix as fast as the risk calls for.** Anything that exposes accounts or personal data comes first.
- **A note when it's fixed.** Credit in the patch notes too, if you want it.
- **No bug bounty.** There's no money to pay one.

## Testing in good faith

Research done in good faith won't be treated as an attack. That means:
- Use only accounts you own, or test accounts you made. Never read, change or delete other people's data; stop and report as soon as you see any.
- Don't degrade the service: no denial of service, load testing, spam or mass account creation.
- Give a reasonable time to fix a problem before you talk about it publicly. 90 days is a common default.

## Scope

**In scope:**
- **The site:** https://cubr.dev and its API (`/api/*`, `/socket.io`).
- **The code in this repository:**
  - the web app;
  - the services;
  - the deploy configuration.

**Out of scope:**
- **Volumetric attacks:** denial of service and anything that needs a flood of requests to show an effect.
- **People:** social engineering, and physical attacks.
- **Other companies' systems:** Cloudflare, Google Cloud, Resend, GitHub, the WCA.
- **Low-impact findings:**
  - automated scanner output with no shown impact;
  - missing headers without an attack that uses them;
  - self-XSS;
  - clickjacking on pages with no sensitive action;
  - user enumeration through the sign-up form (usernames are public).

## Supported versions

Only what runs on cubr.dev, built from `main`, gets fixes. The machine-readable contact is at https://cubr.dev/.well-known/security.txt (RFC 9116).
