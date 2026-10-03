# Privacy

Querybara collects no usage data, crash reports or analytics, and has no account to sign in to.

It connects to other systems only in these cases:

- **The servers you configure.** Your databases, and the SSH servers and proxies you set up to
  reach them, when you connect, test a connection or run a job. What it sends there is what you
  ask it to: queries, edits, imports and the like.
- **Update checks.** The desktop app asks GitHub (github.com, where releases are published)
  whether a newer version exists, 30 seconds after it starts and every 4 hours, and downloads
  the update from there. GitHub sees your IP address, as with any download. Turn it off in
  **Help → About** ("Check for updates automatically"); an administrator can turn it off with
  a policy (see [docs/releasing.md](docs/releasing.md)).
- **Links you open**, such as the documentation or release notes, open in your browser.

Connection profiles, history and settings stay on your computer. Saved passwords are encrypted
with your operating system's keychain (or, for the command-line tool, a passphrase you choose).
