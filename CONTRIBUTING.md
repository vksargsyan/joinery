# Contributing to Querybara

Thank you for helping. Querybara is licensed under the [Apache License 2.0](LICENSE); by
contributing you agree that your contribution is licensed under it too.

## Sign off your commits

Every commit needs a `Signed-off-by` line, which certifies the
[Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change,
or otherwise have the right to submit it under the project's licence.

```sh
git commit -s -m "fix(sql): keep the cursor after formatting"
```

`-s` adds the line from your Git name and email. Use your real name.

## Before you open a pull request

- Read the [README](README.md) for the layout, and the ADRs in [docs/adr](docs/adr) for why
  things are the way they are. A change to a major decision comes with a new ADR.
- Run the checks a pull request runs: `pnpm check` (format, lint, typecheck, unit tests).
- Use conventional commit messages (`feat(desktop): …`, `fix(cli): …`).
- Keep a pull request to one change, with a description of what it does and how you tested it.

## Name and logo

The code is open source; the name "Querybara" and the capybara logo are trademarks (see
[NOTICE](NOTICE)). Forks are welcome under their own name.
