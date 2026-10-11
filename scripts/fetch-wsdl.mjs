// Downloads the WSDL (machine-readable parameter description) of each function module
// from the SAP system and saves it to wsdl/<NAME>.wsdl. Read-only: nothing is executed in SAP.
// Run: node --env-file=.env scripts/fetch-wsdl.mjs [FM ...]
import { mkdir, writeFile } from "node:fs/promises";

const DEFAULT_FMS = [
  "BAPI_USER_GET_DETAIL", "BAPI_USER_GETLIST", "BAPI_USER_LOCK", "BAPI_USER_UNLOCK",
  "BAPI_USER_CREATE1", "BAPI_USER_CHANGE", "BAPI_USER_ACTGROUPS_ASSIGN",
  "BAPI_TRANSACTION_COMMIT", "RFC_SYSTEM_INFO", "TH_USER_LIST",
];

const { SAP_BASE_URL, SAP_CLIENT, SAP_USER, SAP_PASSWORD } = process.env;
if (!SAP_BASE_URL || !SAP_CLIENT || !SAP_USER || !SAP_PASSWORD) {
  console.error("Missing SAP_BASE_URL, SAP_CLIENT, SAP_USER or SAP_PASSWORD in .env");
  process.exit(1);
}
const auth = "Basic " + Buffer.from(`${SAP_USER}:${SAP_PASSWORD}`).toString("base64");
const fms = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FMS;

await mkdir("wsdl", { recursive: true });
for (const fm of fms) {
  const url = `${SAP_BASE_URL}/sap/bc/soap/wsdl11?services=${fm}&sap-client=${SAP_CLIENT}`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  const body = await res.text();
  if (res.ok && body.includes("definitions")) {
    await writeFile(`wsdl/${fm}.wsdl`, body);
    console.log(`OK    ${fm} (${body.length} bytes)`);
  } else {
    console.log(`FAIL  ${fm}: HTTP ${res.status} ${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 150)}`);
  }
}
