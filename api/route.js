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

    // 3. POI via Overpass (coba beberapa mirror berurutan)
    let pois = [];
    const MIRRORS = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass.nchc.org.tw/api/interpreter",
    ];
    const query = overpassQuery(samples);
    for (const mirror of MIRRORS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const qr = await fetch(mirror, {
          method: "POST",
          headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!qr.ok) continue;
        const qj = await qr.json();
        if (!qj.elements) continue;
        const seen = new Set();
        for (const el of qj.elements || []) {
          const id = `${el.type}/${el.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const tags = el.tags || {};
          const kind = labelPoi(tags);
          if (!kind) continue;
          const plat = el.lat ?? el.center?.lat;
          const plng = el.lon ?? el.center?.lon;
          if (plat == null || plng == null) continue;
          // jarak & progres terhadap rute
          let best = { d: Infinity, km: 0 };
          for (const s of samples) {
            const d = haversineKm({ lat: plat, lng: plng }, s);
            if (d < best.d) best = { d, km: s.km };
          }
          if (best.d > 3) continue; // hanya yang dekat rute (<=3 km)
          pois.push({
            id,
            name: tags.name || kind.label,
            ...kind,
            lat: plat,
            lng: plng,
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
        if (pois.length) break; // sukses — tidak perlu coba mirror lain
      } catch {
        /* coba mirror berikutnya */
      }
    }

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
    });
  } catch (e) {
    return res.status(502).json({ error: e.message || "Gagal menghitung rute." });
  }
}
