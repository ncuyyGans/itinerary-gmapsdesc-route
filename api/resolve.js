// GET /api/resolve?url=<link Google Maps>
// 1. Mengikuti redirect link pendek (maps.app.goo.gl, goo.gl/maps, dll) secara server-side.
// 2. Mem-parse link rute (/maps/dir/... atau ?api=1&origin=&destination=) jadi daftar waypoint.
// 3. Mem-parse link tempat tunggal (@lat,lng, ?q=, data=!3d/!4d) jadi { name, lat, lng }.

const ALLOWED_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "www.google.com",
  "google.com",
  "maps.google.com",
  "www.google.co.id",
  "google.co.id",
]);

const UA = { "User-Agent": "Mozilla/5.0 (compatible; TemanJalan/1.0)" };

function parseLatLng(s) {
  if (!s) return null;
  const m = String(s)
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// "Monas, Jakarta" atau "-6.175,106.827" -> { name, lat?, lng? }
function toWaypoint(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const ll = parseLatLng(s);
  return ll ? { name: s, lat: ll.lat, lng: ll.lng } : { name: s };
}

function parsePlace(u) {
  // 1. @lat,lng,zoom
  let m = u.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m) {
    const q = u.searchParams.get("q") || u.searchParams.get("query");
    return { name: q ? decodeURIComponent(q) : null, lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  }
  // 2. ?q= / ?query=
  const q = u.searchParams.get("q") || u.searchParams.get("query");
  if (q) {
    const ll = parseLatLng(q);
    return ll
      ? { name: null, lat: ll.lat, lng: ll.lng }
      : { name: q, lat: null, lng: null };
  }
  // 3. data=!...!3dLAT!4dLNG
  m = u.href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) return { name: null, lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  return null;
}

function parseDir(u) {
  // Gaya 1: ?api=1&origin=..&destination=..&waypoints=a|b
  const origin = u.searchParams.get("origin");
  const destination = u.searchParams.get("destination");
  if (origin || destination) {
    const wps = [];
    const push = (v) => {
      const w = toWaypoint(v);
      if (w) wps.push(w);
    };
    push(origin);
    const via = u.searchParams.get("waypoints");
    if (via) via.split("|").forEach(push);
    push(destination);
    return wps.length ? wps : null;
  }
  // Gaya 2: /maps/dir/Asal/Tujuan[/...]
  const m = u.pathname.match(/\/maps\/dir\/([^?#]*)/);
  if (m) {
    const wps = m[1]
      .split("/")
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .filter((s) => s && !s.startsWith("@"))
      .map(toWaypoint)
      .filter(Boolean);
    return wps.length ? wps : null;
  }
  return null;
}

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Parameter 'url' tidak valid." });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "URL tidak bisa dibaca." });
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return res.status(400).json({ error: "Host URL tidak didukung. Pakai link Google Maps." });
  }

  try {
    let current = parsed.toString();
    for (let i = 0; i < 10; i++) {
      const r = await fetch(current, { redirect: "manual", headers: UA });
      const loc = r.headers.get("location");
      if (loc && [301, 302, 303, 307, 308].includes(r.status)) {
        current = new URL(loc, current).toString();
        continue;
      }
      break;
    }

    const u = new URL(current);
    const waypoints = parseDir(u);
    const place = waypoints ? null : parsePlace(u);

    return res.status(200).json({ resolved: current, waypoints, place });
  } catch (e) {
    return res.status(502).json({ error: "Gagal me-resolve link." });
  }
}
