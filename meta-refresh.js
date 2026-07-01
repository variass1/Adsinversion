#!/usr/bin/env node
// meta-refresh.js — Obtiene datos de Meta Ads via Marketing API v21
// Actualiza: meta-data.json (campañas), data.json (por destino), campaigns-data.json
// Uso:
//   node meta-refresh.js                              → últimos 7 días
//   node meta-refresh.js --from=2026-06-01 --to=2026-06-18

require("dotenv").config();
const https = require("https");
const fs = require("fs");
const path = require("path");

const ACCESS_TOKEN      = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID     = process.env.META_AD_ACCOUNT_ID;
const META_PATH         = path.join(__dirname, "meta-data.json");
const META_ADS_PATH     = path.join(__dirname, "meta-ads-data.json");
const DATA_PATH         = path.join(__dirname, "data.json");
const CAMPAIGNS_PATH    = path.join(__dirname, "campaigns-data.json");
const API_VERSION       = "v21.0";

// Destinos conocidos de Kampaoh
const DESTINOS = ["las-arenas","isla-cristina","trafalgar","costa-brava","canos","los-canos","somo-playa","somo","tarifa","ria-de-vigo","roquetas","llanes","tossa-de-mar","cambrils","paloma","kikopark-playa","kikopark","cova-negra","alquezar","bayona-playa","bayona","benicassim","blanes","navajas","lago-de-arcos","sierra-nevada","picos-urbion","picos","el-palmar","palmar"];

const GENERIC = new Set(["españa","spain","destinos","generico","generica","colaboraciones","ugc","contenido","verano","navidad","eventos","trueque","housekeeping","internacional","int","es","clientes","potenciales","carrusel","video","imagen","stories","reels","reel"]);

function extractDestination(name) {
  const lower = name.toLowerCase();
  // Buscar destino conocido en el nombre del anuncio
  for (const dest of DESTINOS) {
    if (lower.includes(dest)) return dest;
  }
  // Convención: [PLAT]_[OBJ]_[AUD]_[FORMATO]_[DESTINO]_[FECHA]
  const parts = name.split("_");
  if (parts.length >= 5) {
    const raw = parts[4]
      .replace(/\s*\(\d+\)\s*/g, "")
      .toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (raw && raw.length >= 3 && !GENERIC.has(raw)) return raw;
  }
  return "sin-etiquetar";
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function apiGet(endpoint, params) {
  return new Promise((resolve, reject) => {
    params.access_token = ACCESS_TOKEN;
    const qs = new URLSearchParams(params).toString();
    const options = {
      hostname: "graph.facebook.com",
      path: `/${API_VERSION}/${endpoint}?${qs}`,
      method: "GET",
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error: " + data)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchAllPages(endpoint, params) {
  const rows = [];
  let res = await apiGet(endpoint, params);
  if (res.error) throw new Error(`Meta API error: ${res.error.message}`);
  rows.push(...(res.data || []));
  while (res.paging && res.paging.next) {
    const next = new URL(res.paging.next);
    const nextParams = Object.fromEntries(next.searchParams.entries());
    const nextPath = next.pathname.replace(/^\/v\d+\.\d+\//, "");
    res = await apiGet(nextPath, nextParams);
    if (res.error) throw new Error(`Meta API error: ${res.error.message}`);
    rows.push(...(res.data || []));
  }
  return rows;
}

function loadJson(p, def) {
  if (!fs.existsSync(p)) return def;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch(e) { return def; }
}

async function refreshMeta(dateFrom, dateTo) {
  console.log(`  Fetching Meta campaigns ${dateFrom} → ${dateTo}...`);

  // ── 1. Campaign-level (meta-data.json) ──────────────────────────────────
  const campRaw = await fetchAllPages(`act_${AD_ACCOUNT_ID}/insights`, {
    level: "campaign",
    fields: "campaign_id,campaign_name,spend,impressions,clicks,reach,actions",
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    time_increment: 1,
    limit: 500,
  });

  const campRows = campRaw.map((item) => {
    const purchases = (item.actions || [])
      .filter(a => a.action_type === "purchase")
      .reduce((s, a) => s + parseInt(a.value || 0), 0);
    return {
      date: (item.date_start || "").replace(/-/g, ""),
      campaign_id: item.campaign_id || "",
      campaign_name: item.campaign_name || "",
      spend: parseFloat(item.spend) || 0,
      impressions: parseInt(item.impressions) || 0,
      clicks: parseInt(item.clicks) || 0,
      purchases,
    };
  });

  const metaFile = loadJson(META_PATH, { updated: "", rows: [] });
  if (!Array.isArray(metaFile.rows)) metaFile.rows = [];
  const fromNum = parseInt(dateFrom.replace(/-/g, ""));
  const toNum   = parseInt(dateTo.replace(/-/g, ""));
  metaFile.rows = metaFile.rows.filter(r => { const d = parseInt(String(r.date)); return d < fromNum || d > toNum; });
  metaFile.rows.push(...campRows);
  metaFile.rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  metaFile.updated = dateTo;
  fs.writeFileSync(META_PATH, JSON.stringify(metaFile), "utf8");
  console.log(`  ✅ meta-data.json — ${campRows.length} filas`);

  // ── 2. campaigns-data.json ───────────────────────────────────────────────
  const campFile = loadJson(CAMPAIGNS_PATH, { v: 1, updated: "", cols: { m: ["n","s","pu","rch","imp","clk"], g: ["n","s","cv","rv","imp","clk"] }, days: {} });
  // Eliminar fechas del rango
  Object.keys(campFile.days).forEach(dateStr => {
    const num = parseInt(dateStr.replace(/-/g, ""));
    if (num >= fromNum && num <= toNum) delete campFile.days[dateStr];
  });
  // Reagrupar por fecha
  const campByDate = {};
  campRaw.forEach(item => {
    const date = item.date_start;
    if (!campByDate[date]) campByDate[date] = [];
    const purchases = (item.actions || []).filter(a => a.action_type === "purchase").reduce((s, a) => s + parseInt(a.value || 0), 0);
    campByDate[date].push([
      item.campaign_name || "",
      parseFloat(item.spend) || 0,
      purchases,
      parseInt(item.reach) || 0,
      parseInt(item.impressions) || 0,
      parseInt(item.clicks) || 0,
    ]);
  });
  Object.assign(campFile.days, Object.fromEntries(
    Object.entries(campByDate).map(([date, arr]) => [date, { m: arr }])
  ));
  campFile.updated = dateTo;
  fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(campFile), "utf8");
  console.log(`  ✅ campaigns-data.json actualizado`);

  // ── 3. Ad-level → data.json (por destino) + meta-ads-data.json ─────────
  console.log(`  Fetching Meta ads (destinos) ${dateFrom} → ${dateTo}...`);
  const adRaw = await fetchAllPages(`act_${AD_ACCOUNT_ID}/insights`, {
    level: "ad",
    fields: "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpm,cpp,actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions",
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    time_increment: 1,
    limit: 500,
  });

  const getAction = (actions, type) =>
    (actions || []).filter(a => a.action_type === type).reduce((s, a) => s + parseInt(a.value || 0), 0);

  const getVideoAction = (arr) =>
    (arr || []).reduce((s, a) => s + parseInt(a.value || 0), 0);

  // Agrupar gasto por fecha y destino (data.json)
  const destByDate = {};
  // Filas detalladas para meta-ads-data.json
  const adRows = [];

  adRaw.forEach(item => {
    const date = item.date_start;
    const adName = item.ad_name || "";
    const dest = extractDestination(adName);
    const spend = parseFloat(item.spend) || 0;

    if (!destByDate[date]) destByDate[date] = {};
    destByDate[date][dest] = (destByDate[date][dest] || 0) + spend;

    adRows.push([
      (date || "").replace(/-/g, ""),
      item.campaign_id   || "",
      item.campaign_name || "",
      item.adset_id      || "",
      item.adset_name    || "",
      item.ad_id         || "",
      adName,
      dest,
      Math.round(spend * 100) / 100,
      parseInt(item.impressions) || 0,
      parseInt(item.reach)       || 0,
      Math.round((parseFloat(item.frequency) || 0) * 100) / 100,
      parseInt(item.clicks)      || 0,
      Math.round((parseFloat(item.ctr) || 0) * 100) / 100,
      Math.round((parseFloat(item.cpm) || 0) * 100) / 100,
      Math.round((parseFloat(item.cpp) || 0) * 100) / 100,
      getAction(item.actions, "purchase"),
      getAction(item.actions, "add_to_cart"),
      getAction(item.actions, "initiate_checkout"),
      getAction(item.actions, "landing_page_view"),
      getAction(item.actions, "link_click"),
      getVideoAction(item.video_p25_watched_actions),
      getVideoAction(item.video_p50_watched_actions),
      getVideoAction(item.video_p75_watched_actions),
      getVideoAction(item.video_p100_watched_actions),
    ]);
  });

  // Guardar meta-ads-data.json
  const metaAdsFile = loadJson(META_ADS_PATH, {
    updated: "",
    cols: ["date","campaign_id","campaign_name","adset_id","adset_name","ad_id","ad_name","dest","spend","impressions","reach","frequency","clicks","ctr","cpm","cpp","purchases","add_to_cart","initiated_checkout","landing_page_views","link_clicks","video_p25","video_p50","video_p75","video_p100"],
    rows: [],
  });
  if (!Array.isArray(metaAdsFile.rows)) metaAdsFile.rows = [];
  metaAdsFile.rows = metaAdsFile.rows.filter(r => { const d = parseInt(String(r[0])); return d < fromNum || d > toNum; });
  metaAdsFile.rows.push(...adRows);
  metaAdsFile.rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  metaAdsFile.updated = dateTo;
  fs.writeFileSync(META_ADS_PATH, JSON.stringify(metaAdsFile), "utf8");
  console.log(`  ✅ meta-ads-data.json — ${adRows.length} filas`);

  const dataFile = loadJson(DATA_PATH, { v: 1, updated: "", days: {} });
  Object.keys(dataFile.days).forEach(dateStr => {
    const num = parseInt(dateStr.replace(/-/g, ""));
    if (num >= fromNum && num <= toNum && dataFile.days[dateStr]) {
      delete dataFile.days[dateStr].m;
    }
  });
  Object.entries(destByDate).forEach(([date, destObj]) => {
    if (!dataFile.days[date]) dataFile.days[date] = {};
    const rounded = {};
    Object.entries(destObj).forEach(([d, v]) => { rounded[d] = Math.round(v * 100) / 100; });
    dataFile.days[date].m = rounded;
  });
  dataFile.updated = dateTo;
  fs.writeFileSync(DATA_PATH, JSON.stringify(dataFile), "utf8");
  console.log(`  ✅ data.json — ${Object.keys(destByDate).length} días con datos Meta`);
}

async function main() {
  if (!ACCESS_TOKEN) throw new Error("META_ACCESS_TOKEN no configurado en .env");
  if (!AD_ACCOUNT_ID) throw new Error("META_AD_ACCOUNT_ID no configurado en .env");

  const args = process.argv.slice(2);
  const fromArg = args.find(a => a.startsWith("--from="));
  const toArg   = args.find(a => a.startsWith("--to="));
  const dateFrom = fromArg ? fromArg.split("=")[1] : daysAgo(7);
  const dateTo   = toArg   ? toArg.split("=")[1]   : daysAgo(1);
  await refreshMeta(dateFrom, dateTo);
}

main().catch(e => { console.error("❌ Meta error:", e.message); process.exit(1); });
