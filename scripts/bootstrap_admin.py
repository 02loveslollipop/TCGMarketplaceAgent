"""Run locally after provisioning; password never appears in arguments or logs."""
from getpass import getpass
import argparse
import json
import psycopg
import secrets
from pathlib import Path
from dotenv import dotenv_values
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from shared.repository import Repository
from services.auth.security import hash_password
from scripts.provision import private_write


def main():
    parser=argparse.ArgumentParser(description="Privately bootstrap the first administrator.")
    parser.add_argument("--generate",action="store_true",help="Generate an initial private PoC account and write credentials to .runtime/bootstrap-admin.json.")
    args=parser.parse_args()
    settings = dotenv_values(".runtime/auth.env")
    engine = create_engine("postgresql+psycopg://", creator=lambda:psycopg.connect(settings["DATABASE_DSN"],connect_timeout=10), hide_parameters=True)
    repo = Repository(sessionmaker(engine, expire_on_commit=False))
    if any(user.role == "admin" for user in repo.users()):
        raise SystemExit("An administrator already exists. Create accounts through the authenticated admin portal.")
    username = f"poc-admin-{secrets.token_hex(3)}" if args.generate else input("First administrator username: ").strip()
    if not username or len(username) > 160:
        raise SystemExit("Username must contain 1 to 160 characters.")
    password = secrets.token_urlsafe(36) if args.generate else getpass("Password (12+ characters): ")
    if not args.generate and password != getpass("Confirm password: "):
        raise SystemExit("Passwords do not match.")
    repo.add_user(username, hash_password(password), "admin")
    if args.generate:
        path=Path(".runtime/bootstrap-admin.json")
        private_write(path,json.dumps({"username":username,"password":password})+"\n")
        print(f"First administrator created: {username}. Private credentials: {path} (mode 0600).")
    else:
        print("First administrator created. Sign in at http://localhost:8080/admin/.")


if __name__ == "__main__":
    main()
