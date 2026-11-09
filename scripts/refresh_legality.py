"""CLI command to refresh Pokémon TCG card sets, regulation marks, and banned cards."""
from pathlib import Path
from dotenv import dotenv_values
import os
import sys

from services.orchestrator.legality_sync import sync_legality
from shared.runtime import repository


def main():
    # If not set in environment, load orchestrator credentials from .runtime/orchestrator.env
    if not os.getenv("DATABASE_DSN") and not os.getenv("DATABASE_URL"):
        env_file = Path(".runtime/orchestrator.env")
        if env_file.exists():
            values = dotenv_values(env_file)
            for k, v in values.items():
                if v is not None:
                    os.environ[k] = v

    repo = repository()
    print("Starting legality catalog refresh (International & Japan Standard + Expanded)...")
    status = sync_legality(repo, triggered_by="cli")
    print(f"Legality catalog refreshed successfully:")
    print(f"  Status: {status.get('status')}")
    print(f"  Sets count: {status.get('sets_count')}")
    print(f"  Banned cards count: {status.get('banned_count')}")
    print(f"  Standard regulation marks: International={status.get('international_standard_marks')}, Japan={status.get('japan_standard_marks')}")
    print(f"  Last refreshed at: {status.get('last_refreshed_at')}")
    print(f"  Next refresh at: {status.get('next_refresh_at')}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Legality refresh failed: {error}", file=sys.stderr)
        sys.exit(1)
