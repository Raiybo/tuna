#!/usr/bin/env python3
"""Self-contained daily bait-likelihood hotspot generator for the public map.

No private code, no dependencies (stdlib only). Reads data/home.json, pulls the
same free satellite data as the engine, and writes data/hotspots.json. Run by
.github/workflows/refresh.yml every morning so the live map self-updates.

  SST break  : NOAA CoralTemp 5 km (oceanwatch ERDDAP)
  chlorophyll: NOAA S-NPP VIIRS    (oceanwatch ERDDAP)
  current    : Open-Meteo Marine

Hotspots = where bait (and therefore feeding tuna / birds) is most likely. This
is a PREDICTION of where to look, not a fish detector.
"""
from __future__ import annotations

import json
import math
import os
import ssl
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ERDDAP = "https://oceanwatch.pifsc.noaa.gov/erddap/griddap"
SEARCH_KM = 22.0
GRAD_KM = 7.0
N_HOTSPOTS = 6
MIN_SEP_KM = 4.0
_CTX = ssl.create_default_context()


def get_text(url, retries=3, timeout=60):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "tuna-map/1.0"})
            with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
                return r.read().decode("utf-8")
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


def get_json(url, retries=3, timeout=40):
    return json.loads(get_text(url, retries, timeout))


def km(lat1, lon1, lat2, lon2):
    dlat = (lat2 - lat1) * 111.0
    dlon = (lon2 - lon1) * 111.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dlat, dlon)


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def compass(d):
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][int((d + 11.25) % 360 // 22.5)]


def erddap_grid(dataset, var, has_alt, lat0, lat1, lon0, lon1):
    alt = "%5B0%5D" if has_alt else ""
    url = (f"{ERDDAP}/{dataset}.csv?{var}%5B(last)%5D{alt}"
           f"%5B({lat0}):({lat1})%5D%5B({lon0}):({lon1})%5D")
    lines = get_text(url).strip().splitlines()
    cols = lines[0].split(",")
    li, oi, vi = cols.index("latitude"), cols.index("longitude"), len(cols) - 1
    date, pts = None, []
    for row in lines[2:]:
        f = row.split(",")
        raw = f[vi].strip()
        if raw in ("", "NaN"):
            continue
        try:
            v = float(raw)
        except ValueError:
            continue
        if math.isnan(v):
            continue
        date = f[0][:10]
        pts.append({"lat": float(f[li]), "lon": float(f[oi]), "val": v})
    for p in pts:
        diffs = [abs(p["val"] - q["val"]) for q in pts
                 if q is not p and km(p["lat"], p["lon"], q["lat"], q["lon"]) <= GRAD_KM]
        p["grad"] = sum(diffs) / len(diffs) if diffs else 0.0
    return date, pts


def nearest(pts, lat, lon, max_km=6.0):
    best, bd = None, 1e9
    for p in pts:
        d = km(lat, lon, p["lat"], p["lon"])
        if d < bd:
            bd, best = d, p
    return (best, bd) if best and bd <= max_km else (None, None)


def fetch_currents(points):
    if not points:
        return []
    lats = ",".join(f"{p['lat']:.3f}" for p in points)
    lons = ",".join(f"{p['lon']:.3f}" for p in points)
    url = (f"https://marine-api.open-meteo.com/v1/marine?latitude={lats}&longitude={lons}"
           f"&current=ocean_current_velocity&timezone=auto")
    try:
        data = get_json(url, retries=2, timeout=40)
    except Exception:
        return [None] * len(points)
    if isinstance(data, dict):
        data = [data]
    return [d.get("current", {}).get("ocean_current_velocity") for d in data]


def front_score(g):
    return max(0.0, min(1.0, g / 0.12))


def chla_score(val, grad):
    if val is None:
        return None
    if val < 0.05:
        prod = 0.3
    elif val <= 0.6:
        prod = 1.0
    elif val <= 1.5:
        prod = 0.7
    else:
        prod = 0.45
    edge = max(0.0, min(1.0, (grad or 0.0) / 0.10))
    return 0.5 * prod + 0.5 * edge


def current_score(k):
    if k is None:
        return None
    if k < 0.3:
        return 0.4
    if k <= 2.5:
        return 1.0
    if k <= 5.0:
        return 0.7
    return 0.45


def main():
    with open(os.path.join(ROOT, "data", "home.json"), encoding="utf-8") as f:
        home = json.load(f)
    hlat, hlon = home["lat"], home["lon"]
    dlat = SEARCH_KM / 111.0
    dlon = SEARCH_KM / (111.0 * math.cos(math.radians(hlat)))

    sst_date, sst = erddap_grid("CRW_sst_v3_1", "analysed_sst", False,
                                hlat - dlat, hlat + dlat, hlon - dlon, hlon + 0.03)
    try:
        chl_date, chl = erddap_grid("noaa_snpp_chla_daily", "chlor_a", True,
                                    hlat - dlat, hlat + dlat, hlon - dlon, hlon + 0.03)
        if len(chl) < 6:
            chl_date, chl = erddap_grid("noaa_snpp_chla_weekly", "chlor_a", True,
                                        hlat - dlat, hlat + dlat, hlon - dlon, hlon + 0.03)
    except Exception:
        chl_date, chl = None, []

    cands = [p for p in sst
             if km(hlat, hlon, p["lat"], p["lon"]) <= SEARCH_KM and p["lon"] <= hlon + 0.02]
    currents = fetch_currents(cands)

    scored = []
    for p, cur in zip(cands, currents):
        cp, _ = nearest(chl, p["lat"], p["lon"]) if chl else (None, None)
        chl_v = cp["val"] if cp else None
        chl_g = cp["grad"] if cp else None
        terms = [(front_score(p["grad"]), 0.45)]
        c = chla_score(chl_v, chl_g)
        cu = current_score(cur)
        if c is not None:
            terms.append((c, 0.35))
        if cu is not None:
            terms.append((cu, 0.20))
        wsum = sum(w for _, w in terms)
        score = sum(v * w for v, w in terms) / wsum
        why = [f"SST break {p['grad']:.2f}C"]
        if chl_v is not None:
            why.append(f"chl {chl_v:.2f}")
        if cur is not None:
            why.append(f"current {cur:.1f} km/h")
        scored.append({
            "lat": round(p["lat"], 4), "lon": round(p["lon"], 4),
            "score": round(score, 3), "sst_c": round(p["val"], 1),
            "sst_break_c": round(p["grad"], 2),
            "chl": round(chl_v, 2) if chl_v is not None else None,
            "current_kmh": round(cur, 1) if cur is not None else None,
            "dist_nm": round(km(hlat, hlon, p["lat"], p["lon"]) / 1.852, 1),
            "heading": compass(bearing(hlat, hlon, p["lat"], p["lon"])),
            "why": ", ".join(why),
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    picks = []
    for s in scored:
        if all(km(s["lat"], s["lon"], q["lat"], q["lon"]) > MIN_SEP_KM for q in picks):
            picks.append(s)
        if len(picks) >= N_HOTSPOTS:
            break

    out = {
        "generated_utc_date": sst_date,
        "sst_source": f"NOAA CoralTemp 5km {sst_date}",
        "chl_source": f"NOAA VIIRS {chl_date}" if chl_date else "unavailable",
        "note": "Bait-likelihood prediction (SST break x chlorophyll x current). Where birds/frenzies "
                "are most likely - NOT a fish detector. Confirm the bust on-site.",
        "hotspots": picks,
    }
    with open(os.path.join(ROOT, "data", "hotspots.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(f"Wrote {len(picks)} hotspots (SST {sst_date}, chl {chl_date}).")


if __name__ == "__main__":
    main()
