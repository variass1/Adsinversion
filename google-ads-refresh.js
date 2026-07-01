#!/usr/bin/env node
// google-ads-refresh.js — Obtiene datos de Google Ads via API v19
// Uso:
//   node google-ads-refresh.js                              → últimos 7 días
//   node google-ads-refresh.js --from=2026-06-01 --to=2026-06-18

require("dotenv").config();
const https = require("https");
const fs = require("fs");
const path = require("path");

const DEVELOPER_TOKEN   = (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim();
const MANAGER_ID        = (process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID || "").replace(/-/g, "").trim();
const CLIENT_ID_CID     = (process.env.GOOGLE_ADS_CLIENT_CUSTOMER_ID  || "").replace(/-/g, "").trim();
const OAUTH_CLIENT_ID   = (process.env.GOOGLE_ADS_CLIENT_ID || "").trim();
const OAUTH_SECRET      = (process.env.GOOGLE_ADS_CLIENT_SECRET || "").trim();
const REFRESH_TOKEN     = (process.env.GOOGLE_ADS_REFRESH_TOKEN || "").trim();

const DATA_PATH              = path.join(__dirname, "data.json");
const CAMPAIGNS_PATH         = path.join(__dirname, "campaigns-data.json");
const GADS_PATH              = path.join(__dirname, "gads-data.json");
const GOOGLE_ADGROUPS_PATH   = path.join(__dirname, "google-adgroups-data.json");

// Destinos conocidos (misma lista que meta-refresh.js)
const DESTINOS = ["las-arenas","isla-cristina","trafalgar","costa-brava","canos","los-canos","somo-playa","somo","tarifa","ria-de-vigo","roquetas","llanes","tossa-de-mar","cambrils","paloma","kikopark-playa","kikopark","cova-negra","alquezar","bayona-playa","bayona","benicassim","blanes","navajas","lago-de-arcos","sierra-nevada","picos-urbion","picos","el-palmar","palmar"];

function extractDestinationFromAdGroup(name) {
  // Patrón: Search_[Tipo]_DESTINO (e.g. Search_No-Marca_las-arenas, Search_Marca_tarifa)
  const lower = name.toLowerCase().trim();
  const match = lower.match(/^search_[^_]+_([\w\-]+(?:_[\w\-]+)*)$/);
  if (match) {
    const dest = match[1].replace(/_/g, "-");
    // Buscar en destinos conocidos
    for (const d of DESTINOS) {
      if (dest === d) return d;
    }
    // Aceptar slugs desconocidos que tengan formato de destino (sin espacios, 3+ chars)
    if (dest.length >= 3 && !dest.includes(" ")) return dest;
  }
  return "sin-etiquetar";
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr), ...headers },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        console.log(`  HTTP ${res.statusCode} — ${hostname}${path}`);
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`HTTP ${res.statusCode}: ` + data.slice(0, 500))); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: "refresh_token",
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        const json = JSON.parse(data);
        if (json.error) reject(new Error(`OAuth error: ${json.error_description || json.error}`));
        else resolve(json.access_token);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function queryGoogleAds(accessToken, query) {
  const rows = [];
  let pageToken = null;

  do {
    const body = { query };
    if (pageToken) body.pageToken = pageToken;

    const res = await post(
      "googleads.googleapis.com",
      `/v21/customers/${CLIENT_ID_CID}/googleAds:search`,
      {
        "Authorization": `Bearer ${accessToken}`,
        "developer-token": DEVELOPER_TOKEN,
      },
      body
    );

    if (res.error) throw new Error(`Google Ads API error: ${JSON.stringify(res.error)}`);

    rows.push(...(res.results || []));
    pageToken = res.nextPageToken || null;
  } while (pageToken);

  return rows;
}

function loadJson(p, def) {
  if (!fs.existsSync(p)) return def;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch(e) { return def; }
}

async function refreshGoogleAds(dateFrom, dateTo) {
  console.log(`  Obteniendo access token...`);
  const accessToken = await getAccessToken();
  console.log(`  ✅ Access token OK`);


  const fromNum = parseInt(dateFrom.replace(/-/g, ""));
  const toNum   = parseInt(dateTo.replace(/-/g, ""));

  // ── 1. Campaign-level por día ─────────────────────────────────────────────
  console.log(`  Fetching Google Ads campaigns ${dateFrom} → ${dateTo}...`);
  const campResults = await queryGoogleAds(accessToken, `
    SELECT
      campaign.id,
      campaign.name,
      segments.date,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date
  `);

  const campRows = campResults.map(r => ({
    date: r.segments.date.replace(/-/g, ""),
    campaign_id: r.campaign.id,
    campaign_name: r.campaign.name,
    spend: (r.metrics.costMicros || 0) / 1_000_000,
    impressions: parseInt(r.metrics.impressions) || 0,
    clicks: parseInt(r.metrics.clicks) || 0,
    conversions: Math.round(parseFloat(r.metrics.conversions) || 0),
    conversions_value: Math.round(parseFloat(r.metrics.conversionsValue) || 0),
  }));

  // Guardar gads-data.json
  const gadsFile = loadJson(GADS_PATH, { updated: "", rows: [] });
  if (!Array.isArray(gadsFile.rows)) gadsFile.rows = [];
  gadsFile.rows = gadsFile.rows.filter(r => { const d = parseInt(String(r.date)); return d < fromNum || d > toNum; });
  gadsFile.rows.push(...campRows);
  gadsFile.rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  gadsFile.updated = dateTo;
  fs.writeFileSync(GADS_PATH, JSON.stringify(gadsFile), "utf8");
  console.log(`  ✅ gads-data.json — ${campRows.length} filas`);

  // ── 2. Actualizar campaigns-data.json (columna g) ─────────────────────────
  const campFile = loadJson(CAMPAIGNS_PATH, { v: 1, updated: "", cols: { m: ["n","s","pu","rch","imp","clk"], g: ["n","s","cv","rv","imp","clk"] }, days: {} });
  Object.keys(campFile.days).forEach(dateStr => {
    const num = parseInt(dateStr.replace(/-/g, ""));
    if (num >= fromNum && num <= toNum && campFile.days[dateStr]) {
      delete campFile.days[dateStr].g;
    }
  });
  const campByDate = {};
  campResults.forEach(r => {
    const date = r.segments.date;
    if (!campByDate[date]) campByDate[date] = [];
    campByDate[date].push([
      r.campaign.name,
      Math.round((r.metrics.costMicros || 0) / 1_000_000 * 100) / 100,
      Math.round(parseFloat(r.metrics.conversions) || 0),
      Math.round(parseFloat(r.metrics.conversionsValue) || 0),
      parseInt(r.metrics.impressions) || 0,
      parseInt(r.metrics.clicks) || 0,
    ]);
  });
  Object.entries(campByDate).forEach(([date, arr]) => {
    if (!campFile.days[date]) campFile.days[date] = {};
    campFile.days[date].g = arr;
  });
  campFile.updated = dateTo;
  fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(campFile), "utf8");
  console.log(`  ✅ campaigns-data.json actualizado con Google Ads`);

  // ── 3. Ad group level → data.json (por destino) + google-adgroups-data.json
  console.log(`  Fetching Google Ads ad groups (destinos) ${dateFrom} → ${dateTo}...`);
  const adGroupResults = await queryGoogleAds(accessToken, `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      segments.date,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.conversions,
      metrics.conversions_value,
      metrics.all_conversions,
      metrics.all_conversions_value,
      metrics.video_views
    FROM ad_group
    WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
      AND ad_group.status != 'REMOVED'
      AND campaign.status != 'REMOVED'
      AND metrics.cost_micros > 0
    ORDER BY segments.date
  `);

  const destByDate = {};
  const adGroupRows = [];

  adGroupResults.forEach(r => {
    const date = r.segments.date;
    const adGroupName = r.adGroup.name || "";
    const dest = extractDestinationFromAdGroup(adGroupName);
    const spend = (r.metrics.costMicros || 0) / 1_000_000;

    if (!destByDate[date]) destByDate[date] = {};
    destByDate[date][dest] = (destByDate[date][dest] || 0) + spend;

    adGroupRows.push([
      date.replace(/-/g, ""),
      r.campaign.id   || "",
      r.campaign.name || "",
      r.adGroup.id    || "",
      adGroupName,
      dest,
      Math.round(spend * 100) / 100,
      parseInt(r.metrics.impressions)                                        || 0,
      parseInt(r.metrics.clicks)                                             || 0,
      Math.round((parseFloat(r.metrics.ctr)        || 0) * 10000) / 10000,
      Math.round(((r.metrics.averageCpc || 0) / 1_000_000) * 100)  / 100,
      Math.round(parseFloat(r.metrics.conversions)                  || 0),
      Math.round(parseFloat(r.metrics.conversionsValue)             || 0),
      Math.round(parseFloat(r.metrics.allConversions)               || 0),
      Math.round(parseFloat(r.metrics.allConversionsValue)          || 0),
      parseInt(r.metrics.videoViews)                                         || 0,
    ]);
  });

  // Guardar google-adgroups-data.json
  const gAdGroupsFile = loadJson(GOOGLE_ADGROUPS_PATH, {
    updated: "",
    cols: ["date","campaign_id","campaign_name","adgroup_id","adgroup_name","dest","spend","impressions","clicks","ctr","avg_cpc","conversions","conversions_value","all_conversions","all_conversions_value","video_views"],
    rows: [],
  });
  if (!Array.isArray(gAdGroupsFile.rows)) gAdGroupsFile.rows = [];
  gAdGroupsFile.rows = gAdGroupsFile.rows.filter(r => { const d = parseInt(String(r[0])); return d < fromNum || d > toNum; });
  gAdGroupsFile.rows.push(...adGroupRows);
  gAdGroupsFile.rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  gAdGroupsFile.updated = dateTo;
  fs.writeFileSync(GOOGLE_ADGROUPS_PATH, JSON.stringify(gAdGroupsFile), "utf8");
  console.log(`  ✅ google-adgroups-data.json — ${adGroupRows.length} filas`);

  const dataFile = loadJson(DATA_PATH, { v: 1, updated: "", days: {} });
  Object.keys(dataFile.days).forEach(dateStr => {
    const num = parseInt(dateStr.replace(/-/g, ""));
    if (num >= fromNum && num <= toNum && dataFile.days[dateStr]) {
      delete dataFile.days[dateStr].g;
    }
  });
  Object.entries(destByDate).forEach(([date, destObj]) => {
    if (!dataFile.days[date]) dataFile.days[date] = {};
    const rounded = {};
    Object.entries(destObj).forEach(([d, v]) => { rounded[d] = Math.round(v * 100) / 100; });
    dataFile.days[date].g = rounded;
  });
  dataFile.updated = dateTo;
  fs.writeFileSync(DATA_PATH, JSON.stringify(dataFile), "utf8");
  console.log(`  ✅ data.json — ${Object.keys(destByDate).length} días con datos Google Ads por destino`);
}

async function main() {
  if (!DEVELOPER_TOKEN) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN no configurado");
  if (!REFRESH_TOKEN)   throw new Error("GOOGLE_ADS_REFRESH_TOKEN no configurado");
  if (!CLIENT_ID_CID)   throw new Error("GOOGLE_ADS_CLIENT_CUSTOMER_ID no configurado");

  const args = process.argv.slice(2);
  const fromArg = args.find(a => a.startsWith("--from="));
  const toArg   = args.find(a => a.startsWith("--to="));
  const dateFrom = fromArg ? fromArg.split("=")[1] : daysAgo(7);
  const dateTo   = toArg   ? toArg.split("=")[1]   : daysAgo(1);

  await refreshGoogleAds(dateFrom, dateTo);
}

main().catch(e => { console.error("❌ Google Ads error:", e.message); process.exit(1); });
