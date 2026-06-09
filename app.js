/* Tuna - client-side bluefin day-sheet + map.
 * Mirrors src/tuna (config.py / scoring.py / sources/solunar.py / ocean.py) so the
 * map matches the CLI. Live data: Open-Meteo Marine + Weather (free, no key, CORS).
 * Everything is measured from your home port (data/home.json).
 */

// ---- config (keep in sync with src/tuna/config.py) ----
const SST_BANDS = [[18, 24, 1.0], [16, 26, 0.6], [14, 28, 0.3]], SST_FLOOR = 0.1;
const WAVE_BANDS = [[0.8, 1.0], [1.5, 0.7], [2.0, 0.4]], WAVE_FLOOR = 0.1;
const WIND_BANDS = [[8, 1.0], [15, 0.9], [22, 0.7], [30, 0.45], [40, 0.2]], WIND_FLOOR = 0.05;
const CURRENT_BANDS = [[0.3, 0.45], [2.5, 1.0], [5.0, 0.7], [9.0, 0.45]], CURRENT_FLOOR = 0.3;
const PRESSURE_BANDS = [[-1e9, -3, 0.4], [-3, -1.5, 0.7], [-1.5, -0.5, 1.0], [-0.5, 0.5, 0.9], [0.5, 1.5, 0.7], [1.5, 1e9, 0.45]];
const CAST_WAVE_W = 0.55, CAST_WIND_W = 0.45;
const FRONT_MIN_SPREAD = 0.5, FRONT_BASELINE = 0.3;
const WEIGHTS = { sst: 0.22, front: 0.13, bait: 0.15, current: 0.10, castability: 0.17, pressure: 0.10, solunar: 0.13 };
const SIGHTING_MAX = 0.15, SIGHTING_RADIUS_KM = 15, SIGHTING_DAYS = 3;
const BLOWOUT_WIND = 35, BLOWOUT_WAVE = 2.0;
const COLORS = { PRIME: "#1a9850", GOOD: "#91cf60", FAIR: "#fdae61", POOR: "#d73027" };

const band3 = (x, bands, floor) => { for (const [lo, hi, s] of bands) if (x >= lo && x <= hi) return s; return floor; };
const bandMax = (x, bands, floor) => { for (const [mx, s] of bands) if (x <= mx) return s; return floor; };
const sstScore = (t) => t == null ? null : band3(t, SST_BANDS, SST_FLOOR);
const waveScore = (h) => h == null ? null : bandMax(h, WAVE_BANDS, WAVE_FLOOR);
const windScore = (k) => k == null ? null : bandMax(k, WIND_BANDS, WIND_FLOOR);
const currentScore = (k) => k == null ? null : bandMax(k, CURRENT_BANDS, CURRENT_FLOOR);
function pressureScore(t) { if (t == null) return null; for (const [lo, hi, s] of PRESSURE_BANDS) if (t >= lo && t < hi) return s; return 0.5; }
function castabilityScore(wave, wind) {
  const a = waveScore(wave), b = windScore(wind);
  if (a == null && b == null) return null;
  if (a == null) return b; if (b == null) return a;
  return CAST_WAVE_W * a + CAST_WIND_W * b;
}
function median(xs) { const a = [...xs].sort((p, q) => p - q), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function frontScores(ssts) {
  const v = ssts.filter((s) => s != null);
  if (!v.length) return ssts.map(() => FRONT_BASELINE);
  const spread = Math.max(...v) - Math.min(...v);
  if (spread < FRONT_MIN_SPREAD) return ssts.map(() => FRONT_BASELINE);
  const mid = median(v), half = spread / 2;
  return ssts.map((s) => s == null ? FRONT_BASELINE : Math.max(0, Math.min(1, Math.abs(s - mid) / half)));
}
function combineWeighted(factors) {
  let num = 0, den = 0; const contrib = {};
  for (const [k, sc] of Object.entries(factors)) {
    const w = WEIGHTS[k] || 0; if (sc == null || w <= 0) continue;
    num += w * sc; den += w; contrib[k] = +sc.toFixed(3);
  }
  return { total: den > 0 ? num / den : 0, contrib };
}
function rating(s) { return s >= 0.75 ? "PRIME" : s >= 0.55 ? "GOOD" : s >= 0.35 ? "FAIR" : "POOR"; }

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (d) => d == null ? "?" : COMPASS[Math.round((d % 360) / 22.5) % 16];
const rad = (x) => x * Math.PI / 180;
function haversine(a, b, c, d) {
  const R = 6371, dp = rad(c - a), dl = rad(d - b);
  const x = Math.sin(dp / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function bearing(a, b, c, d) {
  const y = Math.sin(rad(d - b)) * Math.cos(rad(c));
  const x = Math.cos(rad(a)) * Math.sin(rad(c)) - Math.sin(rad(a)) * Math.cos(rad(c)) * Math.cos(rad(d - b));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function sightingBoost(lat, lon, sightings, nowMs) {
  let best = 0;
  for (const s of sightings) {
    const dist = haversine(lat, lon, s.lat, s.lon); if (dist > SIGHTING_RADIUS_KM) continue;
    const age = (nowMs - s._ms) / 86400000; if (age < 0 || age > SIGHTING_DAYS) continue;
    best = Math.max(best, SIGHTING_MAX * (1 - dist / SIGHTING_RADIUS_KM) * (1 - age / SIGHTING_DAYS));
  }
  return best;
}
// solunar (mirror of sources/solunar.py)
function solunar(nowMs, lon, offsetSec) {
  const SYN = 29.53058867, REF = Date.UTC(2000, 0, 6, 18, 14);
  const f = (((nowMs - REF) / 86400000) % SYN + SYN) % SYN / SYN;
  const names = ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous", "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent"];
  const hhmm = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(m / 60 | 0).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  const noon = 720 - 4 * (lon - 15 * offsetSec / 3600);
  const transit = (noon + 1440 * f) % 1440;
  return {
    phase: names[Math.round(f * 8) % 8],
    illumination_pct: Math.round((1 - Math.cos(2 * Math.PI * f)) / 2 * 100),
    day_score: 0.55 + 0.45 * Math.abs(Math.cos(2 * Math.PI * f)),
    major_periods: [hhmm(transit), hhmm(transit + 720)],
    minor_periods: [hhmm(transit - 360), hhmm(transit + 360)],
  };
}

// ---- live fetch ----
async function fetchMarine(lat, lon) {
  const u = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}` +
    `&current=sea_surface_temperature,wave_height,ocean_current_velocity,ocean_current_direction&timezone=auto`;
  const d = await (await fetch(u)).json();
  return { sst: d.current?.sea_surface_temperature ?? null, wave: d.current?.wave_height ?? null,
    current: d.current?.ocean_current_velocity ?? null, offset: d.utc_offset_seconds || 0 };
}
async function fetchWeather(lat, lon) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m,surface_pressure,cloud_cover` +
    `&hourly=surface_pressure&past_days=1&forecast_days=1&timezone=auto`;
  const d = await (await fetch(u)).json();
  const c = d.current || {}, times = d.hourly?.time || [], pres = d.hourly?.surface_pressure || [];
  let trend = null;
  const key = (c.time || "").slice(0, 13) + ":00", i = times.indexOf(key);
  if (i >= 3 && pres[i] != null && pres[i - 3] != null) trend = +(pres[i] - pres[i - 3]).toFixed(2);
  return { wind: c.wind_speed_10m ?? null, gust: c.wind_gusts_10m ?? null, windDir: c.wind_direction_10m ?? null,
    pressure: c.surface_pressure ?? null, trend, cloud: c.cloud_cover ?? null };
}

// ---- map ----
const map = L.map("map");
const darkBase = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  { attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 19 }).addTo(map);

// NASA GIBS near-real-time true-colour satellite (free, no key). Yesterday UTC is
// the most reliably-processed day. Shows real water colour / sediment / blooms -
// NOT live frenzies (a tuna bust is metres-wide & minutes-long, smaller & briefer
// than any free satellite can catch). Use it to find blooms & colour edges.
function gibsDate(daysBack) { return new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10); }
function gibs(layer) {
  return L.tileLayer(
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${gibsDate(1)}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
    { attribution: `Imagery &copy; NASA GIBS/Worldview Â· ${gibsDate(1)}`,
      maxNativeZoom: 9, maxZoom: 19, bounds: [[-85, -180], [85, 180]] });
}
const viirsBase = gibs("VIIRS_SNPP_CorrectedReflectance_TrueColor");
const modisBase = gibs("MODIS_Terra_CorrectedReflectance_TrueColor");

const spotLayer = L.layerGroup().addTo(map);
const sightLayer = L.layerGroup().addTo(map);

L.control.layers(
  { "Dark map": darkBase, "Satellite Â· VIIRS (NRT)": viirsBase, "Satellite Â· MODIS (NRT)": modisBase },
  { "Fishing spots": spotLayer, "Frenzies / sightings": sightLayer },
  { collapsed: true }
).addTo(map);

// Tap anywhere (or on a satellite feature) to get its exact GPS + a 10 m Sentinel-2 image.
let clickMarker;
map.on("click", (e) => {
  const lat = e.latlng.lat, lon = e.latlng.lng;
  const eo = `https://apps.sentinel-hub.com/eo-browser/?zoom=14&lat=${lat}&lng=${lon}`;
  const gmap = `https://www.google.com/maps?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (clickMarker) map.removeLayer(clickMarker);
  clickMarker = L.marker([lat, lon]).addTo(map).bindPopup(
    `<b>${lat.toFixed(5)}, ${lon.toFixed(5)}</b><br>` +
    `<a href="${gmap}" target="_blank" rel="noopener">Open in Maps</a><br>` +
    `<a href="${eo}" target="_blank" rel="noopener">Latest Sentinel-2 (10 m) here</a><br>` +
    `<small>Switch to a Satellite layer, find a bloom / colour edge, tap it for its GPS.</small>`
  ).openPopup();
});

let homeMarker, rangeRing;

const statusEl = document.getElementById("status");
const verdictEl = document.getElementById("verdict");
const oceanEl = document.getElementById("ocean");
const rankingEl = document.getElementById("ranking");
const fmt = (v, suf, nd = 1) => v == null ? "n/a" : v.toFixed(nd) + suf;
const trendWord = (t) => t == null ? "n/a" : t > 0.5 ? `rising (+${t}/3h)` : t < -0.5 ? `falling (${t}/3h)` : `steady (${t >= 0 ? "+" : ""}${t}/3h)`;

async function load() {
  statusEl.textContent = "Loading live sea conditionsâ€¦";
  spotLayer.clearLayers(); sightLayer.clearLayers(); rankingEl.innerHTML = "";

  let home, db, sightRaw;
  try {
    [home, db, sightRaw] = await Promise.all([
      fetch("data/home.json").then((r) => r.json()),
      fetch("data/spots.json").then((r) => r.json()),
      fetch("data/sightings.json").then((r) => r.json()).catch(() => ({ sightings: [] })),
    ]);
  } catch (e) { statusEl.textContent = "Could not load data/*.json â€” serve the repo root (see README)."; return; }

  const spots = db.spots;
  const sightings = (sightRaw.sightings || []).filter((s) => !s.example)
    .map((s) => ({ ...s, _ms: Date.parse(s.date + "T12:00:00Z") })).filter((s) => !isNaN(s._ms));

  if (!homeMarker) {
    map.setView([home.lat, home.lon], 9);
    homeMarker = L.marker([home.lat, home.lon], {
      icon: L.divIcon({ className: "home-icon", html: "&#9873;", iconSize: [24, 24] }),
    }).addTo(map).bindPopup(`<b>${home.name}</b><br>home port`);
    rangeRing = L.circle([home.lat, home.lon], { radius: home.max_range_km * 1000,
      color: "#7fc8e8", weight: 1, fill: false, dashArray: "5,6" }).addTo(map);
  }

  const [marine, weather] = await Promise.all([
    Promise.all(spots.map((s) => fetchMarine(s.lat, s.lon).catch(() => ({})))),
    Promise.all(spots.map((s) => fetchWeather(s.lat, s.lon).catch(() => ({})))),
  ]);
  const fronts = frontScores(marine.map((m) => m.sst ?? null));
  const nowMs = Date.now();
  const offset = marine.find((m) => m.offset)?.offset || 7200;
  const moon = solunar(nowMs, home.lon, offset);

  const rows = spots.map((spot, i) => {
    const m = marine[i] || {}, w = weather[i] || {};
    const { total, contrib } = combineWeighted({
      sst: sstScore(m.sst), front: fronts[i], bait: null,
      current: currentScore(m.current), castability: castabilityScore(m.wave, w.wind),
      pressure: pressureScore(w.trend), solunar: moon.day_score,
    });
    const boost = sightingBoost(spot.lat, spot.lon, sightings, nowMs);
    const score = Math.min(1, total + boost);
    const dist = haversine(home.lat, home.lon, spot.lat, spot.lon);
    return { spot, m, w, score, rating: rating(score), contrib, dist,
      nm: dist / 1.852, brg: bearing(home.lat, home.lon, spot.lat, spot.lon),
      inRange: dist <= home.max_range_km };
  }).sort((a, b) => b.score - a.score);

  renderVerdict(rows, moon, home);
  renderOcean(rows, moon);

  rows.forEach((r, idx) => {
    const c = COLORS[r.rating];
    L.circleMarker([r.spot.lat, r.spot.lon], {
      radius: r.inRange ? 9 : 7, color: r.inRange ? "#0b1f2a" : "#666",
      weight: 2, fillColor: c, fillOpacity: r.inRange ? 0.92 : 0.45,
      dashArray: r.inRange ? null : "3,3",
    }).addTo(spotLayer).bindPopup(
      `<b>${r.spot.name}</b> â€” ${r.spot.area}<br><b>${r.rating}</b> Â· score ${r.score.toFixed(2)}` +
      `${r.inRange ? "" : " Â· OUT OF RANGE"}<br>` +
      `${r.nm.toFixed(1)} nm Â· bearing ${r.brg.toFixed(0)}Â° (${compass(r.brg)}) from ${home.name}<br>` +
      `SST ${fmt(r.m.sst, " Â°C")} Â· wave ${fmt(r.m.wave, " m")} Â· wind ${fmt(r.w.wind, " km/h")} ${compass(r.w.windDir)}<br>` +
      `current ${fmt(r.m.current, " km/h")} Â· ${r.spot.depth_zone}<br><small>${r.spot.notes}</small>`);

    const li = document.createElement("li");
    li.className = r.rating.toLowerCase() + (r.inRange ? "" : " outrange");
    li.innerHTML =
      `<div class="rk-head"><span class="rk-name">${idx + 1}. ${r.spot.name}</span>` +
      `<span class="rk-rating">${r.rating} ${r.score.toFixed(2)}</span></div>` +
      `<div class="rk-meta">${r.nm.toFixed(1)} nm ${compass(r.brg)} Â· SST ${fmt(r.m.sst, "Â°C")} Â· ` +
      `wind ${fmt(r.w.wind, "")} ${compass(r.w.windDir)}${r.inRange ? "" : " Â· out of range"}</div>`;
    li.onclick = () => { map.setView([r.spot.lat, r.spot.lon], 11); };
    rankingEl.appendChild(li);
  });

  const FRENZY = new Set(["busting_fish", "bait_ball", "birds"]);
  sightings.forEach((s) => {
    const isFrenzy = FRENZY.has(s.type);
    const ageDays = Math.max(0, Math.round((nowMs - s._ms) / 86400000));
    const html = isFrenzy
      ? '<span style="font-size:20px;filter:drop-shadow(0 0 3px #ff3b30)">&#128165;</span>'  // ðŸ’¥
      : '<span style="font-size:16px">&#128031;</span>';                                       // ðŸŸ
    const eo = `https://apps.sentinel-hub.com/eo-browser/?zoom=14&lat=${s.lat}&lng=${s.lon}`;
    const gmap = `https://www.google.com/maps?q=${s.lat},${s.lon}`;
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "sight-icon", html, iconSize: [22, 22] }) })
      .addTo(sightLayer).bindPopup(
        `<b>${isFrenzy ? "FRENZY / activity" : "Sighting"}</b> Â· ${s.date} (${ageDays}d ago)<br>` +
        `${(s.type || "").replace(/_/g, " ")} ${s.species || ""}<br>` +
        `${s.note ? "<small>" + s.note + "</small><br>" : ""}` +
        `<b>${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</b><br>` +
        `<a href="${gmap}" target="_blank" rel="noopener">Maps</a> Â· ` +
        `<a href="${eo}" target="_blank" rel="noopener">Sentinel-2 image</a>`);
  });

  statusEl.textContent = `As of ${new Date(nowMs).toISOString().slice(0, 16).replace("T", " ")}Z Â· ` +
    `${rows.filter((r) => r.inRange).length} spots in range`;
}

function renderVerdict(rows, moon, home) {
  const inRange = rows.filter((r) => r.inRange);
  const pool = inRange.length ? inRange : rows;
  const winds = pool.map((r) => r.w.wind).filter((x) => x != null);
  const waves = pool.map((r) => r.m.wave).filter((x) => x != null);
  const ssts = pool.map((r) => r.m.sst).filter((x) => x != null);
  const best = pool[0];
  let v = "SLOW", reason = "conditions modest today";
  const maxWind = winds.length ? Math.max(...winds) : 0, maxWave = waves.length ? Math.max(...waves) : 0;
  if (maxWind > BLOWOUT_WIND || maxWave > BLOWOUT_WAVE) {
    v = "TOUGH"; reason = `blown out â€” wind to ${maxWind.toFixed(0)} km/h, swell to ${maxWave.toFixed(1)} m`;
  } else if (best) {
    const wd = compass(best.w.windDir);
    const avg = ssts.length ? (ssts.reduce((a, b) => a + b, 0) / ssts.length).toFixed(1) : "n/a";
    reason = `${winds.length ? Math.min(...winds).toFixed(0) + "â€“" + maxWind.toFixed(0) + " km/h " + wd + " wind, " : ""}` +
      `${waves.length ? Math.min(...waves).toFixed(1) + "â€“" + maxWave.toFixed(1) + " m swell, " : ""}water ${avg} Â°C`;
    v = best.score >= 0.70 ? "GO" : best.score >= 0.55 ? "DECENT" : best.score >= 0.40 ? "MARGINAL" : "SLOW";
  }
  const cls = { GO: "go", DECENT: "go", MARGINAL: "warn", SLOW: "warn", TOUGH: "bad" }[v] || "warn";
  verdictEl.className = "verdict " + cls;
  verdictEl.innerHTML = `<span class="v-word">${v}</span><span class="v-reason">${reason}</span>`;
}

function renderOcean(rows, moon) {
  const pool = rows.filter((r) => r.inRange).length ? rows.filter((r) => r.inRange) : rows;
  const ref = pool.reduce((a, b) => a.dist < b.dist ? a : b, pool[0]);
  const g = (f) => pool.map(f).filter((x) => x != null);
  const ssts = g((r) => r.m.sst), waves = g((r) => r.m.wave), winds = g((r) => r.w.wind), curr = g((r) => r.m.current);
  const range = (a, suf, nd = 1) => a.length ? `${Math.min(...a).toFixed(nd)}â€“${Math.max(...a).toFixed(nd)}${suf}` : "n/a";
  oceanEl.innerHTML = [
    ["Sea temp", range(ssts, " Â°C")],
    ["Swell", range(waves, " m")],
    ["Wind", `${range(winds, " km/h", 0)} ${compass(ref.w.windDir)}`],
    ["Pressure", `${fmt(ref.w.pressure, " hPa")}, ${trendWord(ref.w.trend)}`],
    ["Current", `~${curr.length ? (curr.reduce((a, b) => a + b, 0) / curr.length).toFixed(1) : "n/a"} km/h`],
    ["Moon", `${moon.phase}, ${moon.illumination_pct}%`],
    ["Solunar", `${moon.major_periods.join(" / ")} (approx)`],
  ].map(([k, val]) => `<div><span>${k}</span><b>${val}</b></div>`).join("");
}

document.getElementById("refresh").onclick = load;
document.getElementById("toggle-sight").onchange = (e) =>
  e.target.checked ? map.addLayer(sightLayer) : map.removeLayer(sightLayer);
load();
