#!/bin/bash
# Create a local, self-signed code signing identity for Smoke.
#
# Why this exists: macOS ties Screen Recording permission to an app's code
# signature. An ad-hoc signature is derived from the app's contents, so it
# changes on every rebuild, macOS decides it is a different app, and the
# permission you granted is thrown away. Signing with a stable identity keeps
# the grant across rebuilds.
#
# The certificate is self-signed, marked CA:false, and is NOT added to the
# system trust store, so it can only sign, never vouch for anything else.
# Remove it any time in Keychain Access by deleting "Smoke Local Signing".
set -e

NAME="Smoke Local Signing"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if security find-certificate -c "$NAME" >/dev/null 2>&1; then
  echo "'$NAME' already exists. Nothing to do."
  exit 0
fi

echo "==> generating certificate"
openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

openssl pkcs12 -export -out "$TMP/id.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -passout pass:smoke -name "$NAME" >/dev/null 2>&1

echo "==> importing into your login keychain"
# -A lets codesign use the key without a prompt every build
security import "$TMP/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P smoke -A

echo
echo "Done. Now run: bash build.sh"
echo "Grant Screen Recording to Smoke once more, and it will stick from then on."
