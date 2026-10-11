"""Build a sample SoD (segregation of duties) matrix from the SAP_BR_* business roles of the demo system.

Read-only. Steps:
1. roles: AGR_DEFINE + AGR_TEXTS (SAP_BR_*)
2. what each role can start: S_TCODE values in AGR_1251 (Fiori app IDs such as F0842A, or classic tcodes)
3. app titles: TSTCT
4. map apps to SoD functions (FUNCTIONS below: title keywords + classic tcodes)
5. risks = pairs of functions one person should not hold (RISKS below)

Output (no system ID, host or client in it):
  data/sod/sod-matrix.json        rules + role -> functions, for the workflow's SoD check
  data/sod/role-function-matrix.csv  one row per role, one column per function, for people (Excel)

This is a demo rule set based on app titles, not SAP GRC's standard rule set.
Run: python scripts/build_sod_matrix.py
"""
import csv
import json
import re
from datetime import date
from itertools import combinations
from pathlib import Path

from sap_soap import load_env, read_table

OUT = Path(__file__).resolve().parent.parent / "data" / "sod"

# Function -> (description, title regex for apps that CHANGE data, classic tcodes)
FUNCTIONS = {
    "SUP_MASTER": ("Maintain supplier / business partner master data",
                   r"^(maintain|manage|create|change) (business partners?|suppliers?)( master data)?$", {"BP", "XK01", "XK02", "FK01", "FK02", "MK01", "MK02"}),
    "PO_CREATE": ("Create or change purchase orders",
                  r"^(manage|create|change) purchase orders?\b", {"ME21N", "ME22N", "ME21", "ME22"}),
    "GR_POST": ("Post goods receipts",
                r"^post goods receipt(?! for (prod|process))", {"MIGO", "MB01", "MIGO_GR"}),
    "SUP_INVOICE": ("Enter supplier invoices",
                    r"^(create|manage|post|upload) supplier invoices?\b", {"MIRO", "FB60", "MIR7"}),
    "PAY_RUN": ("Run or post outgoing payments",
                r"^(manage automatic payments|manage payment proposals|post outgoing payments|manage outgoing payments)", {"F110", "F-53", "F-58"}),
    "BANK_MASTER": ("Maintain house bank / bank accounts",
                    r"^(manage|maintain) (house )?bank accounts?$", {"FI12", "FI12_HBANK", "FI01", "FI02"}),
    "CUST_MASTER": ("Maintain customer master data",
                    r"^(maintain|manage|create|change) customers?( master data)?$", {"XD01", "XD02", "FD01", "FD02", "VD01", "VD02"}),
    "BILLING": ("Create billing documents or credit memos",
                r"^(create|manage) (billing documents?|credit memo|customer invoices?)", {"VF01", "VF02", "FB70", "FB75"}),
    "INCOMING_PAY": ("Post or clear incoming payments",
                     r"^(post|clear) incoming payments?", {"F-28", "F-26", "F-32"}),
    "GL_POST": ("Post general ledger journal entries",
                r"^(post|upload) general journal entries", {"FB50", "FB01", "F-02"}),
    "PERIOD_CTRL": ("Open and close posting periods",
                    r"^manage posting periods", {"OB52"}),
    "USER_ADMIN": ("Maintain users",
                   r"^(maintain|manage) business users", {"SU01", "SU10"}),
    "ROLE_ADMIN": ("Maintain roles and authorizations",
                   r"^(maintain|manage) business roles", {"PFCG"}),
}

# (id, function A, function B, level, risk in plain language)
RISKS = [
    ("R01", "SUP_MASTER", "PAY_RUN", "High", "Create a fake supplier and pay it"),
    ("R02", "SUP_MASTER", "SUP_INVOICE", "High", "Create a fake supplier and enter invoices for it"),
    ("R03", "PO_CREATE", "SUP_INVOICE", "High", "Order and invoice your own purchase"),
    ("R04", "PO_CREATE", "GR_POST", "Medium", "Confirm delivery of your own order"),
    ("R05", "SUP_INVOICE", "PAY_RUN", "Medium", "Enter an invoice and pay it without a second person"),
    ("R06", "BANK_MASTER", "PAY_RUN", "High", "Change bank accounts and run payments to them"),
    ("R07", "BILLING", "INCOMING_PAY", "High", "Issue a credit memo to hide missing customer payments"),
    ("R08", "CUST_MASTER", "INCOMING_PAY", "Medium", "Change a customer and manipulate its payments"),
    ("R09", "GL_POST", "PERIOD_CTRL", "Medium", "Post entries into periods you reopened yourself"),
    ("R10", "USER_ADMIN", "ROLE_ADMIN", "Critical", "Give yourself any access"),
]


def in_batches(items, size):
    items = sorted(items)
    for i in range(0, len(items), size):
        yield items[i:i + size]


def main():
    load_env()
    roles = sorted({r[0] for r in read_table("AGR_DEFINE", ["AGR_NAME"], ["AGR_NAME LIKE 'SAP_BR%'"])})
    texts = dict(read_table("AGR_TEXTS", ["AGR_NAME", "TEXT"],
                            ["AGR_NAME LIKE 'SAP_BR%' AND SPRAS = 'E'", "AND LINE = '00000'"]))
    print(f"{len(roles)} SAP_BR roles")

    starts = {}
    for agr, low in read_table("AGR_1251", ["AGR_NAME", "LOW"],
                               ["AGR_NAME LIKE 'SAP_BR%' AND OBJECT = 'S_TCODE'", "AND DELETED = ' '"]):
        if low and "*" not in low:
            starts.setdefault(agr, set()).add(low)
    codes = set().union(*starts.values()) if starts else set()
    print(f"{sum(len(v) for v in starts.values())} role/app assignments, {len(codes)} distinct apps or transactions")

    titles = {}
    for batch in in_batches(codes, 40):
        where = ["SPRSL = 'E' AND ("] + [f"TCODE = '{c}'" + (" OR" if i < len(batch) - 1 else " )")
                                         for i, c in enumerate(batch)]
        titles.update(dict(read_table("TSTCT", ["TCODE", "TTEXT"], where)))

    patterns = {f: re.compile(rx, re.I) for f, (_, rx, _) in FUNCTIONS.items()}
    app_function = {}
    for code in codes:
        title = titles.get(code, "")
        if "deprecated" in title.lower():
            continue
        hits = [f for f, (_, _, tcodes) in FUNCTIONS.items() if code in tcodes or patterns[f].search(title.strip())]
        if hits:
            app_function[code] = hits

    role_functions = {}
    for role in roles:
        funcs = {}
        for code in sorted(starts.get(role, ())):
            for f in app_function.get(code, ()):
                funcs.setdefault(f, []).append(code)
        role_functions[role] = funcs

    risk_by_pair = {frozenset((a, b)): (rid, lvl, desc) for rid, a, b, lvl, desc in RISKS}
    internal = []
    for role, funcs in role_functions.items():
        for a, b in combinations(sorted(funcs), 2):
            if frozenset((a, b)) in risk_by_pair:
                internal.append({"role": role, "risk": risk_by_pair[frozenset((a, b))][0]})

    OUT.mkdir(parents=True, exist_ok=True)
    matrix = {
        "description": "Sample SoD matrix built from SAP_BR_* business roles of a demo S/4HANA system. "
                       "Apps are mapped to functions by title keywords; demo rule set, not SAP GRC.",
        "generated": date.today().isoformat(),
        "functions": {f: {"description": d, "apps": sorted(c for c, fs in app_function.items() if f in fs)}
                      for f, (d, _, _) in FUNCTIONS.items()},
        "appTitles": {c: titles.get(c, "") for c in sorted(app_function)},
        "risks": [{"id": rid, "functions": [a, b], "level": lvl, "risk": desc} for rid, a, b, lvl, desc in RISKS],
        "roles": {r: {"text": texts.get(r, ""), "hasContent": r in starts,
                      "functions": {f: apps for f, apps in sorted(fs.items())}}
                  for r, fs in role_functions.items()},
        "rolesWithInternalConflict": internal,
    }
    (OUT / "sod-matrix.json").write_text(json.dumps(matrix, indent=1, ensure_ascii=False), encoding="utf-8")

    with open(OUT / "role-function-matrix.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["Role", "Description"] + list(FUNCTIONS) + ["Internal conflicts"])
        for role, funcs in role_functions.items():
            own = sorted({i["risk"] for i in internal if i["role"] == role})
            w.writerow([role, texts.get(role, "")] + ["X" if f in funcs else "" for f in FUNCTIONS] + [" ".join(own)])

    mapped = [r for r, fs in role_functions.items() if fs]
    print(f"{len(app_function)} apps mapped to a function; {len(mapped)} roles hold at least one function")
    for f in FUNCTIONS:
        print(f"  {f:13} apps={len(matrix['functions'][f]['apps']):3} roles={sum(1 for fs in role_functions.values() if f in fs)}")
    print(f"{len(internal)} internal conflicts in {len({i['role'] for i in internal})} roles")
    print(f"written to {OUT}")


if __name__ == "__main__":
    main()
