from __future__ import annotations

import argparse
import json
import sys

from .core import list_jobs, load_job_bundle, run_intent


def _print_bundle(bundle: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(bundle, indent=2))
        return

    job = bundle["job"]
    intent = bundle["intent"]
    artifacts = bundle["artifacts"]
    print(f"Intent: {intent['text']}")
    print(f"Job: {job['id']} [{job['status']}]")
    print(f"Loop: intent -> job -> plan -> execute -> artifacts -> history")
    print(f"Route: {job['evaluation'].get('route', 'n/a')}")
    print(f"Schedule: {job['schedule']}")
    print("")
    for artifact in artifacts:
        print(f"{artifact['title']}")
        print(f"  score: {artifact['score']}")
        print(f"  constraints: {', '.join(artifact['constraints'])}")
        print(f"  rationale: {artifact['rationale']}")
        print(f"  artifact: {artifact['path']}")
        print("")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="hii runtime", description="Narrow HII job runtime")
    sub = parser.add_subparsers(dest="command")

    run_p = sub.add_parser("run", help="Run the core loop for one intent")
    run_p.add_argument("intent", help="Intent text to execute")
    run_p.add_argument("--options", type=int, default=None, help="Requested option count (clamped to 3-5)")
    run_p.add_argument("--json", action="store_true", help="Print JSON output")

    jobs_p = sub.add_parser("jobs", help="List recent jobs")
    jobs_p.add_argument("-n", "--limit", type=int, default=10, help="Number of jobs to show")
    jobs_p.add_argument("--json", action="store_true", help="Print JSON output")

    job_p = sub.add_parser("job", help="Show one stored job")
    job_p.add_argument("job_id", help="Job id to inspect")
    job_p.add_argument("--json", action="store_true", help="Print JSON output")

    args = parser.parse_args(argv)

    if args.command == "run":
        bundle = run_intent(args.intent, option_count=args.options)
        _print_bundle(bundle, args.json)
        return 0

    if args.command == "jobs":
        jobs = list_jobs(limit=args.limit)
        if args.json:
            print(json.dumps(jobs, indent=2))
            return 0
        for job in jobs:
            print(
                f"{job['id']}  {job['status']}  {job['kind']}  "
                f"options={job['evaluation'].get('option_count', '?')}  "
                f"top_score={job['evaluation'].get('top_score', '?')}"
            )
        return 0

    if args.command == "job":
        bundle = load_job_bundle(args.job_id)
        _print_bundle(bundle, args.json)
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
