import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import jsforce from "jsforce";

let _conn = null;
async function getConn() {
  if (_conn) return _conn;
  _conn = new jsforce.Connection({ loginUrl: process.env.SF_INSTANCE_URL });
  await _conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD + (process.env.SF_SECURITY_TOKEN || ""));
  return _conn;
}

function createServer() {
  const server = new McpServer({ name: "salesforce-mcp", version: "1.0.0" });

  server.tool("query_records", "Run a custom SOQL query", { soql: z.string() }, async ({ soql }) => {
    const c = await getConn();
    const r = await c.query(soql);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });
  server.tool("get_leads", "Get Salesforce Leads", { limit: z.number().default(20), where: z.string().optional() }, async ({ limit, where }) => {
    const c = await getConn();
    let q = "SELECT Id, FirstName, LastName, Email, Phone, Company, Status, LeadSource, CreatedDate FROM Lead";
    if (where) q += ` WHERE ${where}`;
    q += ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
    const r = await c.query(q);
    return { content: [{ type: "text", text: JSON.stringify(r.records, null, 2) }] };
  });
  server.tool("get_contacts", "Get Salesforce Contacts", { limit: z.number().default(20), where: z.string().optional() }, async ({ limit, where }) => {
    const c = await getConn();
    let q = "SELECT Id, FirstName, LastName, Email, Phone, AccountId, Title, CreatedDate FROM Contact";
    if (where) q += ` WHERE ${where}`;
    q += ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
    const r = await c.query(q);
    return { content: [{ type: "text", text: JSON.stringify(r.records, null, 2) }] };
  });
  server.tool("get_accounts", "Get Salesforce Accounts", { limit: z.number().default(20), where: z.string().optional() }, async ({ limit, where }) => {
    const c = await getConn();
    let q = "SELECT Id, Name, Phone, Website, Industry, Type, CreatedDate FROM Account";
    if (where) q += ` WHERE ${where}`;
    q += ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
    const r = await c.query(q);
    return { content: [{ type: "text", text: JSON.stringify(r.records, null, 2) }] };
  });
  server.tool("get_opportunities", "Get Salesforce Opportunities", { limit: z.number().default(20), where: z.string().optional() }, async ({ limit, where }) => {
    const c = await getConn();
    let q = "SELECT Id, Name, AccountId, StageName, Amount, CloseDate, Probability, OwnerId, CreatedDate FROM Opportunity";
    if (where) q += ` WHERE ${where}`;
    q += ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
    const r = await c.query(q);
    return { content: [{ type: "text", text: JSON.stringify(r.records, null, 2) }] };
  });
  server.tool("get_record", "Get a record by ID", { object_type: z.enum(["Lead","Contact","Account","Opportunity"]), record_id: z.string() }, async ({ object_type, record_id }) => {
    const c = await getConn();
    const r = await c.sobject(object_type).retrieve(record_id);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });
  server.tool("create_record", "Create a Lead, Contact, Account, or Opportunity", { object_type: z.enum(["Lead","Contact","Account","Opportunity"]), fields: z.record(z.any()) }, async ({ object_type, fields }) => {
    const c = await getConn();
    const r = await c.sobject(object_type).create(fields);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });
  server.tool("update_record", "Update a Lead, Contact, Account, or Opportunity", { object_type: z.enum(["Lead","Contact","Account","Opportunity"]), record_id: z.string(), fields: z.record(z.any()) }, async ({ object_type, record_id, fields }) => {
    const c = await getConn();
    const r = await c.sobject(object_type).update({ Id: record_id, ...fields });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });
  server.tool("delete_record", "Delete a Lead, Contact, Account, or Opportunity", { object_type: z.enum(["Lead","Contact","Account","Opportunity"]), record_id: z.string() }, async ({ object_type, record_id }) => {
    const c = await getConn();
    const r = await c.sobject(object_type).destroy(record_id);
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
