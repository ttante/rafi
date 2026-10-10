#!/usr/bin/env python3
"""Validate the portable planning package; does not execute Rafi runtime tests."""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def heading_slug(heading: str) -> str:
    return re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")


def validate(bundle: Path, repo: Path) -> None:
    requirements = (bundle / "rafi-harness-requirements.md").read_text()
    risks_doc = (bundle / "rafi-harness-regression-review.md").read_text()
    plan = (bundle / "rafi-harness-implementation-plan.md").read_text()
    design = (bundle / "rafi-harness-implementation-design.md").read_text()
    req_list = re.findall(r"^### ([EBHFR]\d{2}) —", requirements, re.M)
    risks_list = re.findall(r"^### (CR\d{2}) —", risks_doc, re.M)
    expected_req = {
        f"{prefix}{number:02}"
        for prefix, maximum in [("E", 18), ("B", 32), ("H", 14), ("F", 12), ("R", 8)]
        for number in range(1, maximum + 1)
    }
    require(len(req_list) == 84 and set(req_list) == expected_req,
            "Requirements must retain all 84 unique expected IDs")
    expected_risks = {f"CR{number:02}" for number in range(1, 25)}
    require(len(risks_list) == 24 and set(risks_list) == expected_risks,
            "Regression review must retain CR01–CR24 exactly once")
    matches = list(re.finditer(r"^#### (IMP-\d{2}) —", plan, re.M))
    require([m.group(1) for m in matches] == [f"IMP-{n:02}" for n in range(1, 48)],
            "Plan must retain 47 ordered unique step headings")
    steps = {}
    final_end = plan.index("## 5. Requirement-to-step traceability")
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else final_end
        block = plan[match.start():end]
        entry = {}
        for key, label, pattern in [
            ("deps", "Dependencies", r"IMP-\d{2}"),
            ("req", "Requirement coverage", r"[EBHFR]\d{2}"),
            ("risks", "Regression risks", r"CR\d{2}"),
        ]:
            field = re.search(r"\*\*" + label + r":\*\* ([^.]+)\.", block)
            require(field is not None, f"{match.group(1)} is missing {label}")
            entry[key] = re.findall(pattern, field.group(1))
        steps[match.group(1)] = entry
    visiting, visited = set(), set()

    def visit(step_id: str) -> None:
        require(step_id in steps, f"Unknown dependency {step_id}")
        require(step_id not in visiting, f"Dependency cycle at {step_id}")
        if step_id in visited:
            return
        visiting.add(step_id)
        for dependency in steps[step_id]["deps"]:
            visit(dependency)
        visiting.remove(step_id)
        visited.add(step_id)

    for step_id in steps:
        visit(step_id)
    for expected, field in [(expected_req, "req"), (expected_risks, "risks")]:
        actual = {item for step in steps.values() for item in step[field]}
        require(actual == expected, f"Step {field} coverage differs from expected IDs")
        for item in sorted(expected):
            row = re.search(r"^\| " + item + r" \| ([^|]+)\|", plan, re.M)
            require(row is not None, f"Missing traceability row {item}")
            declared = set(re.findall(r"IMP-\d{2}", row.group(1)))
            owners = {step_id for step_id, step in steps.items() if item in step[field]}
            require(declared == owners, f"Traceability drift for {item}")
    require({"IMP-11", "IMP-12", "IMP-14", "IMP-15"}.issubset(steps["IMP-19"]["deps"]),
            "Verification runner is missing audited authority/recovery prerequisites")
    for number in range(1, 25):
        require(f"| CR{number:02} /" in plan, f"Missing CR{number:02} test matrix row")
    for number in range(1, 13):
        require(f"| VT{number:02} —" in plan, f"Missing VT{number:02} verification group")
        require(f"| D{number:02} |" in design, f"Missing D{number:02} design decision")
    link_count = 0
    for document in sorted(bundle.glob("*.md")):
        text = document.read_text()
        require(text.endswith("\n"), f"Missing final newline: {document.name}")
        require(all(line == line.rstrip() for line in text.splitlines()),
                f"Trailing whitespace: {document.name}")
        require(sum(line.startswith("```") for line in text.splitlines()) % 2 == 0,
                f"Unbalanced Markdown fences: {document.name}")
        require("../rafi-ref/" not in text, f"Nonportable clone link: {document.name}")
        for link in re.findall(r"\]\(([^)]+)\)", text):
            if link.startswith(("https:", "http:")):
                continue
            path, _, anchor = link.partition("#")
            # Parent links intentionally address the receiving Rafi repository.
            if path.startswith("../"):
                target = repo / path[3:]
            else:
                target = document.parent / path if path else document
            require(target.exists(), f"Missing link in {document.name}: {link}")
            if anchor:
                headings = re.findall(r"^#{1,6} (.+)$", target.read_text(), re.M)
                require(anchor in {heading_slug(h) for h in headings},
                        f"Missing anchor in {document.name}: {link}")
            link_count += 1
    print(f"PASS: 84 requirements, 24 risks, 47 steps, acyclic dependencies, "
          f"24 risk-test rows, 12 verification groups/decisions, {link_count} local links")
    print(f"Repository link target: {repo}")
    print("Document checks only; runtime, provider, migration and native tests were not run.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, help="Rafi root for source links; defaults to folder parent")
    args = parser.parse_args()
    bundle = Path(__file__).resolve().parent
    repo = args.repo_root.resolve() if args.repo_root else bundle.parent
    try:
        validate(bundle, repo)
    except (ValueError, OSError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
