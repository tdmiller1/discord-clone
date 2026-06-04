#!/usr/bin/env python3
"""Group a feature's stories into dependency waves.

Reads frontmatter from every story-NNN-* dir under $FEATURE_DIR, builds a
dependency graph from the depends_on field, and topologically assigns each
story to a wave (story with no deps -> wave 0; story whose deepest dep is in
wave N -> wave N+1).

Emits to stdout a JSON object {"wave0": [...], "wave1": [...], ..., "wave5": [...]}
where each value is a JSON array of story directory paths (strings).

Fails (exit 1) if:
  - the dependency graph has a cycle
  - any depends_on references a non-existent story
  - any depended-on story has no provides_contract (downstream cannot consume nothing)
  - the resulting depth exceeds 6 waves (signals a serial-dependency design smell)
"""
import json
import os
import pathlib
import re
import sys

import yaml

MAX_WAVES = 6


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


def main() -> None:
    feature_dir = pathlib.Path(os.environ["FEATURE_DIR"])
    if not feature_dir.is_dir():
        print(f"ERROR: feature dir {feature_dir} does not exist", file=sys.stderr)
        sys.exit(1)

    story_dirs = sorted(d for d in feature_dir.iterdir() if d.is_dir() and not d.name.startswith("_") and d.name.startswith("story-"))

    # num (zero-padded 3-digit string) -> {dir, depends_on, provides}
    stories: dict[str, dict] = {}
    for d in story_dirs:
        m = re.match(r"^story-(\d+)-", d.name)
        if not m:
            continue
        num = m.group(1).zfill(3)
        story_files = sorted(d.glob("story-*_story.md"))
        fm = parse_frontmatter(story_files[0]) if story_files else {}
        depends_on = [str(x).zfill(3) for x in (fm.get("depends_on") or [])]
        provides = (fm.get("provides_contract") or "").strip()
        stories[num] = {"dir": str(d), "depends_on": depends_on, "provides": provides}

    # Validate refs and that depended-on stories provide a contract.
    for num, info in stories.items():
        for dep in info["depends_on"]:
            if dep not in stories:
                print(f"ERROR: story {num} depends on {dep} but no such story exists", file=sys.stderr)
                sys.exit(1)
            if not stories[dep]["provides"]:
                print(
                    f"ERROR: story {num} depends on {dep} but story {dep} has no provides_contract",
                    file=sys.stderr,
                )
                sys.exit(1)

    # Topo-sort into waves. wave[num] = int wave index.
    wave: dict[str, int] = {}
    while len(wave) < len(stories):
        progressed = False
        for num, info in stories.items():
            if num in wave:
                continue
            deps = info["depends_on"]
            if all(d in wave for d in deps):
                wave[num] = (max((wave[d] for d in deps), default=-1)) + 1
                progressed = True
        if not progressed:
            unresolved = [n for n in stories if n not in wave]
            print(f"ERROR: dependency cycle among stories {unresolved}", file=sys.stderr)
            sys.exit(1)

    max_wave = max(wave.values()) if wave else -1
    if max_wave + 1 > MAX_WAVES:
        print(
            f"ERROR: feature has {max_wave + 1} dependency layers but workflow caps at {MAX_WAVES}. "
            "Consider flattening dependencies or splitting the feature.",
            file=sys.stderr,
        )
        sys.exit(1)

    out: dict[str, list[str]] = {f"wave{i}": [] for i in range(MAX_WAVES)}
    for num, info in stories.items():
        out[f"wave{wave[num]}"].append(info["dir"])
    for k in out:
        out[k].sort()

    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
