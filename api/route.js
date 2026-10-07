// GET /api/route?stops=<JSON array>&konsumsi=<km/L>&harga=<Rp/L>
// stops: [{ name?, lat?, lng? }] — nama yang belum ada koordinatnya di-geocode via Nominatim.
// 1. Routing via OSRM (gratis).
// 2. POI di sepanjang rute via Overpass/OpenStreetMap: SPBU, masjid/mushola,
//    rest area, tempat makan, minimarket, ATM/bank, bengkel motor.
// 3. Estimasi BBM + saran titik istirahat.

const UA = { "User-Agent": "Mozilla/5.0 (compatible; TemanJalan/1.0)" };

function haversineKm(a, b) {
  const R = 6371;
  const dLa = ((b.lat - a.lat) * Math.PI) / 180;
  const dLn = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLa / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function geocode(name) {
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(
      name
    )}&accept-language=id`,
    { headers: UA }
  );
  if (!r.ok) throw new Error(`Geocode gagal untuk "${name}".`);
  const j = await r.json();
  if (!j.length) throw new Error(`Lokasi "${name}" tidak ditemukan.`);
  return { name, lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
}

// Ambil titik sampel tiap ~10 km (maks 40 titik) untuk query Overpass.
function sampleRoute(coords) {
  // coords: [[lng, lat], ...] dari OSRM
  const pts = coords.map(([lng, lat]) => ({ lat, lng }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineKm(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1] || 0;
  const step = Math.max(total / 40, 10); // km
  const samples = [{ ...pts[0], km: 0 }];
  let next = step;
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= next) {
      samples.push({ ...pts[i], km: cum[i] });
      next += step;
    }
  }
  samples.push({ ...pts[pts.length - 1], km: total });
  return { samples, totalKm: total };
}

function overpassQuery(samples) {
  const rules = [
    ["nwr", "amenity", "fuel"],
    ["nwr", "amenity", "place_of_worship"],
    ["nwr", "highway", "rest_area"],
    ["nwr", "amenity", "restaurant"],
    ["nwr", "amenity", "cafe"],
    ["nwr", "amenity", "fast_food"],
    ["nwr", "shop", "convenience"],
    ["nwr", "amenity", "atm"],
    ["nwr", "amenity", "bank"],
    ["nwr", "shop", "motorcycle"],
    ["nwr", "amenity", "vehicle_repair"],
  ];
  const arounds = samples
    .map((s) => rules.map(([t, k, v]) => `${t}(around:2500,${s.lat},${s.lng})["${k}"="${v}"];`).join("\n"))
    .join("\n");
  return `[out:json][timeout:60];\n(\n${arounds}\n);\nout center tags;`;
}

function labelPoi(tags) {
  const get = (k) => tags[k];
  if (get("amenity") === "fuel") return { cat: "spbu", label: "SPBU" };
  if (get("amenity") === "place_of_worship") {
    const rel = (get("religion") || "").toLowerCase();
    return rel === "muslim"
      ? { cat: "ibadah", label: "Masjid/Mushola" }
      : { cat: "ibadah", label: "Tempat Ibadah" };
  }
  if (get("highway") === "rest_area") return { cat: "rest", label: "Rest Area" };
  if (["restaurant", "cafe", "fast_food"].includes(get("amenity")))
    return { cat: "makan", label: "Tempat Makan" };
  if (get("shop") === "convenience") return { cat: "minimarket", label: "Minimarket" };
  if (["atm", "bank"].includes(get("amenity"))) return { cat: "atm", label: "ATM/Bank" };
  if (get("shop") === "motorcycle" || get("amenity") === "vehicle_repair")
    return { cat: "bengkel", label: "Bengkel Motor" };
  return null;
}

function fmtDur(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} jam ${m} mnt` : `${m} mnt`;
}

async function overpassPois(query, attempts) {
  const MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  for (const mirror of MIRRORS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const qr = await fetch(mirror, {
        method: "POST",
        headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!qr.ok) {
        attempts.push({ mirror, status: qr.status });
        continue;
      }
      const qj = await qr.json();
      if (!qj.elements) {
        attempts.push({ mirror, status: qr.status, noElements: true });
        continue;
      }
      attempts.push({ mirror, status: qr.status, elements: qj.elements.length });
      const out = [];
      for (const el of qj.elements) {
        const tags = el.tags || {};
        const kind = labelPoi(tags);
        if (!kind) continue;
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat == null || lng == null) continue;
        const t = { node: "n", way: "w", relation: "r" }[el.type] || "?";
        out.push({ id: `${t}/${el.id}`, name: tags.name || kind.label, ...kind, lat, lng });
      }
      if (out.length) return out;
    } catch (e) {
      attempts.push({ mirror, error: e.message || String(e) });
    }
  }
  return [];
}

const PHOTON_QUERIES = [
  { q: "SPBU", cat: "spbu", label: "SPBU" },
  { q: "masjid", cat: "ibadah", label: "Masjid/Mushola" },
  { q: "rest area", cat: "rest", label: "Rest Area" },
  { q: "rumah makan", cat: "makan", label: "Tempat Makan" },
  { q: "minimarket", cat: "minimarket", label: "Minimarket" },
  { q: "ATM", cat: "atm", label: "ATM/Bank" },
  { q: "bengkel motor", cat: "bengkel", label: "Bengkel Motor" },
];

async function photonPois(samples, attempts) {
  // sampel tiap ~30 km, maks 8 titik
  const picks = [];
  let next = 0;
  for (const s of samples) {
    if (s.km >= next) {
      picks.push(s);
      next += 30;
    }
  }
  if (!picks.length) picks.push(samples[0]);
  const tasks = [];
  for (const s of picks.slice(0, 8)) {
    for (const qq of PHOTON_QUERIES) tasks.push({ s, qq });
  }
  const out = [];
  let okCount = 0;
  for (let i = 0; i < tasks.length; i += 8) {
    const batch = tasks.slice(i, i + 8);
    const results = await Promise.allSettled(
      batch.map(async ({ s, qq }) => {
        const url =
          `https://photon.komoot.io/api/?q=${encodeURIComponent(qq.q)}` +
          `&lat=${s.lat}&lon=${s.lng}&limit=12`;
        const r = await fetch(url, { headers: UA });
        if (!r.ok) throw new Error(`photon ${r.status}`);
        const j = await r.json();
        return { feats: j.features || [], qq };
      })
    );
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      okCount++;
      const { feats, qq } = r.value;
      for (const f of feats) {
        const props = f.properties || {};
        const [lng, lat] = f.geometry.coordinates;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const t = (props.osm_type || "?")[0].toLowerCase();
        let { cat, label } = qq;
        if (cat === "ibadah") {
          const nm = (props.name || "").toLowerCase();
          if (/gereja|church/.test(nm)) label = "Gereja";
          else if (/pura/.test(nm)) label = "Pura";
          else if (/vihara|klenteng/.test(nm)) label = "Vihara/Klenteng";
        }
        out.push({ id: `${t}/${props.osm_id}`, name: props.name || label, cat, label, lat, lng });
      }
    }
  }
  attempts.push({ photon: true, queriesOk: okCount, raw: out.length });
  return out;
}

export default async function handler(req, res) {
  let stops;
  try {
    stops = JSON.parse(req.query.stops || "[]");
  } catch {
    return res.status(400).json({ error: "Parameter 'stops' bukan JSON valid." });
  }
  if (!Array.isArray(stops) || stops.length < 2) {
    return res.status(400).json({ error: "Minimal 2 titik: asal dan tujuan." });
  }

  const konsumsi = parseFloat(req.query.konsumsi) || 40; // km per liter
  const harga = parseFloat(req.query.harga) || 10000; // Rp per liter

  try {
    // 1. Geocode titik yang belum punya koordinat
    const pts = [];
    for (const s of stops.slice(0, 10)) {
      if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
        pts.push({ name: s.name || `${s.lat},${s.lng}`, lat: s.lat, lng: s.lng });
      } else if (s.name) {
        pts.push(await geocode(s.name));
      }
    }
    if (pts.length < 2) {
      return res.status(400).json({ error: "Titik asal/tujuan tidak bisa dikenali." });
    }

    // Label yang enak dibaca untuk titik koordinat mentah (best-effort)
    for (const p of pts) {
      if (!p.name || /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(p.name)) {
        try {
          const rr = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lng}&zoom=14&accept-language=id`,
            { headers: UA }
          );
          const jj = await rr.json();
          const a = jj.address || {};
          p.name =
            a.road || a.suburb || a.village || a.town || a.city || a.county ||
            (jj.display_name ? jj.display_name.split(",").slice(0, 2).join(",") : null) ||
            `${p.lat},${p.lng}`;
        } catch {
          p.name = `${p.lat},${p.lng}`;
        }
      }
    }

    // 2. Routing OSRM
    const coordStr = pts.map((p) => `${p.lng},${p.lat}`).join(";");
    const osrmUrl =
      `https://router.project-osrm.org/route/v1/driving/${coordStr}` +
      `?overview=full&geometries=geojson`;
    const or = await fetch(osrmUrl, { headers: UA });
    if (!or.ok) throw new Error("Layanan rute (OSRM) sedang bermasalah. Coba lagi.");
    const oj = await or.json();
    const route = oj.routes?.[0];
    if (!route) throw new Error("Rute tidak ditemukan.");

    const distanceKm = route.distance / 1000;
    const durationMin = route.duration / 60;
    const { samples, totalKm } = sampleRoute(route.geometry.coordinates);

    // 3. POI di sepanjang rute: Overpass + Photon (paralel, digabung & dedupe)
    const attempts = [];
    const [overpassRes, photonRes] = await Promise.allSettled([
      overpassPois(overpassQuery(samples), attempts),
      photonPois(samples, attempts),
    ]);
    const raw = [];
    for (const r of [overpassRes, photonRes]) {
      if (r.status === "fulfilled") raw.push(...r.value);
    }
    const seen = new Set();
    let pois = [];
    for (const p of raw) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      let best = { d: Infinity, km: 0 };
      for (const s of samples) {
        const d = haversineKm({ lat: p.lat, lng: p.lng }, s);
        if (d < best.d) best = { d, km: s.km };
      }
      if (best.d > 3) continue; // hanya yang dekat rute (<=3 km)
      pois.push({
        ...p,
        distFromRouteKm: Math.round(best.d * 10) / 10,
        routeKm: Math.round(best.km),
      });
    }
    // urut per kategori lalu progres rute; batasi 8 per kategori
    const byCat = {};
    for (const p of pois.sort((a, b) => a.routeKm - b.routeKm)) {
      (byCat[p.cat] = byCat[p.cat] || []).push(p);
    }
    pois = Object.values(byCat).flatMap((arr) => arr.slice(0, 8));

    // 4. Estimasi BBM
    const fuelL = distanceKm / konsumsi;
    const fuelRp = fuelL * harga;

    // 5. Saran istirahat tiap 100 km: cari POI rest/ibadah/spbu terdekat
    const restStops = [];
    for (let km = 100; km < totalKm; km += 100) {
      const cand = pois
        .filter((p) => ["rest", "ibadah", "spbu"].includes(p.cat))
        .sort((a, b) => Math.abs(a.routeKm - km) - Math.abs(b.routeKm - km))[0];
      if (cand) restStops.push({ atKm: km, poi: cand });
    }

    // Geometri disederhanakan untuk peta (maks 400 titik)
    const geom = route.geometry.coordinates.filter(
      (_, i, a) => a.length <= 400 || i % Math.ceil(a.length / 400) === 0
    );

    return res.status(200).json({
      stops: pts,
      distanceKm: Math.round(distanceKm * 10) / 10,
      duration: fmtDur(durationMin),
      durationMin: Math.round(durationMin),
      fuel: {
        konsumsi,
        harga,
        liter: Math.round(fuelL * 10) / 10,
        rupiah: Math.round(fuelRp),
      },
      geometry: geom,
      pois,
      restStops,
      warnings: [
        "Rute dihitung untuk kendaraan roda 4 — motor dilarang masuk jalan tol. Periksa rambu di jalan.",
        "Waktu tempuh tanpa memperhitungkan macet & kondisi jalan.",
      ],
      ...(req.query.debug === "1" ? { poiDebug: attempts } : {}),
    });
  } catch (e) {
    return res.status(502).json({ error: e.message || "Gagal menghitung rute." });
  }
}
