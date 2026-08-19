# Patient Oracle

> **A question may wait. Its answer must return with its identity intact.**

Patient Oracle is a standalone Chrome extension and GitHub-backed request/response worker. It uses one disposable ChatGPT conversation per authorized request while keeping durable request identity, progress, and answers in GitHub.

This utility is intentionally independent from the Rerun extension. The Rerun project is only the reference for inherited safety rules such as the 18-minute checkpoint, 20-minute hard stop, approval safety, duplicate-dispatch prevention, revision monotonicity, composer protection, and GitHub reconciliation.

## Files

- `manifest.json` — standalone Manifest V3 extension.
- `background.js` — GitHub scheduler, bootstrap, revision/rate-limit safety, fresh-chat dispatch.
- `content.js` — safe ChatGPT composer submission and lifecycle observation; never scrapes answer text.
- `control.js` — strict protocol parsing, identities, prompts, and 18/20-minute execution budget.
- `popup.html` / `popup.js` — independent Patient Oracle controls.
- `caller.mjs` — external GitHub-only request publisher and response waiter.
- `CONTRACT.md` — durable protocol copied into target repositories during bootstrap.

## Run

```bash
git clone https://github.com/Kaetaeru/AI-Utilities.git
cd AI-Utilities
git switch agent/patient-oracle-mvp
cd "Patient Oracle"
npm run check
npm test
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `AI-Utilities/Patient Oracle/` directory.

Open a ChatGPT tab, open Patient Oracle from the Chrome toolbar, configure the GitHub owner/repository/branch and optional token, then click **Start Oracle**.

For external requests:

```bash
export GITHUB_TOKEN=...
npm run oracle:ask -- --owner OWNER --repo REPOSITORY --branch BRANCH --prompt "Your question"
```

GitHub is the durable response channel. The extension never treats assistant DOM text as the answer API.