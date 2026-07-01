#!/usr/bin/env node
// tiktok-refresh.js — Obtiene datos de TikTok Ads via Marketing API v1.3
// Uso:
//   node tiktok-refresh.js                              → últimos 7 días
//   node tiktok-refresh.js --from=2026-06-01 --to=2026-06-18

require("dotenv").config();
const https = require("https");
const fs = require("fs");
const path = require("path");

const ACCESS_TOKEN    = (process.env.TIKTOK_ACCESS_TOKEN || "").trim();
const ADVERTISER_ID   = (process.env.TIKTOK_ADVERTISER_ID || "").trim();
const TIKTOK_PATH     = path.join(__dirname, "tiktok-data.json");
const TIKTOK_ADS_PATH = path.join(__dirname, "tiktok-ads-data.json");
const DATA_PATH       = path.join(__dirname, "data.json");
const CAMPAIGNS_PATH  = path.join(__dirname, "campaigns-data.json");

const DESTINOS = ["las-arenas","isla-cristina","trafalgar","costa-brava","canos","los-canos","somo-playa","somo","tarifa","ria-de-vigo","roquetas","llanes","tossa-de-mar","cambrils","paloma","kikopark-playa","kikopark","cova-negra","alquezar","bayona-playa","bayona","benicassim","blanes","navajas","lago-de-arcos","sierra-nevada","picos-urbion","picos","el-palmar","palmar"];

function extractDestination(name) {
  const lower = name.toLowerCase();
  for (const dest of DESTINOS) {
    if (lower.includes(dest)) return dest;
  }
  return "sin-etiquetar";
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function apiGet(queryParams) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(queryParams).toString();
    const req = https.request({
      hostname: "business-api.tiktok.com",
      path: `/open_api/v1.3/report/integrated/get/?${qs}`,
      method: "GET",
      headers: { "Access-Token": ACCESS_TOKEN },
    }, (res) => {
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

async function fetchAllPages(dataLevel, dimensions, metrics, dateFrom, dateTo) {
  const rows = [];
  let page = 1;
  while (true) {
    const params = {
      advertiser_id: ADVERTISER_ID,
      report_type: "BASIC",
      data_level: dataLevel,
      dimensions: JSON.stringify(dimensions),
      metrics: JSON.stringify(metrics),
      start_date: dateFrom,
      end_date: dateTo,
      page_size: 1000,
      page,
    };
    const res = await apiGet(params);
    if (res.code !== 0) throw new Error(`TikTok API error ${res.code}: ${res.message}`);
    const list = res.data?.list || [];
    rows.push(...list);
    const total = res.data?.page_info?.total_number || 0;
    if (rows.length >= total || list.length === 0) break;
    page++;
  }
  return rows;
}

function loadJson(p, def) {
  if (!fs.existsSync(p)) return def;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch(e) { return def; }
}

async function refreshTikTok(dateFrom, dateTo) {
  const fromNum = parseInt(dateFrom.replace(/-/g, ""));
  const toNum   = parseInt(dateTo.replace(/-/g, ""));

  // ── 1. Campaign-level (tiktok-data.json + campaigns-data.json) ────────────
  console.log(`  Fetching TikTok campaigns ${dateFrom} → ${dateTo}...`);
  const campRaw = await fetchAllPages(
    "AUCTION_CAMPAIGN",
    ["campaign_id", "stat_time_day"],
    ["spend", "impressions", "clicks", "conversion", "campaign_name"],
    dateFrom, dateTo
  );

  const campRows = campRaw.map(item => ({
    date: item.dimensions.stat_time_day.slice(0, 10).replace(/-/g, ""),
    campaign_id: item.dimensions.campaign_id,
    campaign_name: item.metrics.campaign_name || "",
    spend: parseFloat(item.metrics.spend) || 0,
    impressions: parseInt(item.metrics.impressions) || 0,
    clicks: parseInt(item.metrics.clicks) || 0,
    conversions: parseInt(item.metrics.conversion) || 0,
  }));

  // tiktok-data.json
  const tiktokFile = loadJson(TIKTOK_PATH, { updated: "", rows: [] });
  if (!Array.isArray(tiktokFile.rows)) tiktokFile.rows = [];
  tiktokFile.rows = tiktokFile.rows.filter(r => { const d = parseInt(String(r.date)); return d < fromNum || d > toNum; });
  tiktokFile.rows.push(...campRows);
  tiktokFile.rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  tiktokFile.updated = dateTo;
  fs.writeFileSync(TIKTOK_PATH, JSON.stringify(tiktokFile), "utf8");
  console.log(`  ✅ tiktok-data.json — ${campRows.length} filas`);

  // campaigns-data.json columna t
  const campFile = loadJson(CAMPAIGNS_PATH, { v: 1, updated: "", cols: { m: ["n","s","pu","rch","imp","clk"], g: ["n","s","cv","rv","imp","clk"], t: ["n","s","cv","imp","clk"] }, days: {} });
  if (!campFile.cols.t) campFile.cols.t = ["n","s","cv","imp","clk"];
  Object.keys(campFile.days).forEach(dateStr => {
    const num = parseInt(dateStr.replace(/-/g, ""));
    if (num >= fromNum && num <= toNum && campFile.days[dateStr]) delete campFile.days[dateStr].t;
  });
  const campByDate = {};
  campRaw.forEach(item => {
    const date = item.dimensions.stat_time_day.slice(0, 10);
    if (!campByDate[date]) campByDate[date] = [];
    campByDate[date].push([
      item.metrics.campaign_name || "",
      Math.round((parseFloat(item.metrics.spend) || 0) * 100) / 100,
      parseInt(item.metrics.conversion) || 0,
      parseInt(item.metrics.impressions) || 0,
      parseInt(item.metrics.clicks) || 0,
    ]);
  });
  Object.entries(campByDate).forEach(([date, arr]) => {
    if (!campFile.days[date]) campFile.days[date] = {};
    campFile.days[date].t = arr;
  });
  campFile.updated = dateTo;
  fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(campFile), "utf8");
  console.log(`  ✅ campaigns-data.json actualizado con TikTok`);

  // ── 2. Ad-level → data.json (por destino) + tiktok-ads-data.json ────────
  console.log(`  Fetching TikTok ads (destinos) ${dateFrom} → ${dateTo}...`);
  let adRaw = [];
  let adLevelOk = true;
  try {
    adRaw = await fetchAllPages(
      "AUCTION_AD",
      ["ad_id", "adgroup_id", "campaign_id", "stat_time_day"],
      ["ad_name", "adgroup_name", "campaign_name", "spend", "impressions", "clicks", "ctr", "cpm", "cpc", "conversion", "cost_per_conversion", "video_play_actions", "video_watched_2s", "video_watched_6s", "video_views_p25", "video_views_p50", "video_views_p75", "video_views_p100", "average_video_play"],
      dateFrom, dateTo
    );
  } catch(e) {
    console.log(`  ⚠️  Ad-level no disponible (${e.message}) — usando datos de campaña`);
    adLevelOk = false;
    adRaw = campRaw.map(item => ({
      dimensions: { stat_time_day: item.dimensions.stat_time_day, ad_id: "", adgroup_id: "", campaign_id: item.dimensions.campaign_id },
      metrics: { spend: item.metrics.spend, ad_name: item.metrics.campaign_name || "", adgroup_name: "", campaign_name: item.metrics.campaign_name || "", impressions: item.metrics.impressions, clicks: item.metrics.clicks, ctr: 0, cpm: 0, cpc: 0, conversion: item.metrics.conversion, cost_per_conversion: 0, video_play_actions: 0, video_watched_2s: 0, video_watched_6s: 0, video_views_p25: 0, video_views_p50: 0, video_views_p75: 0, video_views_p100: 0, average_video_play: 0 },
    }));
  }

  const destByDate = {};
  const adRows = [];

  adRaw.forEach(item => {
    const date = item.dimensions.stat_time_day.slice(0, 10);
    const adName = item.metrics.ad_name || "";
    const dest = extractDestination(adName);
    const spend = parseFloat(item.metrics.spend) || 0;

    if (!destByDate[date]) destByDate[date] = {};
    destByDate[date][dest] = (destByDate[date][dest] || 0) + spend;

    adRows.push([
      date.replace(/-/g, ""),
      item.dimensions.campaign_id  || "",
      item.metrics.campaign_name   || "",
      item.dimensions.adgroup_id   || "",
      item.metrics.adgroup_name    || "",
      item.dimensions.ad_id        || "",
      adName,
      dest,
      Math.round(spend * 100) / 100,
      parseInt(item.metrics.impressions)        || 0,
      parseInt(item.metrics.clicks)             || 0,
      Math.round((parseFloat(item.metrics.ctr)  || 0) * 100) / 100,
      Math.round((parseFloat(item.metrics.cpm)  || 0) * 100) / 100,
      Math.round((parseFloat(item.metrics.cpc)  || 0) * 100) / 100,
      parseInt(item.metrics.conversion)         || 0,
      Math.round((parseFloat(item.metrics.cost_per_conversion) || 0) * 100) / 100,
      parseInt(item.metrics.video_play_actions) || 0,
      parseInt(item.metrics.video_watched_2s)   || 0,
      parseInt(item.metrics.video_watched_6s)   || 0,
      parseInt(item.metrics.video_views_p25)    || 0,
      parseInt(item.metrics.video_views_p50)    || 0,
      parseInt(item.metrics.video_views_p75)    || 0,
      parseInt(item.metrics.video_views_p100)   || 0,
      Math.round((parseFloat(item.metrics.average_video_play) || 0) * 100) / 100,
    ]);
  });

  if (adLevelOk) {
    const ttAdsFile = loadJson(TIKTOK_ADS_PATH, {
      updated: "",
      cols: ["date","campaign_id","campaign_name","adgroup_id","adgroup_name","ad_id","ad_name","dest","spend","impressions","clicks","ctr","cpm","cpc","conversions","cost_per_conversion","video_plays","video_2s","video_6s","video_p25","video_p50","video_p75","video_p100","avg_video_play"],
      rows: [],
    });
    if (!Array.isArray(ttAdsFile.rows)) ttAdsFile.rows = [];
    ttAdsFile.rows = ttAdsFile.rows.filter(r => { const d = parseInt(String(r[0])); return d < fromNum || d > toNum; });
    ttAdsFile.rows.push(...adRows);
    ttAdsFile.rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    ttAdsFile.updated = dateTo;
    fs.writeFileSync(TIKTOK_ADS_PATH, JSON.stringify(ttAdsFile), "utf8");
    console.log(`  ✅ tiktok-ads-data.json — ${adRows.length} filas`);
  }

  const dataFile = loadJson(DATA_PATH, { v: 1, updated: "", days: {} });
  Object.keys(dataFile.days).forEach(dateStr => {
    const num = parseInt(dateStr.replace(/-/g, ""));
    if (num >= fromNum && num <= toNum && dataFile.days[dateStr]) delete dataFile.days[dateStr].t;
  });
  Object.entries(destByDate).forEach(([date, destObj]) => {
    if (!dataFile.days[date]) dataFile.days[date] = {};
    const rounded = {};
    Object.entries(destObj).forEach(([d, v]) => { rounded[d] = Math.round(v * 100) / 100; });
    dataFile.days[date].t = rounded;
  });
  dataFile.updated = dateTo;
  fs.writeFileSync(DATA_PATH, JSON.stringify(dataFile), "utf8");
  console.log(`  ✅ data.json — ${Object.keys(destByDate).length} días con datos TikTok`);
}

async function main() {
  if (!ACCESS_TOKEN) throw new Error("TIKTOK_ACCESS_TOKEN no configurado en .env");
  if (!ADVERTISER_ID) throw new Error("TIKTOK_ADVERTISER_ID no configurado en .env");

  const args = process.argv.slice(2);
  const fromArg = args.find(a => a.startsWith("--from="));
  const toArg   = args.find(a => a.startsWith("--to="));
  const dateFrom = fromArg ? fromArg.split("=")[1] : daysAgo(7);
  const dateTo   = toArg   ? toArg.split("=")[1]   : daysAgo(1);
  await refreshTikTok(dateFrom, dateTo);
}

main().catch(e => { console.error("❌ TikTok error:", e.message); process.exit(1); });
