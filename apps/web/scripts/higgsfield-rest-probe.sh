#!/usr/bin/env bash
#
# Higgsfield REST catalog prober — re-runnable version of the technique used
# to produce apps/web/docs/higgsfield/REST-CATALOG.md.
#
# ── THE ORACLE TECHNIQUE ─────────────────────────────────────────────────────
# `https://api.higgsfield.ai/{vendor}/{model}/{tier}/{task?}` returns:
#   - 404 {"detail":"model_not_found"}   BEFORE any auth/body check, if the
#     path segment itself doesn't exist. This cleanly separates "wrong path"
#     from everything else.
#   - 422 (FastAPI/Pydantic-style vendors, e.g. higgsfield-ai/soul/*) or
#     400 (plain-JSON-Schema vendors, e.g. bytedance/seedance-*) if the path
#     DOES exist and request validation ran. The error body echoes back the
#     accepted type/enum/required-field name for whatever you got wrong —
#     that's the whole oracle: send something invalid on purpose, read the
#     shape of "invalid" out of the response.
# A request only reaches job creation (and billing) once it passes ALL
# validation. So a body that is guaranteed to fail validation is guaranteed
# to cost nothing, no matter which of the two response shapes above it is.
#
# ── THE SPEND RULE (see apps/web/docs/higgsfield/REST-CATALOG.md §0) ────────
# We do not know whether the configured key is funded. NEVER send a body a
# generation endpoint could treat as complete and valid — that creates a
# billable job. This script enforces that in code, not just by convention:
#
#   - `probe_path()` (existence-only) ALWAYS POSTs an empty body `{}`. Every
#     generation endpoint found in this catalog requires at least one field,
#     so `{}` is guaranteed-invalid — but note the corollary documented in
#     REST-CATALOG.md §2.3: once you start filling fields in to map a body
#     beyond existence, you must keep at least one field either OMITTED (if
#     confirmed required) or WRONG-TYPED (never just "a bogus string" for a
#     JSON-Schema-validated vendor — those often check type only, not string
#     content/format, and a plausible-looking string can pass outright).
#   - `probe_body()` takes an explicit JSON body and REFUSES to send it unless
#     the caller also passes `--invalid-field <name>` naming which key in that
#     body is the deliberately-invalid one, as a paper-trail / self-check. It
#     does not deeply verify the field is actually invalid (that would require
#     re-implementing the remote schema) — it exists so a future editor of
#     this script cannot add a probe call without at least stating, in the
#     call itself, which field is supposed to be poisoned.
#   - Neither function will ever be pointed at a body with NO deliberately
#     invalid field. If you need to explore a new endpoint, start with
#     `probe_path` (empty body) and only add fields incrementally, always
#     leaving something invalid, the same way REST-CATALOG.md §1/§2 did.
#
# ── USAGE ─────────────────────────────────────────────────────────────────
#   cd apps/web && ./scripts/higgsfield-rest-probe.sh                # catalog sweep
#   ./scripts/higgsfield-rest-probe.sh --path "vendor/model/tier"    # one path, {} body
#
# Reads the key from $HIGGSFIELD_CREDENTIALS if already exported, otherwise
# from apps/web/.env.local (HIGGSFIELD_CREDENTIALS=key_id:key_secret). The
# credential is NEVER printed, logged, or written to any file this script
# creates — it lives only in a local shell variable, interpolated straight
# into the curl invocation's Authorization header.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$WEB_DIR/.env.local"
BASE_URL="https://api.higgsfield.ai"
RESP_FILE="$(mktemp -t hf_probe_resp)"
trap 'rm -f "$RESP_FILE"' EXIT

# ── credential loading — never echoed ───────────────────────────────────────
if [ -z "${HIGGSFIELD_CREDENTIALS:-}" ]; then
	if [ ! -f "$ENV_FILE" ]; then
		echo "ERROR: HIGGSFIELD_CREDENTIALS not set and $ENV_FILE not found." >&2
		exit 1
	fi
	HIGGSFIELD_CREDENTIALS="$(grep '^HIGGSFIELD_CREDENTIALS=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)"
fi
if [ -z "${HIGGSFIELD_CREDENTIALS:-}" ]; then
	echo "ERROR: HIGGSFIELD_CREDENTIALS is empty. Set it in $ENV_FILE as key_id:key_secret." >&2
	exit 1
fi
readonly HIGGSFIELD_CREDENTIALS

# ── core request helpers ─────────────────────────────────────────────────────

# probe_path PATH
# Existence-only probe. Always sends body "{}", which is guaranteed-invalid
# against every endpoint in this catalog (every one of them requires at least
# one field). Prints "PATH<TAB>STATUS<TAB>body-snippet".
probe_path() {
	local path="$1"
	local status
	status=$(curl -sS -o "$RESP_FILE" -w '%{http_code}' \
		-X POST "${BASE_URL}/${path}" \
		-H "Authorization: Key ${HIGGSFIELD_CREDENTIALS}" \
		-H "Content-Type: application/json" \
		-d '{}')
	local body
	body=$(tr -d '\n' <"$RESP_FILE" | cut -c1-200)
	printf '%s\t%s\t%s\n' "$path" "$status" "$body"
}

# probe_body PATH JSON_BODY INVALID_FIELD_NAME
# Body-mapping probe. INVALID_FIELD_NAME is a required, non-empty statement of
# which key in JSON_BODY is the deliberately-invalid one — refuses to run
# without it. This does not verify the field is actually invalid (only the
# live API can say that); it's a forced paper trail so nobody can extend this
# script with a probe call that has no stated invalid field.
probe_body() {
	local path="$1"
	local json_body="$2"
	local invalid_field="${3:-}"
	if [ -z "$invalid_field" ]; then
		echo "ERROR: probe_body requires an INVALID_FIELD_NAME argument stating" >&2
		echo "       which field in the body is deliberately invalid. Refusing" >&2
		echo "       to send an unlabeled body — see the spend rule at the top" >&2
		echo "       of this script." >&2
		return 1
	fi
	local status
	status=$(curl -sS -o "$RESP_FILE" -w '%{http_code}' \
		-X POST "${BASE_URL}/${path}" \
		-H "Authorization: Key ${HIGGSFIELD_CREDENTIALS}" \
		-H "Content-Type: application/json" \
		-d "$json_body")
	local body
	body=$(tr -d '\n' <"$RESP_FILE" | cut -c1-300)
	printf '%s\t%s\t%s\t(invalid field: %s)\n' "$path" "$status" "$body" "$invalid_field"
}

# ── single-path mode ──────────────────────────────────────────────────────
if [ "${1:-}" = "--path" ]; then
	if [ -z "${2:-}" ]; then
		echo "Usage: $0 --path \"vendor/model/tier[/task]\"" >&2
		exit 1
	fi
	probe_path "$2"
	exit 0
fi

# ── default: re-run the catalog sweep from REST-CATALOG.md §3 ──────────────
echo "Sweeping known + candidate Higgsfield REST paths (empty-body existence probes only)."
echo "See apps/web/docs/higgsfield/REST-CATALOG.md for the full write-up of these results."
echo

CANDIDATE_PATHS=(
	# Confirmed-existing (re-check these first if the catalog might have drifted)
	"bytedance/seedance-2.5/text-to-video"
	"bytedance/seedance-2.5/image-to-video"
	"bytedance/seedance-2.5/video-edit"
	"bytedance/seedance-2.5/reference-to-video"
	"bytedance/seedance-2.0/text-to-video"
	"bytedance/seedance-2.0/image-to-video"
	"bytedance/seedance-2.0/reference-to-video"
	"kling-video/v2.5-turbo/pro/image-to-video"
	"kling-video/v2.5-turbo/pro/text-to-video"
	"kling-video/v2.5-turbo/standard/image-to-video"
	"kling-video/v2.6/pro/image-to-video"
	"kling-video/v2.6/pro/text-to-video"
	"minimax/hailuo-2.3/standard/text-to-video"
	"minimax/hailuo-2.3/pro/text-to-video"
	"minimax/hailuo-2.3/standard/image-to-video"
	"higgsfield-ai/soul/standard"
	"higgsfield-ai/soul/character"
	"higgsfield-ai/soul/reference"
	"higgsfield-ai/soul/v2/standard"
	# Confirmed-absent (kept so a re-run flags it loudly if one of these ever
	# starts resolving — that would mean the catalog changed)
	"bytedance/seedance-2.5/omni_reference"
	"bytedance/seedance-2.5/omni-reference"
	"bytedance/seedance-2.5/video-extension"
	"bytedance/seedance-1.5/text-to-video"
	"bytedance/seed-audio/standard"
	"kling-video/v3/pro/image-to-video"
	"minimax/hailuo-2/standard/text-to-video"
	"google/veo-3/standard"
	"google/veo-3.1/standard"
	"higgsfield-ai/omni-reference/standard"
	"higgsfield-ai/soul/v2/character"
	"openai/gpt-image-2.5/standard"
	"openai/gpt-image-2/standard"
	"google/nano-banana-2/standard"
	"google/nano-banana/standard"
	"google/gemini-3-pro-image/standard"
	"higgsfield/soul-cinematic/text-to-image"
	"inworld/text-to-speech/standard"
	"elevenlabs/text-to-speech/standard"
)

for path in "${CANDIDATE_PATHS[@]}"; do
	probe_path "$path"
done
