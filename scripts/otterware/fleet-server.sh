#!/usr/bin/env bash
# Switches a headless fleet machine's one Otter Code service between an Otter
# Code runtime and an Otterware runtime on the same data home. Both products
# share the server, the data home (~/.otter-code, or $T3CODE_HOME), the systemd
# user unit (otter-code.service) and the launcher, so only the runtime under
# runtime/versions/<version> changes, and the unit only ever runs one server.
#
#   fleet-server.sh status
#   fleet-server.sh install <t3-<version>-linux-x64.tar.gz | URL>
#   fleet-server.sh use-otterware  [--version <version>]
#   fleet-server.sh use-otter-code [--version <version>]
#
# install unpacks a runtime archive the way the runtime installer does
# (staging dir, `--version` check, .install-complete sentinel, atomic rename)
# and verifies it against a SHA256SUMS beside it when one exists. It never
# touches the running service.
#
# use-* switches to the newest installed runtime of that product:
# - Moving to a newer version hands the switch to the service launcher as a
#   pending update, exactly as a remote update would: the launcher snapshots
#   the database, starts the target as a trial, and commits it or restores the
#   snapshot and returns to the previous runtime.
# - The launcher only takes updates to newer versions, so moving to an older
#   one (Otterware 0.0.46-otterware.* sorts above Otter Code 0.0.46-nightly.*)
#   runs the target's own `service install --allow-downgrade`, the command
#   `otter-code update` uses, after the script snapshots the stopped database.
#   If the target does not come up serving its version, the script restores
#   the snapshot and reinstalls the previous runtime.
# Either way it refuses while a server started by hand runs on the home, while
# an update is pending, or when the unit serves another home.
#
# Needs bash, coreutils, tar, curl, flock, systemctl --user. No Node.
set -euo pipefail

SERVICE_UNIT="otter-code.service"
LAUNCHER_PROTOCOL=3
BASE_DIR="${T3CODE_HOME:-$HOME/.otter-code}"
BASE_DIR="${BASE_DIR%/}"
VERSIONS_DIR="$BASE_DIR/runtime/versions"
STATE_FILE="$BASE_DIR/runtime/service-state.json"
STATE_DIR="$BASE_DIR/userdata"
DB_PATH="$STATE_DIR/statev2.sqlite"
RUNTIME_STATE="$STATE_DIR/server-runtime.json"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE_UNIT"
BIN_DIR="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
# The launcher allows 120s for a trial to report prepared, plus its handoff.
SWITCH_TIMEOUT="${OTTERWARE_FLEET_SWITCH_TIMEOUT:-180}"

die() {
  echo "fleet-server: $*" >&2
  exit 1
}
log() { echo "fleet-server: $*"; }

# Keep the lock file in place: unlinking it would let another writer lock a new inode.
lock_mutation() {
  command -v flock >/dev/null || die "flock is required for fleet mutations"
  mkdir -p "$BASE_DIR/runtime"
  exec 9>"$BASE_DIR/runtime/fleet-server.lock"
  flock --exclusive 9 || die "could not lock fleet operations for $BASE_DIR"
}

product_of() {
  if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+-otterware\.[0-9]{8}\.[0-9]+$ ]]; then
    echo otterware
  else
    echo otter-code
  fi
}

# Reads a top-level string field, or one inside "update", from the launcher's
# pretty-printed state file. The launcher writes it with JSON.stringify(_, 2).
state_field() {
  local section="$1" key="$2"
  [[ -f "$STATE_FILE" ]] || return 0
  if [[ "$section" == top ]]; then
    sed -n "s/^  \"$key\": \"\([^\"]*\)\".*/\1/p" "$STATE_FILE" | head -n 1
  else
    sed -n "/^  \"update\": {/,/^  }/s/^    \"$key\": \"\([^\"]*\)\".*/\1/p" "$STATE_FILE" | head -n 1
  fi
}

runtime_complete() {
  local version="$1"
  [[ -x "$VERSIONS_DIR/$version/t3" ]] &&
    [[ "$(cat "$VERSIONS_DIR/$version/.install-complete" 2>/dev/null)" == "$version" ]]
}

installed_versions() {
  local dir version
  [[ -d "$VERSIONS_DIR" ]] || return 0
  for dir in "$VERSIONS_DIR"/*/; do
    version="$(basename "$dir")"
    [[ "$version" == .* ]] && continue
    if runtime_complete "$version"; then echo "$version"; fi
  done | sort -V
}

# SemVer precedence for the exact versions both products use.
version_gt() {
  local a="$1" b="$2" a_core b_core a_pre b_pre
  a_core="${a%%-*}" b_core="${b%%-*}"
  if [[ "$a_core" != "$b_core" ]]; then
    [[ "$(printf '%s\n%s\n' "$a_core" "$b_core" | sort -V | tail -n 1)" == "$a_core" ]]
    return
  fi
  a_pre="${a#"$a_core"}" b_pre="${b#"$b_core"}"
  a_pre="${a_pre#-}" b_pre="${b_pre#-}"
  [[ "$a_pre" == "$b_pre" ]] && return 1
  [[ -z "$a_pre" ]] && return 0
  [[ -z "$b_pre" ]] && return 1
  local i x y
  local -a ap bp
  IFS=. read -r -a ap <<<"$a_pre"
  IFS=. read -r -a bp <<<"$b_pre"
  for ((i = 0; i < ${#ap[@]} || i < ${#bp[@]}; i++)); do
    x="${ap[i]-}" y="${bp[i]-}"
    [[ -z "$x" ]] && return 1
    [[ -z "$y" ]] && return 0
    [[ "$x" == "$y" ]] && continue
    if [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]]; then
      ((10#$x > 10#$y))
      return
    fi
    [[ "$x" =~ ^[0-9]+$ ]] && return 1
    [[ "$y" =~ ^[0-9]+$ ]] && return 0
    [[ "$(printf '%s\n%s\n' "$x" "$y" | LC_ALL=C sort | tail -n 1)" == "$x" ]]
    return
  done
  return 1
}

unit_base_dir() {
  [[ -f "$UNIT_PATH" ]] || return 0
  sed -n 's/^Environment=T3CODE_HOME=//p' "$UNIT_PATH" | head -n 1 | sed 's/^"\(.*\)"$/\1/; s/%%/%/g'
}

unit_launcher_version() {
  [[ -f "$UNIT_PATH" ]] || return 0
  sed -n "s#^ExecStart=.*/runtime/versions/\([^/]*\)/t3 __service-launcher.*#\1#p" "$UNIT_PATH" | head -n 1
}

service_active() { systemctl --user is-active --quiet "$SERVICE_UNIT"; }

# A server started by hand (not by the launcher) on this home, or nothing.
foreground_server_pid() {
  local pid managed
  [[ -f "$RUNTIME_STATE" ]] || return 0
  pid="$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$RUNTIME_STATE" | head -n 1)"
  managed="$(sed -n 's/.*"serviceManaged": *\(true\|false\).*/\1/p' "$RUNTIME_STATE" | head -n 1)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 0
  [[ "$managed" == true ]] && return 0
  grep -q "/$SERVICE_UNIT" "/proc/$pid/cgroup" 2>/dev/null && return 0
  echo "$pid"
}

served_version() {
  local origin
  [[ -f "$RUNTIME_STATE" ]] || return 0
  origin="$(sed -n 's/.*"origin": *"\([^"]*\)".*/\1/p' "$RUNTIME_STATE" | head -n 1)"
  [[ -n "$origin" ]] || return 0
  curl -fsS --max-time 5 "$origin/.well-known/t3/environment" 2>/dev/null |
    sed -n 's/.*"serverVersion":"\([^"]*\)".*/\1/p' || true
}

cmd_status() {
  local active pending launcher unit_home fg served version
  echo "Data home:     $BASE_DIR"
  unit_home="$(unit_base_dir)"
  if [[ -f "$UNIT_PATH" ]]; then
    launcher="$(unit_launcher_version)"
    echo "Service unit:  $UNIT_PATH (home ${unit_home:-?}, launcher ${launcher:-?})"
    if service_active; then echo "Service:       active"; else echo "Service:       not active"; fi
  else
    echo "Service unit:  none at $UNIT_PATH"
  fi
  active="$(state_field top activeVersion)"
  if [[ -n "$active" ]]; then
    echo "Active:        $active ($(product_of "$active"))"
  else
    echo "Active:        unknown (no $STATE_FILE)"
  fi
  pending="$(state_field update status)"
  [[ -z "$pending" ]] ||
    echo "Last update:   $(state_field update fromVersion) -> $(state_field update targetVersion): $pending $(state_field update reason)"
  served="$(served_version)"
  [[ -z "$served" ]] || echo "Serving:       $served"
  fg="$(foreground_server_pid)"
  [[ -z "$fg" ]] || echo "Warning:       a server started by hand runs on this home (pid $fg)"
  echo "Installed runtimes:"
  while read -r version; do
    if [[ -n "$version" ]]; then printf '  %-34s %s\n' "$version" "$(product_of "$version")"; fi
  done < <(installed_versions)
}

cmd_install() {
  local source="${1:-}" work archive name version sums expected staging found
  [[ -n "$source" ]] || die "usage: install <t3-<version>-linux-x64.tar.gz | URL>"
  work="$(mktemp -d)"
  FLEET_WORK="$work"
  trap 'rm -rf "${FLEET_WORK:-}"' EXIT
  name="$(basename "${source%%\?*}")"
  if [[ "$source" =~ ^https?:// ]]; then
    log "downloading $source"
    curl -fsSL --retry 3 -o "$work/$name" "$source" || die "download failed"
    curl -fsSL -o "$work/SHA256SUMS" "$(dirname "$source")/SHA256SUMS" 2>/dev/null || rm -f "$work/SHA256SUMS"
    archive="$work/$name"
    sums="$work/SHA256SUMS"
  else
    [[ -f "$source" ]] || die "no such archive: $source"
    archive="$(cd "$(dirname "$source")" && pwd)/$name"
    sums="$(dirname "$archive")/SHA256SUMS"
  fi
  [[ "$name" =~ ^t3-(.+)-linux-(x64|arm64)\.tar\.gz$ ]] ||
    die "$name is not a Linux runtime archive (t3-<version>-linux-<arch>.tar.gz)"
  version="${BASH_REMATCH[1]}"
  case "$(uname -m)" in
    x86_64) [[ "${BASH_REMATCH[2]}" == x64 ]] || die "$name is not for this x86_64 machine" ;;
    aarch64) [[ "${BASH_REMATCH[2]}" == arm64 ]] || die "$name is not for this arm64 machine" ;;
  esac
  if [[ -f "$sums" ]]; then
    expected="$(awk -v f="$name" '{ sub(/^\*/, "", $2) } $2 == f { print tolower($1) }' "$sums")"
    [[ -n "$expected" ]] || die "$name is not listed in $sums"
    [[ "$(sha256sum "$archive" | cut -d' ' -f1)" == "$expected" ]] || die "checksum mismatch for $name"
    log "checksum verified against $sums"
  else
    log "no SHA256SUMS beside the archive; checksum not verified"
  fi
  if runtime_complete "$version"; then
    log "$version ($(product_of "$version")) is already installed"
    return 0
  fi
  mkdir -p "$VERSIONS_DIR"
  staging="$(mktemp -d "$VERSIONS_DIR/.staging-XXXXXX")"
  if ! tar -xzf "$archive" -C "$staging" --strip-components=1 ||
    ! found="$("$staging/t3" --version 9>&- 2>/dev/null)" ||
    [[ ! "$found" =~ v${version//./\\.}[[:space:]]*$ ]]; then
    rm -rf "$staging"
    die "the archive did not unpack to a working t3 $version"
  fi
  echo "$version" >"$staging/.install-complete"
  rm -rf "${VERSIONS_DIR:?}/$version"
  mv "$staging" "$VERSIONS_DIR/$version"
  log "installed $version ($(product_of "$version")) in $VERSIONS_DIR/$version"
}

wait_for_version() {
  local target="$1" deadline=$((SECONDS + SWITCH_TIMEOUT)) served=""
  while ((SECONDS < deadline)); do
    served="$(served_version)"
    [[ "$served" == "$target" ]] && return 0
    sleep 2
  done
  return 1
}

# Points `otter-code`/`t3` launcher links that already target this home's
# runtimes at the new one, as `otter-code update` does.
repoint_cli() {
  local target="$1" link resolved
  for link in "$BIN_DIR/otter-code" "$BIN_DIR/t3"; do
    [[ -L "$link" ]] || continue
    resolved="$(readlink -f "$link" || true)"
    [[ "$resolved" == "$(readlink -f "$VERSIONS_DIR")"/* ]] || continue
    ln -sfn "$VERSIONS_DIR/$target/t3" "$link.tmp.$$" && mv -Tf "$link.tmp.$$" "$link"
    log "pointed $link at $target"
  done
}

switch_forward() {
  local active="$1" target="$2" id status
  id="otterware-fleet-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  log "stopping $SERVICE_UNIT"
  systemctl --user stop "$SERVICE_UNIT"
  # The record the launcher itself writes when it accepts a remote update. On
  # start it snapshots the database, trials the target, and commits or rolls back.
  umask 077
  cat >"$STATE_FILE.tmp.$$" <<EOF
{
  "protocol": $LAUNCHER_PROTOCOL,
  "activeVersion": "$active",
  "update": {
    "id": "$id",
    "fromVersion": "$active",
    "targetVersion": "$target",
    "dbPath": "$DB_PATH",
    "status": "pending"
  }
}
EOF
  sync "$STATE_FILE.tmp.$$" 2>/dev/null || true
  mv -f "$STATE_FILE.tmp.$$" "$STATE_FILE"
  log "starting $SERVICE_UNIT; the launcher trials $target"
  systemctl --user start "$SERVICE_UNIT"
  local deadline=$((SECONDS + SWITCH_TIMEOUT))
  while ((SECONDS < deadline)); do
    status="$(state_field update status)"
    [[ "$(state_field update id)" == "$id" && "$status" != pending ]] && break
    sleep 2
  done
  status="$(state_field update status)"
  case "$status" in
    committed)
      wait_for_version "$target" || die "$target committed but is not answering yet; check the service log"
      log "now serving $target ($(product_of "$target"))"
      repoint_cli "$target"
      ;;
    rolled-back | failed)
      die "the launcher reported $status for the switch ($(state_field update reason)); the database was restored and $active is serving again"
      ;;
    *)
      die "the switch to $target is still pending after ${SWITCH_TIMEOUT}s; leave the service running and check $STATE_FILE"
      ;;
  esac
}

switch_backward() {
  local active="$1" target="$2" backup suffix
  log "stopping $SERVICE_UNIT"
  systemctl --user stop "$SERVICE_UNIT"
  backup="$BASE_DIR/runtime/db-backup/fleet-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$backup"
  for suffix in "" -wal -shm; do
    [[ -f "$DB_PATH$suffix" ]] && cp -p "$DB_PATH$suffix" "$backup/database$suffix"
  done
  sync "$backup" 2>/dev/null || true
  log "database snapshot in $backup"
  if T3CODE_HOME="$BASE_DIR" "$VERSIONS_DIR/$target/t3" service install --allow-downgrade 9>&- &&
    wait_for_version "$target"; then
    rm -rf "$backup"
    log "now serving $target ($(product_of "$target"))"
    repoint_cli "$target"
    return 0
  fi
  log "$target did not come up; restoring the database and $active"
  systemctl --user stop "$SERVICE_UNIT" || true
  for suffix in "" -wal -shm; do
    if [[ -f "$backup/database$suffix" ]]; then
      cp -p "$backup/database$suffix" "$DB_PATH$suffix"
    else
      rm -f "$DB_PATH$suffix"
    fi
  done
  T3CODE_HOME="$BASE_DIR" "$VERSIONS_DIR/$active/t3" service install --allow-downgrade 9>&- ||
    die "could not reinstall $active; the snapshot is kept in $backup"
  wait_for_version "$active" || die "$active is installed again but not answering; snapshot kept in $backup"
  rm -rf "$backup"
  die "switch to $target failed; restored $active"
}

cmd_use() {
  local product="$1" target="" active unit_home fg pending
  shift
  while (($#)); do
    case "$1" in
      --version)
        target="${2:-}"
        shift 2
        ;;
      *) die "unknown option $1" ;;
    esac
  done
  if [[ -z "$target" ]]; then
    target="$(installed_versions | while read -r v; do
      if [[ "$(product_of "$v")" == "$product" ]]; then echo "$v"; fi
    done | tail -n 1)"
    [[ -n "$target" ]] || die "no $product runtime is installed; run install first"
  fi
  [[ "$(product_of "$target")" == "$product" ]] || die "$target is not an $product runtime"
  runtime_complete "$target" || die "$target is not installed in $VERSIONS_DIR"

  [[ -f "$UNIT_PATH" ]] || die "no $SERVICE_UNIT is installed; run '$VERSIONS_DIR/$target/t3 service install' to start one"
  unit_home="$(unit_base_dir)"
  [[ "$(readlink -m "$unit_home")" == "$(readlink -m "$BASE_DIR")" ]] ||
    die "$SERVICE_UNIT serves ${unit_home:-another home}, not $BASE_DIR; refusing to touch it"
  [[ -f "$STATE_FILE" ]] || die "no launcher state at $STATE_FILE"
  pending="$(state_field update status)"
  [[ "$pending" != pending ]] || die "an update is already pending in $STATE_FILE; wait for it to finish"
  fg="$(foreground_server_pid)"
  [[ -z "$fg" ]] || die "a server started by hand runs on $BASE_DIR (pid $fg); stop it first so only one server uses the data"
  active="$(state_field top activeVersion)"
  [[ -n "$active" ]] || die "cannot read the active version from $STATE_FILE"
  runtime_complete "$active" || die "the active runtime $active is missing, so there is nothing to fall back to"
  if [[ "$active" == "$target" ]]; then
    log "$target ($product) is already active"
    return 0
  fi

  local preflight
  preflight="$("$VERSIONS_DIR/$target/t3" __service-preflight --database-path "$DB_PATH" --launcher-protocol "$LAUNCHER_PROTOCOL" 9>&-)" ||
    die "$target failed its service preflight"
  [[ "$preflight" == *'"status":"ready"'* ]] || die "$target is not ready for this service: $preflight"

  log "switching $active ($(product_of "$active")) -> $target ($product)"
  if version_gt "$target" "$active"; then
    switch_forward "$active" "$target"
  else
    switch_backward "$active" "$target"
  fi
}

case "${1:-}" in
  status) cmd_status ;;
  install)
    lock_mutation
    shift
    cmd_install "$@"
    ;;
  use-otterware)
    lock_mutation
    shift
    cmd_use otterware "$@"
    ;;
  use-otter-code)
    lock_mutation
    shift
    cmd_use otter-code "$@"
    ;;
  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
    exit 2
    ;;
esac
