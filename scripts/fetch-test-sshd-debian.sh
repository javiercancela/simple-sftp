#!/usr/bin/env bash
# Fetch an unprivileged OpenSSH sshd for integration tests on Debian 13
# (trixie) amd64 hosts WITHOUT root: download signed .debs and extract them.
# Not needed where openssh-server is installed (/usr/sbin/sshd) or on macOS.
#
# Usage: scripts/fetch-test-sshd-debian.sh [dest]   (default: .tools/openssh)
# Then:  export SFTP_TEST_SSHD=<dest>/root/usr/sbin/sshd
#        export SFTP_TEST_SSHD_LD_LIBRARY_PATH=<dest>/root/usr/lib/x86_64-linux-gnu
set -euo pipefail
DEST="${1:-.tools/openssh}"
KEYRING=/usr/share/keyrings/debian-archive-keyring.pgp
mkdir -p "$DEST" && cd "$DEST"

verify_release() { # $1 = InRelease file
  if command -v sqv >/dev/null; then
    rm -f .verified && sqv --keyring "$KEYRING" --cleartext --output .verified "$1" >/dev/null
  else
    gpgv --keyring "$KEYRING" "$1"
  fi
}

fetch_pkg() { # $1 = base URL, $2 = suite, $3 = package
  local base=$1 suite=$2 pkg=$3
  local rel="InRelease-${suite}" idx="Packages-${suite}"
  if [ ! -f "$rel" ]; then
    curl -fsS -o "$rel" "$base/dists/$suite/InRelease"
    verify_release "$rel"
    curl -fsS -o "$idx.xz" "$base/dists/$suite/main/binary-amd64/Packages.xz"
    local want; want=$(grep " main/binary-amd64/Packages.xz$" "$rel" | tail -1 | awk '{print $1}')
    echo "$want  $idx.xz" | sha256sum -c --quiet
    xz -dc "$idx.xz" > "$idx"
  fi
  local block file sha
  block=$(awk -v p="Package: $pkg" '$0==p{f=1} f&&/^$/{exit} f' "$idx")
  file=$(echo "$block" | awk '/^Filename:/{print $2}')
  sha=$(echo "$block" | awk '/^SHA256:/{print $2}')
  curl -fsS -O "$base/$file"
  echo "$sha  $(basename "$file")" | sha256sum -c --quiet
  dpkg -x "$(basename "$file")" root
}

fetch_pkg https://deb.debian.org/debian-security trixie-security openssh-server
fetch_pkg https://deb.debian.org/debian-security trixie-security openssh-sftp-server
fetch_pkg https://deb.debian.org/debian trixie libwtmpdb0
LD_LIBRARY_PATH="$PWD/root/usr/lib/x86_64-linux-gnu" "$PWD/root/usr/sbin/sshd" -V 2>&1 | head -1
echo "sshd extracted to $PWD/root/usr/sbin/sshd"
