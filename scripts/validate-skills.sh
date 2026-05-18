#!/usr/bin/env bash
# validate-skills.sh — enforce structural rules for every skill in skills/.
# Exits non-zero if any skill fails a check.

set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$ROOT_DIR/skills"

if [ ! -d "$SKILLS_DIR" ]; then
  echo "FATAL: skills directory not found at $SKILLS_DIR" >&2
  exit 2
fi

GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
RESET=$'\033[0m'

# Disable color if stdout is not a terminal.
if [ ! -t 1 ]; then
  GREEN=""; YELLOW=""; RED=""; RESET=""
fi

FAIL_COUNT=0
WARN_COUNT=0
PASS_COUNT=0

# Pull the YAML frontmatter (text between the first two --- lines) into a temp file.
extract_frontmatter() {
  awk '
    /^---[[:space:]]*$/ {
      n++
      if (n == 1) { capture = 1; next }
      if (n == 2) { capture = 0; exit }
    }
    capture { print }
  ' "$1"
}

# Pull a top-level scalar (name, description) from frontmatter. Handles inline
# scalars and folded values on the following lines (>- or > or naked
# continuations indented by spaces).
get_top_scalar() {
  local field="$1"
  local file="$2"
  awk -v key="$field" '
    BEGIN { capturing = 0 }
    {
      if (capturing) {
        if ($0 ~ /^[A-Za-z_]+:/) { exit }
        line = $0
        sub(/^[[:space:]]+/, "", line)
        if (line == "") next
        printf " %s", line
        next
      }
      if (match($0, "^" key ":[[:space:]]*")) {
        rest = substr($0, RLENGTH + 1)
        if (rest == "") {
          capturing = 1
        } else {
          # strip a leading folded indicator
          sub(/^[>|]-?[[:space:]]*/, "", rest)
          printf "%s", rest
          capturing = 1
        }
      }
    }
  ' "$file"
}

# Pull the metadata.version line.
get_metadata_version() {
  awk '
    /^metadata:[[:space:]]*$/ { inblock = 1; next }
    inblock && /^[A-Za-z_]/ { inblock = 0 }
    inblock && /^[[:space:]]+version:[[:space:]]*/ {
      sub(/^[[:space:]]+version:[[:space:]]*/, "", $0)
      print $0
      exit
    }
  ' "$1"
}

# Pull the metadata.data_dependencies inline list, e.g. [a, b, c].
get_data_deps_inline() {
  awk '
    /^metadata:[[:space:]]*$/ { inblock = 1; next }
    inblock && /^[A-Za-z_]/ { inblock = 0 }
    inblock && /^[[:space:]]+data_dependencies:[[:space:]]*\[/ {
      sub(/^[[:space:]]+data_dependencies:[[:space:]]*/, "", $0)
      print $0
      exit
    }
  ' "$1"
}

report_skill() {
  local name="$1"; local status="$2"; local msg="$3"
  case "$status" in
    pass) echo "${GREEN}[PASS]${RESET} $name $msg"; PASS_COUNT=$((PASS_COUNT + 1));;
    warn) echo "${YELLOW}[WARN]${RESET} $name $msg"; WARN_COUNT=$((WARN_COUNT + 1));;
    fail) echo "${RED}[FAIL]${RESET} $name $msg"; FAIL_COUNT=$((FAIL_COUNT + 1));;
  esac
}

for skill_path in "$SKILLS_DIR"/*/; do
  skill_name="$(basename "$skill_path")"
  skill_md="$skill_path/SKILL.md"
  evals_json="$skill_path/evals/evals.json"
  problems=""
  add_problem() { problems="${problems}${problems:+; }$1"; }

  if [ ! -f "$skill_md" ]; then
    report_skill "$skill_name" fail "(missing SKILL.md)"
    continue
  fi

  # Line count check (<= 500)
  lc=$(wc -l < "$skill_md")
  if [ "$lc" -gt 500 ]; then add_problem "SKILL.md is $lc lines (max 500)"; fi

  # Frontmatter must exist
  fm="$(extract_frontmatter "$skill_md")"
  if [ -z "$fm" ]; then
    add_problem "missing YAML frontmatter"
    report_skill "$skill_name" fail "($problems)"
    continue
  fi

  fm_tmp="$(mktemp)"
  echo "$fm" > "$fm_tmp"

  # name field
  name_val="$(get_top_scalar name "$fm_tmp" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -z "$name_val" ]; then add_problem "frontmatter missing name"; fi
  if [ "$name_val" != "$skill_name" ]; then
    add_problem "name=$name_val does not match directory=$skill_name"
  fi
  if ! echo "$name_val" | grep -Eq '^[a-z0-9-]{1,64}$'; then
    add_problem "name must be 1-64 lowercase alphanumeric/hyphen chars"
  fi

  # description field
  desc_val="$(get_top_scalar description "$fm_tmp" | sed 's/^[[:space:]]*//')"
  desc_len=${#desc_val}
  if [ "$desc_len" -lt 1 ] || [ "$desc_len" -gt 1024 ]; then
    add_problem "description length $desc_len out of 1-1024 range"
  fi

  # Trigger phrase heuristic: count distinct double-quoted substrings + count of
  # the words "when" / "use" / "mention" appearing in the description.
  trigger_count=$(printf '%s' "$desc_val" | grep -oE '"[^"]+"' | wc -l)
  cue_count=$(printf '%s' "$desc_val" | grep -oEi '\b(when|use|mention)\b' | wc -l)
  total_cues=$((trigger_count + cue_count))
  if [ "$total_cues" -lt 3 ]; then
    add_problem "description has only $total_cues trigger cues (need at least 3)"
  fi

  # Scope cross-reference: matches "see X", "for X, see Y", or "use <skill>"
  # (the third form fits operator/release skills that don't have MCP backends).
  if ! printf '%s' "$desc_val" | grep -Eiq '(for [^,]+, see |\bsee \w|\buse [a-z][a-z0-9-]+\b)'; then
    add_problem "description missing scope cross-reference (e.g. 'For X, see Y' or 'use <skill>')"
  fi

  # metadata.version
  ver_val="$(get_metadata_version "$skill_md" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -z "$ver_val" ]; then add_problem "metadata.version missing"; fi

  # metadata.data_dependencies — OPTIONAL. Required only for skills that use the
  # Modern AI MCP for live data. Operator-side skills (release-gate, history scan,
  # task ledger) have no MCP backend and are allowed to omit it.
  deps_raw="$(get_data_deps_inline "$skill_md")"
  if [ -n "$deps_raw" ]; then
    # Strip [ and ] and split on comma.
    inner="$(echo "$deps_raw" | sed -e 's/^\[//' -e 's/\][[:space:]]*$//')"
    IFS=',' read -ra dep_arr <<< "$inner"
    if [ "${#dep_arr[@]}" -lt 1 ]; then
      add_problem "metadata.data_dependencies is empty"
    fi
    for dep in "${dep_arr[@]}"; do
      d="$(echo "$dep" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      if [ -z "$d" ]; then continue; fi
      if ! echo "$d" | grep -Eq '^modern\.[a-z_]+\.[a-z_]+$'; then
        add_problem "bad dependency: $d"
      fi
    done
  fi

  # evals.json — OPTIONAL. Marketing skills with frameworks benefit from evals;
  # procedural operator skills (linear runbooks) don't. Skip the check if
  # evals/evals.json is absent.
  if [ -f "$evals_json" ]; then
    # JSON parse check via python (no external deps required).
    if ! python -c "import json,sys; data=json.load(open(sys.argv[1])); assert isinstance(data.get('evals'), list) and len(data['evals'])>=5, 'need >=5 evals'; [assert_keys(e) for e in data['evals']]" --version >/dev/null 2>&1; then
      # python not available with that syntax; fall back to a direct script
      :
    fi
    py_out="$(python - "$evals_json" <<'PY' 2>&1
import json, sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception as e:
    print(f"json parse error: {e}")
    sys.exit(1)
evals = data.get("evals")
if not isinstance(evals, list):
    print("evals field missing or not a list")
    sys.exit(1)
if len(evals) < 5:
    print(f"only {len(evals)} evals (need >=5)")
    sys.exit(1)
for i, e in enumerate(evals):
    for req in ("id", "prompt", "expected_output", "assertions"):
        if req not in e:
            print(f"eval[{i}] missing field {req}")
            sys.exit(1)
    if not isinstance(e["assertions"], list) or len(e["assertions"]) == 0:
        print(f"eval[{i}] assertions must be a non-empty list")
        sys.exit(1)
print("ok")
PY
    )"
    if [ "$py_out" != "ok" ]; then
      add_problem "evals: $py_out"
    fi
  fi

  rm -f "$fm_tmp"

  if [ -z "$problems" ]; then
    report_skill "$skill_name" pass ""
  else
    report_skill "$skill_name" fail "($problems)"
  fi
done

echo ""
echo "Summary: ${GREEN}$PASS_COUNT pass${RESET}, ${YELLOW}$WARN_COUNT warn${RESET}, ${RED}$FAIL_COUNT fail${RESET}"

if [ "$FAIL_COUNT" -gt 0 ]; then exit 1; fi
exit 0
