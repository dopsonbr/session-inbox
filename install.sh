#!/bin/sh
# Session Inbox installer (G-025): picks the release, downloads it, checks its SHA-256 and
# hands over to the release's own `session-inbox install`. Nothing outside a temp dir is
# touched before that hand-over, and nothing here needs sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/dopsonbr/session-inbox/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --no-app        # options go to `session-inbox install`
#
# Environment: SESSION_INBOX_VERSION=v0.2.0 (default: latest release),
# SESSION_INBOX_RELEASES_URL (GitHub API releases URL), SESSION_INBOX_ASSET_URL (download base).
set -eu

REPO="${SESSION_INBOX_REPO:-dopsonbr/session-inbox}"
RELEASES="${SESSION_INBOX_RELEASES_URL:-https://api.github.com/repos/$REPO/releases}"

say() { printf 'session-inbox: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

[ "$(uname -s)" = Darwin ] || die "Session Inbox runs on macOS only."
if [ "$(uname -m)" != arm64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" != 1 ]; then
  die "release builds are Apple silicon only; on an Intel Mac install from source (see README: Install from source)."
fi

if [ -n "${SESSION_INBOX_VERSION:-}" ]; then
  tag="v${SESSION_INBOX_VERSION#v}"
else
  tag=$(curl -fsSL -H "User-Agent: session-inbox" "$RELEASES/latest" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) ||
    die "couldn't reach $RELEASES/latest"
  [ -n "$tag" ] || die "no published release found at $RELEASES/latest"
fi
version="${tag#v}"
name="session-inbox-$version-macos-arm64.tar.gz"
base="${SESSION_INBOX_ASSET_URL:-https://github.com/$REPO/releases/download/$tag}"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/session-inbox.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM

say "downloading Session Inbox $version"
curl -fsSL -H "User-Agent: session-inbox" -o "$tmp/$name" "$base/$name" || die "download failed: $base/$name"
curl -fsSL -H "User-Agent: session-inbox" -o "$tmp/$name.sha256" "$base/$name.sha256" ||
  die "download failed: $base/$name.sha256"

expected=$(cut -d ' ' -f 1 <"$tmp/$name.sha256")
actual=$(shasum -a 256 "$tmp/$name" | cut -d ' ' -f 1)
[ -n "$expected" ] && [ "$expected" = "$actual" ] || die "checksum mismatch for $name; not installing"

tar -xzf "$tmp/$name" -C "$tmp"
payload="$tmp/session-inbox-$version"
[ -x "$payload/bin/session-inbox" ] || die "the release archive has no bin/session-inbox"

"$payload/bin/session-inbox" install --from "$payload" --yes "$@"
