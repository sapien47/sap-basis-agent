"""Minimal Python client for SAP's SOAP-over-HTTP RFC service (/sap/bc/soap/rfc), read-only use.

Same connection as src/sap-soap.mjs: settings come from the git-ignored .env (SAP_BASE_URL, SAP_CLIENT,
SAP_USER, SAP_PASSWORD). Standard library only; PyRFC would need the SAP NW RFC SDK.
"""
import base64
import os
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape


def load_env(path=Path(__file__).resolve().parent.parent / ".env"):
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def call_rfc(fm, inner_xml=""):
    env = os.environ
    for key in ("SAP_BASE_URL", "SAP_CLIENT", "SAP_USER", "SAP_PASSWORD"):
        if not env.get(key):
            raise RuntimeError("Missing SAP_BASE_URL, SAP_CLIENT, SAP_USER or SAP_PASSWORD")
    envelope = (
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" '
        'xmlns:urn="urn:sap-com:document:sap:rfc:functions"><soapenv:Body>'
        f"<urn:{fm}>{inner_xml}</urn:{fm}></soapenv:Body></soapenv:Envelope>"
    )
    auth = base64.b64encode(f"{env['SAP_USER']}:{env['SAP_PASSWORD']}".encode()).decode()
    req = urllib.request.Request(
        f"{env['SAP_BASE_URL']}/sap/bc/soap/rfc?sap-client={env['SAP_CLIENT']}",
        data=envelope.encode("utf-8"),
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": f"urn:sap-com:document:sap:rfc:functions:{fm}",
        },
    )
    with urllib.request.urlopen(req, timeout=300) as res:
        return res.read()


def read_table(table, fields, where=(), page=20000):
    """All rows of a table via RFC_READ_TABLE, as lists of stripped strings. `where` lines max 72 chars."""
    opts = "".join(f"<item><TEXT>{escape(w)}</TEXT></item>" for w in where)
    flds = "".join(f"<item><FIELDNAME>{f}</FIELDNAME></item>" for f in fields)
    rows, skip = [], 0
    while True:
        body = call_rfc(
            "RFC_READ_TABLE",
            f"<QUERY_TABLE>{table}</QUERY_TABLE><DELIMITER>|</DELIMITER><ROWCOUNT>{page}</ROWCOUNT>"
            f"<ROWSKIPS>{skip}</ROWSKIPS><OPTIONS>{opts}</OPTIONS><FIELDS>{flds}</FIELDS><DATA></DATA>",
        )
        data = next(e for e in ET.fromstring(body).iter() if e.tag.split("}")[-1] == "DATA")
        batch = [[v.strip() for v in (wa.text or "").split("|")] for wa in data.iter("WA")]
        rows += batch
        if len(batch) < page:
            return rows
        skip += page
