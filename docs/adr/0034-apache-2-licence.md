# 0034. Open source under Apache-2.0

- Status: Accepted
- Date: 2026-10-03

## Context

The repository was public without a licence, which leaves every right with the author: nobody
could use, change or redistribute the code. Developers ask about the licence first, and the
free code signing for Windows that fits this project (the SignPath Foundation's programme)
is open only to projects under an OSI-approved licence.

A paid feature may come later, such as a hosted AI assistant behind a subscription.

## Decision

- **Licence:** the code is under the Apache License 2.0 (`LICENSE`), with the copyright and a
  trademark statement in `NOTICE`. Every workspace package says `"license": "Apache-2.0"`.
  Apache-2.0 lets anyone use, change and sell the code, includes a patent grant, and asks for
  attribution.
- **Name and logo:** "Querybara" and the capybara logo stay trademarks (Apache-2.0 section 6
  grants no trademark rights). Forks use their own name.
- **Contributions:** each commit carries a `Signed-off-by` line (Developer Certificate of
  Origin), as `CONTRIBUTING.md` says.
- **Privacy:** `PRIVACY.md` states what the app sends and where: the servers the user
  configures, and GitHub for update checks.
- **A paid feature** would be a service the maintainer runs (for example a hosted AI endpoint
  the app calls), not closed code inside the app. The app stays open source in full, so the
  signing programme's rule that a signed project contains no proprietary components holds.

## Consequences

- The website and the README can call Querybara open source and name the licence.
- Windows signing through the SignPath Foundation becomes possible once they accept the
  project; until then Windows releases stay unsigned.
- A paid hosted service must be checked against the signing programme's terms before it ships,
  since their rules forbid commercial dual-licensing.
