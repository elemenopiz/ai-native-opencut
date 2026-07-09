#!/usr/bin/env python3
"""PreToolUse guard: block edits that would introduce license-incompatible
Python dependencies into the image service.

Byorn ships under MIT. PhotoMaker v1 (pure-CLIP / OpenCLIP ViT-H-14, Apache-2.0)
is the ONLY allowed persona tier. insightface / antelopev2 / buffalo_* /
inswapper / PhotoMaker v2 / FLUX all carry non-commercial weights that would
poison the MIT distribution. See the guardrail comment in
services/image-service/app.py and requirements.txt.

This turns that comment into an enforced block. Reads the tool call JSON on
stdin; exit 2 rejects the edit and shows the message to Claude.
"""
import json
import re
import sys

# Only guard files in the image service / its requirement manifests.
WATCHED_SUBSTRINGS = ("services/image-service/",)
WATCHED_SUFFIXES = ("requirements.txt", "requirements.lock")

# (human label, regex) — any match rejects the edit.
FORBIDDEN = [
    ("insightface", re.compile(r"insightface", re.I)),
    ("antelopev2", re.compile(r"antelopev2", re.I)),
    ("buffalo_* face models", re.compile(r"buffalo_[a-z]", re.I)),
    ("inswapper", re.compile(r"inswapper", re.I)),
    ("PhotoMaker v2 (non-commercial)", re.compile(r"photomaker[\s._-]*v?2\b", re.I)),
    (
        "FLUX / black-forest-labs (non-commercial weights)",
        re.compile(r"black[-_]forest[-_]labs|flux[\s._-]?(1|dev|schnell)|FluxPipeline", re.I),
    ),
]


def collect_text(tool_input):
    """Pull every candidate 'new content' string out of an Edit/Write/MultiEdit input."""
    parts = []
    for key in ("content", "new_string", "new_str"):
        val = tool_input.get(key)
        if isinstance(val, str):
            parts.append(val)
    for edit in tool_input.get("edits", []) or []:
        if isinstance(edit, dict):
            for key in ("new_string", "new_str", "content"):
                val = edit.get(key)
                if isinstance(val, str):
                    parts.append(val)
    return "\n".join(parts)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unparseable input -> never block

    tool_input = data.get("tool_input") or {}
    path = tool_input.get("file_path") or tool_input.get("path") or ""

    watched = any(s in path for s in WATCHED_SUBSTRINGS) or path.endswith(WATCHED_SUFFIXES)
    if not watched:
        sys.exit(0)

    text = collect_text(tool_input)
    if not text:
        sys.exit(0)

    hits = [label for label, rx in FORBIDDEN if rx.search(text)]
    if hits:
        sys.stderr.write(
            "BLOCKED — this edit to {path} would add license-incompatible dependencies: {hits}.\n"
            "These carry non-commercial weights that would poison Byorn's MIT distribution.\n"
            "PhotoMaker v1 (pure-CLIP, Apache-2.0) is the only allowed persona tier.\n"
            "See the license guardrail in services/image-service/app.py.\n"
            "If this is genuinely intended, a human must make the change by hand.\n".format(
                path=path, hits=", ".join(hits)
            )
        )
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
