"""Write cached answers for the PRD demo questions by running their tool plans directly (no LLM).

Run: python -m pipeline.seed_cache data/synthetic
"""

import argparse
from pathlib import Path

from server.agent import Agent
from server.tools import load_dataset


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("data", type=Path)
    agent = Agent(load_dataset(ap.parse_args().data))
    written = agent.seed_demo()
    print(f"seeded {len(written)} of the demo questions into {agent.path}")
    for q in written:
        entry = agent.cache[q]
        print(f"  {q}: {entry.get('summary') or entry['error']}")


if __name__ == "__main__":
    main()
