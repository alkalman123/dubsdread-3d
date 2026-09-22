#!/usr/bin/env python3
"""One-time interactive Garmin Connect login.

Run this ONCE, from your own PC (a residential IP) -- NOT from Render or
any other cloud/datacenter host. Garmin's SSO login endpoint sits behind
Cloudflare bot protection that blocks datacenter IPs outright, which is the
whole reason this project exists as a backend-mediates-to-mobile-app split
rather than doing live logins server-side: the *initial* interactive login
has to happen somewhere Cloudflare will actually let through, but every
sync after that reuses the resulting OAuth tokens (with the library's own
proactive refresh) and never needs to re-hit that endpoint at all, so the
server can run the day-to-day syncing safely.

Usage:
    python cli_login.py

You'll be prompted for your Garmin Connect email/password, and for an MFA
code if your account has two-factor enabled. On success this writes the
token files to GARMIN_TOKENSTORE_PATH (./.data/garmin_tokens by default)
and also prints the token data as a single JSON string -- copy that into
the GARMIN_TOKENSTORE_JSON environment variable on Render, since Render's
free-tier disk is wiped on redeploy and the token *file* alone won't
survive that.
"""

from __future__ import annotations

import getpass
import sys

from garminconnect import Garmin, GarminConnectAuthenticationError, GarminConnectConnectionError

from app import config


def main() -> int:
    email = input("Garmin Connect email: ").strip()
    password = getpass.getpass("Garmin Connect password: ")

    # return_on_mfa=True: if the account has two-factor enabled, login()
    # returns ("needs_mfa", None) instead of blocking on its own prompt, so
    # we can drive the MFA code entry ourselves and call resume_login().
    client = Garmin(email, password, return_on_mfa=True)

    try:
        mfa_status, client_state = client.login()
    except GarminConnectConnectionError as err:
        print(f"Connection error reaching Garmin: {err}", file=sys.stderr)
        print(
            "If this mentions Cloudflare or a 403, you're likely running this "
            "from a cloud/datacenter IP -- run it from your own PC instead.",
            file=sys.stderr,
        )
        del password
        return 1
    except GarminConnectAuthenticationError as err:
        print(f"Authentication failed: {err}", file=sys.stderr)
        del password
        return 1

    del password

    if mfa_status == "needs_mfa":
        mfa_code = input("Enter the MFA code Garmin just sent you: ").strip()
        try:
            client.resume_login(client_state, mfa_code)
        except GarminConnectAuthenticationError as err:
            print(f"MFA verification failed: {err}", file=sys.stderr)
            return 1

    client.client.dump(config.TOKENSTORE_PATH)
    print(f"\nLogin succeeded. Tokens written to: {config.TOKENSTORE_PATH}")

    tokenstore_json = client.client.dumps()
    print("\nFor Render (or any host with ephemeral disk), copy the line below")
    print("into the GARMIN_TOKENSTORE_JSON environment variable so a redeploy")
    print("doesn't force you to re-run this interactive login:\n")
    print(tokenstore_json)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
