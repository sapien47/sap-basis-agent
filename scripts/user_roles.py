"""Roles of one user read straight from table AGR_USERS (RFC_READ_TABLE), as JSON on stdout.

Independent of the MCP server, which reads roles with BAPI_USER_GET_DETAIL: used by
scripts/assign-keep-test.js as a second opinion. Read-only.
Usage: python scripts/user_roles.py DEMO_03
"""
import json
import sys

from sap_soap import load_env, read_table


def iso(d):
    return f"{d[:4]}-{d[4:6]}-{d[6:]}" if len(d) == 8 else d


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        sys.exit("Usage: python scripts/user_roles.py <USERNAME>")
    user = sys.argv[1].strip().upper()[:12]
    if "'" in user:
        sys.exit("Invalid user name")
    load_env()
    rows = read_table("AGR_USERS", ["AGR_NAME", "FROM_DAT", "TO_DAT"], [f"UNAME = '{user}'"])
    roles = sorted(({"role": r[0], "validFrom": iso(r[1]), "validTo": iso(r[2])} for r in rows), key=lambda r: r["role"])
    print(json.dumps({"username": user, "roles": roles}))
