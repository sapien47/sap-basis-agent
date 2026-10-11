// Minimal client for SAP's SOAP-over-HTTP RFC service (/sap/bc/soap/rfc).
// Connection settings come from environment variables (see .env.example), read at call time.

export async function callRfc(fm, innerXml = "") {
  const { SAP_BASE_URL, SAP_CLIENT, SAP_USER, SAP_PASSWORD } = process.env;
  if (!SAP_BASE_URL || !SAP_CLIENT || !SAP_USER || !SAP_PASSWORD) {
    throw new Error("Missing SAP_BASE_URL, SAP_CLIENT, SAP_USER or SAP_PASSWORD");
  }
  const envelope =
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:urn="urn:sap-com:document:sap:rfc:functions"><soapenv:Body>` +
    `<urn:${fm}>${innerXml}</urn:${fm}></soapenv:Body></soapenv:Envelope>`;
  const res = await fetch(`${SAP_BASE_URL}/sap/bc/soap/rfc?sap-client=${SAP_CLIENT}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${SAP_USER}:${SAP_PASSWORD}`).toString("base64"),
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `urn:sap-com:document:sap:rfc:functions:${fm}`,
    },
    body: envelope,
  });
  return { status: res.status, body: await res.text() };
}

// All text values of <name>...</name> in a response.
export const tag = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((m) => m[1]);

// The BAPIRET2 messages of a response: [{ type, message }].
export function messages(xml) {
  const types = tag(xml, "TYPE");
  return tag(xml, "MESSAGE").map((message, i) => ({ type: types[i], message }));
}

const unesc = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Flat fields of an XML fragment as an object: { FIELD: "value" }.
function fields(fragment) {
  const out = {};
  for (const m of fragment.matchAll(/<([A-Z0-9_]+)>([^<]*)<\/\1>/g)) out[m[1]] = unesc(m[2]);
  return out;
}

// One exported structure, e.g. struct(xml, "ISLOCKED") -> { WRNG_LOGON: "U", ... } (or null).
export function struct(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? fields(m[1]) : null;
}

// Rows of a table parameter, e.g. table(xml, "USERLIST") -> [{ USERNAME: ... }, ...].
export function table(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return [];
  return [...m[1].matchAll(/<item>([\s\S]*?)<\/item>/g)].map((it) => fields(it[1]));
}

export const plain =(xml) => xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
