#!/usr/bin/env python3
"""Resolve a single story's frontmatter into the metadata the runner needs.

Reads the story file at $STORY/<name>_story.md, parses its YAML frontmatter,
and emits JSON with:
  - upstream_block: a markdown block of upstream contract paths (or "(none)")
                    suitable for substituting into $UPSTREAM_CONTRACTS in the
                    research prompt
  - provides:       the relative path under the story dir of this story's
                    contract artifact (empty string if none)

Stories without frontmatter or without a depends_on field are treated as
having no upstream dependencies (legacy compat).

Fails (exit 1) if any depends_on entry references a story that doesn't exist
or that has no provides_contract.
"""
import json
import os
import pathlib
import re
import sys

import yaml


def parse_frontmatter(path: pathlib.Path) -> dict:
    if not path.exists():
        return {}
    text = path.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return {}
    raw = m.group(1)
    raw = re.sub(r'(?<![\w"\'])(0\d+)(?![\w"\'])', r'"\1"', raw)
    return yaml.safe_load(raw) or {}


def find_sibling(feature_dir: pathlib.Path, num: str) -> pathlib.Path:
    matches = sorted(feature_dir.glob(f"story-{num}-*"))
    if not matches:
        print(f"ERROR: depends_on references story {num} but no story-{num}-* directory exists in {feature_dir}", file=sys.stderr)
        sys.exit(1)
    return matches[0]


def main() -> None:
    story_dir = pathlib.Path(os.environ["STORY"])
    feature_dir = pathlib.Path(os.environ["FEATURE_DIR"])
    name = story_dir.name
    story_files = sorted(story_dir.glob("story-*_story.md"))
    story_file = story_files[0] if story_files else story_dir / f"{name}_story.md"

    fm = parse_frontmatter(story_file)
    depends_on = [str(d).zfill(3) for d in (fm.get("depends_on") or [])]
    provides = (fm.get("provides_contract") or "").strip()

    upstream_paths: list[str] = []
    for dep in depends_on:
        sib = find_sibling(feature_dir, dep)
        sib_story_files = sorted(sib.glob("story-*_story.md"))
        sib_story_file = sib_story_files[0] if sib_story_files else sib / f"{sib.name}_story.md"
        sib_fm = parse_frontmatter(sib_story_file)
        sib_provides = (sib_fm.get("provides_contract") or "").strip()
        if not sib_provides:
            print(
                f"ERROR: {name} depends on story {dep} ({sib.name}) but that story has no provides_contract",
                file=sys.stderr,
            )
            sys.exit(1)
        upstream_paths.append(str(sib / sib_provides))

    if upstream_paths:
        upstream_block = "\n".join(f"- `{p}`" for p in upstream_paths)
    else:
        upstream_block = "(none)"

    json.dump({"upstream_block": upstream_block, "provides": provides}, sys.stdout)


if __name__ == "__main__":
    main()
