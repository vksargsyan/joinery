#!/usr/bin/env bash
# Checks the macOS signing files and stores them as the Package workflow's secrets
# (docs/releasing.md, "Signing and notarisation secrets"): the Developer ID Application
# certificate exported from Keychain Access as a .p12, and the App Store Connect API key (.p8)
# that notarises. Run it yourself, signed in to gh as a maintainer; it asks for the .p12
# password and the key's issuer id, never prints a secret, and writes nothing to disk.
#
# Usage: set-mac-signing-secrets.sh [--check] <DeveloperID.p12> <AuthKey_XXXXXXXXXX.p8>
#   --check   check the files only; store nothing
# The repository is vksargsyan/joinery unless JOINERY_REPO names another.
set -euo pipefail

check_only=false
if [ "${1:-}" = "--check" ]; then
  check_only=true
  shift
fi
p12=${1:?Usage: set-mac-signing-secrets.sh [--check] <DeveloperID.p12> <AuthKey_XXXXXXXXXX.p8>}
p8=${2:?Usage: set-mac-signing-secrets.sh [--check] <DeveloperID.p12> <AuthKey_XXXXXXXXXX.p8>}
repo=${JOINERY_REPO:-vksargsyan/joinery}

fail() {
  echo "✗ $*" >&2
  exit 1
}
ok() { echo "✓ $*"; }

[ -f "$p12" ] || fail "No such file: $p12"
[ -f "$p8" ] || fail "No such file: $p8"
command -v openssl >/dev/null || fail "openssl is not installed"
if ! $check_only; then
  command -v gh >/dev/null || fail "gh is not installed"
  gh auth status >/dev/null 2>&1 || fail "gh is not signed in: run gh auth login"
fi

# --- The certificate ---------------------------------------------------------------------------

read -rsp "Password of $(basename "$p12"): " P12_PASSWORD
echo
export P12_PASSWORD

# Keychain Access may write the .p12 with the older ciphers OpenSSL 3 reads only with -legacy;
# macOS's own LibreSSL reads them as they are.
pkcs12() {
  openssl pkcs12 -in "$p12" -passin env:P12_PASSWORD "$@" 2>/dev/null ||
    openssl pkcs12 -legacy -in "$p12" -passin env:P12_PASSWORD "$@" 2>/dev/null ||
    /usr/bin/openssl pkcs12 -in "$p12" -passin env:P12_PASSWORD "$@" 2>/dev/null
}

missing_key="$(basename "$p12") has the certificate but not its private key: export it from My Certificates, with the key under it"
# -clcerts keeps the certificate that has its key in the file.
certificate=$(pkcs12 -nokeys -clcerts) ||
  fail "$(basename "$p12") does not open with that password (or is not a .p12)"
if ! grep -q 'BEGIN CERTIFICATE' <<<"$certificate"; then
  [ "$(pkcs12 -nokeys | grep -c 'BEGIN CERTIFICATE')" -gt 0 ] && fail "$missing_key"
  fail "$(basename "$p12") holds no certificate"
fi
subject=$(printf '%s\n' "$certificate" | openssl x509 -noout -subject 2>/dev/null) ||
  fail "$(basename "$p12") holds no certificate"
case "$subject" in
  *"Developer ID Application"*) ;;
  *"Apple Development"* | *"Apple Distribution"* | *"Developer ID Installer"*)
    fail "This is not a Developer ID Application certificate ($subject). Create one in Xcode: Settings → Accounts → Manage Certificates → + → Developer ID Application" ;;
  *) fail "This is not a Developer ID Application certificate ($subject)" ;;
esac
printf '%s\n' "$certificate" | openssl x509 -noout -checkend 0 >/dev/null ||
  fail "The certificate has expired ($(printf '%s\n' "$certificate" | openssl x509 -noout -enddate))"
# The private key must come along, or nothing can be signed. It is only counted, never shown
# (grep -c reads to the end, so the pipe cannot fail on a closed reader).
[ "$(pkcs12 -nocerts -nodes | grep -c 'PRIVATE KEY')" -gt 0 ] || fail "$missing_key"
name=$(printf '%s\n' "$subject" | sed -E 's/.*CN ?= ?([^,/]*).*/\1/')
expires=$(printf '%s\n' "$certificate" | openssl x509 -noout -enddate | cut -d= -f2)
ok "Certificate: $name, valid until $expires, with its private key"

# --- The notarisation key ----------------------------------------------------------------------

grep -q -- '-----BEGIN PRIVATE KEY-----' "$p8" ||
  fail "$(basename "$p8") is not an App Store Connect API key (.p8)"
openssl pkey -in "$p8" -noout 2>/dev/null || fail "$(basename "$p8") does not read as a private key"
key_id=$(basename "$p8" | sed -nE 's/^AuthKey_([A-Z0-9]{10})\.p8$/\1/p')
if [ -z "$key_id" ]; then
  read -rp "Key ID of the API key (10 characters, from App Store Connect): " key_id
fi
[[ "$key_id" =~ ^[A-Z0-9]{10}$ ]] || fail "A key ID is 10 upper-case letters and digits, not '$key_id'"
read -rp "Issuer ID (the UUID above the keys in App Store Connect): " issuer
issuer=$(printf '%s' "$issuer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
[[ "$issuer" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
  fail "An issuer ID is a UUID like 69a6de70-03db-47e3-e053-5b8c7c11a4d1"
ok "API key: $key_id, issuer $issuer"

if $check_only; then
  echo "Checked only: nothing was stored."
  exit 0
fi

# --- The secrets ------------------------------------------------------------------------------

echo "Storing the secrets in ${repo}…"
# Values go to gh on stdin (printf is a shell builtin), so none of them shows in a process list.
base64 -i "$p12" | gh secret set MAC_CERTIFICATE_P12_BASE64 --repo "$repo"
printf '%s' "$P12_PASSWORD" | gh secret set MAC_CERTIFICATE_PASSWORD --repo "$repo"
gh secret set APPLE_API_KEY_P8 --repo "$repo" <"$p8"
printf '%s' "$key_id" | gh secret set APPLE_API_KEY_ID --repo "$repo"
printf '%s' "$issuer" | gh secret set APPLE_API_ISSUER --repo "$repo"
unset P12_PASSWORD

stored=$(gh secret list --repo "$repo" --json name --jq '.[].name')
for secret in MAC_CERTIFICATE_P12_BASE64 MAC_CERTIFICATE_PASSWORD APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER; do
  grep -qx "$secret" <<<"$stored" || fail "$secret is missing from $repo"
done
ok "All five secrets are in $repo. Keep the .p12 and .p8 in a password manager and delete the loose copies."
