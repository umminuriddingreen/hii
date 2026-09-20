#!/bin/sh
# HII CLI network installer.
#
#   curl -fsSL https://humaninformationinterface.com/install | sh
#
# Installs a prebuilt `hii` into the same layout `hii-release-installer.mjs`
# uses, so the two are interchangeable and an install from either can be
# upgraded by the other:
#
#   ~/.hii/releases/hii-cli/<version>/hii   the binary
#   ~/.hii/releases/hii-cli/current.bin     marker: first line is the live binary
#   ~/.local/bin/hii                        launcher, reads the marker and execs
#
# The launcher is what makes an upgrade atomic: it never changes, so switching
# versions is a single write to the marker rather than a binary swap underneath
# a running shell.
#
# POSIX sh with no Node or Rust required — that is the point. Node is needed
# only for HII's extended command surface, which a standalone install does not
# ship.

set -eu

REPO="${HII_INSTALL_REPO:-umminuriddingreen/hii}"
RELEASE_ROOT="${HII_RELEASE_ROOT:-${HOME}/.hii/releases/hii-cli}"
BIN_DIR="${HII_BIN_DIR:-${HOME}/.local/bin}"
MARKER="${RELEASE_ROOT}/current.bin"
TAG="${HII_INSTALL_TAG:-latest}"

say() { printf 'hii: %s\n' "$1" >&2; }
die() { printf 'hii: %s\n' "$1" >&2; exit 1; }

need() {
    command -v "$1" >/dev/null 2>&1 || die "this installer needs $1, which is not on PATH."
}

need uname
need tar
need mkdir

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
    fetch_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO "$2" "$1"; }
    fetch_stdout() { wget -qO- "$1"; }
else
    die "this installer needs curl or wget."
fi

# --- platform ---------------------------------------------------------------

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
    Darwin) os_part="apple-darwin" ;;
    Linux)  os_part="unknown-linux-gnu" ;;
    *) die "unsupported operating system: $os. Build from source: https://github.com/${REPO}" ;;
esac

case "$arch" in
    arm64|aarch64) arch_part="aarch64" ;;
    x86_64|amd64)  arch_part="x86_64" ;;
    *) die "unsupported architecture: $arch. Build from source: https://github.com/${REPO}" ;;
esac

target="${arch_part}-${os_part}"
archive="hii-${target}.tar.gz"

# Latest assets come from HII; explicit tags come from GitHub releases. A mirror
# can be selected with HII_INSTALL_BASE_URL. The layout it must
# serve is flat: <base>/hii-<target>.tar.gz and <base>/SHA256SUMS.
if [ -n "${HII_INSTALL_BASE_URL:-}" ]; then
    base="${HII_INSTALL_BASE_URL%/}"
elif [ "$TAG" = "latest" ]; then
    base="https://humaninformationinterface.com/cli/releases/latest"
else
    base="https://github.com/${REPO}/releases/download/${TAG}"
fi

# --- download ---------------------------------------------------------------

tmp="$(mktemp -d "${TMPDIR:-/tmp}/hii-install.XXXXXX")"
# Leaving a half-downloaded tree behind on a failed install is how a retry picks
# up a corrupt archive and reports a confusing checksum error instead.
trap 'rm -rf "$tmp"' EXIT INT TERM

say "installing hii for ${target}"
fetch "${base}/${archive}" "${tmp}/${archive}" \
    || die "could not download ${base}/${archive} — check the release exists for ${target}."

# --- verify -----------------------------------------------------------------
#
# The binaries are unsigned, so the checksum is the only integrity check between
# the release and this machine. A missing SHA256SUMS is treated as fatal rather
# than skipped: silently installing an unverified binary is worse than failing.

if command -v shasum >/dev/null 2>&1; then
    sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
    sha_of() { sha256sum "$1" | awk '{print $1}'; }
else
    die "this installer needs shasum or sha256sum to verify the download."
fi

sums="$(fetch_stdout "${base}/SHA256SUMS")" \
    || die "could not download the checksum list; refusing to install unverified."

expected="$(printf '%s\n' "$sums" | awk -v name="$archive" '$2 == name || $2 == "*"name {print $1}' | head -n 1)"
[ -n "$expected" ] || die "no checksum published for ${archive}; refusing to install unverified."

actual="$(sha_of "${tmp}/${archive}")"
if [ "$expected" != "$actual" ]; then
    die "checksum mismatch for ${archive}.
  expected ${expected}
  actual   ${actual}
Refusing to install. Report this at https://github.com/${REPO}/issues"
fi

# --- install ----------------------------------------------------------------

tar -xzf "${tmp}/${archive}" -C "$tmp" || die "could not unpack ${archive}."
[ -f "${tmp}/hii" ] || die "${archive} did not contain a hii binary."
chmod +x "${tmp}/hii"

version="$("${tmp}/hii" --version 2>/dev/null | awk '{print $NF}')"
[ -n "$version" ] || die "the downloaded binary does not run on this machine."

dest_dir="${RELEASE_ROOT}/${version}"
mkdir -p "$dest_dir" "$BIN_DIR"
# Move into place under a temporary name first: replacing a binary that a
# running process has open fails on some filesystems, and a partial copy would
# leave the marker pointing at a truncated file.
cp "${tmp}/hii" "${dest_dir}/hii.incoming"
chmod +x "${dest_dir}/hii.incoming"
mv -f "${dest_dir}/hii.incoming" "${dest_dir}/hii"

printf '%s\n' "${dest_dir}/hii" > "${MARKER}.incoming"
mv -f "${MARKER}.incoming" "$MARKER"

cat > "${BIN_DIR}/hii.incoming" <<LAUNCHER
#!/bin/sh
set -eu
marker_file="\${HII_CLI_RELEASE_MARKER:-${MARKER}}"
if [ ! -f "\${marker_file}" ]; then
  echo "hii: no HII release marker found at \${marker_file}." >&2
  echo "Reinstall with the release installer." >&2
  exit 1
fi
release_binary="\$(sed -n "1p" "\${marker_file}" | tr -d "\r")"
if [ -z "\${release_binary}" ]; then
  echo "hii: release marker is empty." >&2
  exit 1
fi
if [ ! -x "\${release_binary}" ]; then
  echo "hii: release binary is not executable: \${release_binary}" >&2
  exit 1
fi
exec "\${release_binary}" "\$@"
LAUNCHER
chmod +x "${BIN_DIR}/hii.incoming"
mv -f "${BIN_DIR}/hii.incoming" "${BIN_DIR}/hii"

say "installed hii ${version} to ${dest_dir}/hii"

case ":${PATH}:" in
    *":${BIN_DIR}:"*)
        printf '\nRun `hii` to get started.\n' >&2
        ;;
    *)
        # Saying which file to edit matters: the usual advice names a shell the
        # user may not be running.
        shell_rc="your shell profile"
        case "${SHELL:-}" in
            */zsh) shell_rc="~/.zshrc" ;;
            */bash) shell_rc="~/.bashrc" ;;
            */fish) shell_rc="~/.config/fish/config.fish" ;;
        esac
        printf '\n%s is not on your PATH. Add it to %s:\n\n    export PATH="%s:$PATH"\n\nThen run `hii`.\n' \
            "$BIN_DIR" "$shell_rc" "$BIN_DIR" >&2
        ;;
esac
