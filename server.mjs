import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

// --- SALESFORCE AUTO-REFRESHING AUTH ---
const SF_API_VERSION = "v59.0";
let accessToken = null;
let instanceUrl = null;

async function refreshAccessToken() {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.SALESFORCE_CLIENT_ID,
    client_secret: process.env.SALESFORCE_CLIENT_SECRET,
    refresh_token: process.env.SALESFORCE_REFRESH_TOKEN,
  });

  const res = await fetch("https://login.salesforce.com/services/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  instanceUrl = data.instance_url;
  return { accessToken, instanceUrl };
}

async function sfRequest(path, options = {}) {
  if (!accessToken || !instanceUrl) {
    await refreshAccessToken();
  }

  const url = `${instanceUrl}${path}`;
  let res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 401 || res.status === 403) {
    await refreshAccessToken();
    res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Salesforce API error (${res.status}): ${errBody}`);
  }

  return res.json();
}

async function sfQuery(soql) {
  const encoded = encodeURIComponent(soql);
  return sfRequest(`/services/data/${SF_API_VERSION}/query?q=${encoded}`);
}

async function sfGetRecord(objectType, recordId) {
  return sfRequest(`/services/data/${SF_API_VERSION}/sobjects/${objectType}/${recordId}`);
}

async function sfCreateRecord(objectType, fields) {
  return sfRequest(`/services/data/${SF_API_VERSION}/sobjects/${objectType}`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
}

async function sfUpdateRecord(objectType, recordId, fields) {
  const url = `/services/data/${SF_API_VERSION}/sobjects/${objectType}/${recordId}`;
  if (!accessToken || !instanceUrl) await refreshAccessToken();

  let res = await fetch(`${instanceUrl}${url}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });

  if (res.status === 401 || res.status === 403) {
    await refreshAccessToken();
    res = await fetch(`${instanceUrl}${url}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
  }

  if (res.status === 204) return { id: recordId, success: true };
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Salesforce API error (${res.status}): ${errBody}`);
  }
  return res.json();
}

async function sfDeleteRecord(objectType, recordId) {
  const url = `/services/data/${SF_API_VERSION}/sobjects/${objectType}/${recordId}`;
  if (!accessToken || !instanceUrl) await refreshAccessToken();

  let res = await fetch(`${instanceUrl}${url}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401 || res.status === 403) {
    await refreshAccessToken();
    res = await fetch(`${instanceUrl}${url}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  if (res.status === 204) return { id: recordId, success: true };
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Salesforce API error (${res.status}): ${errBody}`);
  }
  return res.json();
}

// --- MCP SERVER ---
function createServer() {
  const server = new McpServer({ name: "salesforce-mcp", version: "1.0.0" });

  server.tool("query_records", "Run a custom SOQL query", { soql: z.string() }, async ({ soql }) => {
    const r = await sfQuery(soql);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });
  server.tool("get_leads", "Get Salesforce Leads", { limit: z.number().default(20), where: z.string().optional() }, async ({ limit, where }) => {
    let q = "SELECT Id, FirstName, LastName, Email, Phone, Company, Status, LeadSource, CreatedDate FROM Lead";
    if (where) q += ` WHERE ${where}`;
    q += ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
    const r = await sfQuery(q);
    return { content: [{ type: "text", text: JSON.stringify(r.records, null, 2) }] };
  });
  server.tool("get_contacts", "Get Salesforce Contacts", { limit: z.number().default(20), where: z.string().optional() }, async ({ limit, where }) => {
    let q = "SELECT Id, FirstName, LastName, Email, Phone, AccountId, Title, CreatedDate FROM Contact";
    if (where) q += ` WHERE ${where}`;
    q += ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
    const r = await sfQuery(q);
    return { content: [{ type: "text", text: JSON.stringify(r.records, null, 2) }] };
  });
  server.tool("get_accounts", "Get Salesforce Accounts", { limit: z.number().default(20), where: z.string().optional() }, async ({ limit, where }) => {
    let q = "SELECT Id, Name, Phone, Website, Industry, Type, CreatedDate FROM Account";
    if (where) q += ` WHERE ${where}`;
    q += ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
    const r = await sfQuery(q);
    return { content: [{ type: "text", text: JSON.stringify(r.records, null, 2) }] };
  });
  server.tool("get_opportunities", "Get Salesforce Opportunities", { limit: z.number().default(20), where: z.string().optional() }, async ({ limit, where }) => {
    let q = "SELECT Id, Name, AccountId, StageName, Amount, CloseDate, Probability, OwnerId, CreatedDate FROM Opportunity";
    if (where) q += ` WHERE ${where}`;
    q += ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
    const r = await sfQuery(q);
    return { content: [{ type: "text", text: JSON.stringify(r.records, null, 2) }] };
  });
  server.tool("get_record", "Get a record by ID", { object_type: z.enum(["Lead","Contact","Account","Opportunity"]), record_id: z.string() }, async ({ object_type, record_id }) => {
    const r = await sfGetRecord(object_type, record_id);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });
  server.tool("create_record", "Create a Lead, Contact, Account, or Opportunity", { object_type: z.enum(["Lead","Contact","Account","Opportunity"]), fields: z.record(z.any()) }, async ({ object_type, fields }) => {
    const r = await sfCreateRecord(object_type, fields);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });
  server.tool("update_record", "Update a Lead, Contact, Account, or Opportunity", { object_type: z.enum(["Lead","Contact","Account","Opportunity"]), record_id: z.string(), fields: z.record(z.any()) }, async ({ object_type, record_id, fields }) => {
    const r = await sfUpdateRecord(object_type, record_id, fields);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });
  server.tool("delete_record", "Delete a Lead, Contact, Account, or Opportunity", { object_type: z.enum(["Lead","Contact","Account","Opportunity"]), record_id: z.string() }, async ({ object_type, record_id }) => {
    const r = await sfDeleteRecord(object_type, record_id);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

const transports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  transports[sessionId] = transport;
  transport.onclose = () => { delete transports[sessionId]; };
  const server = createServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || !transports[sessionId]) {
    res.status(404).send("Session not found");
    return;
  }
  await transports[sessionId].handlePostMessage(req, res, req.body);
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Salesforce MCP server running on port ${PORT}`);
});
