// GET /api/place?q=<nama>&lat=<lat>&lng=<lng>
// Menggabungkan: Foursquare (detail + rating + tips/ulasan), OpenStreetMap/Nominatim
// (alamat & jam buka), Wikipedia (ringkasan). Tips dipilah otomatis menjadi
// Kelebihan vs Kekurangan berdasarkan kata kunci (ID + EN).
//
// API key Foursquare dibaca dari env FOURSQUARE_API_KEY (JANGAN di-commit).
// Tanpa key: tetap mengembalikan info dasar dari OSM + Wikipedia dengan flag needsKey.

const UA = { "User-Agent": "Mozilla/5.0 (compatible; TemanJalan/1.0)" };
// API baru Foursquare (v3 api.foursquare.com deprecated Mei 2026):
// host places-api.foursquare.com, auth "Bearer <key>", header versi wajib.
const FSQ = "https://places-api.foursquare.com/places";
const FSQ_VERSION = "2025-06-17";

const POSITIVE = [
  // Indonesia
  "bagus", "enak", "nyaman", "bersih", "rapi", "ramah", "murah", "mantap", "keren",
  "luas", "sejuk", "adem", "tenang", "indah", "puas", "cepat", "lengkap", "lengkap",
  "terbaik", "luar biasa", "wajib", "suka", "recommended", "rekomended", "rekomendasi",
  "asyik", "seru", "oke banget", "top", "juara", "bersahabat", "strategis", "estetik",
  "instagramable", "murmer", "worth", "bintang lima",
  // English
  "good", "great", "excellent", "awesome", "amazing", "nice", "clean", "comfortable",
  "friendly", "cheap", "affordable", "beautiful", "spacious", "cozy", "love", "loved",
  "perfect", "wonderful", "fantastic", "best", "quiet", "tasty", "delicious",
  "stunning", "breathtaking", "must-see", "worth visiting", "impressive",
];

const NEGATIVE = [
  // Indonesia
  "jelek", "buruk", "kotor", "jorok", "mahal", "sempit", "macet", "antre", "antri",
  "lama", "lambat", "lemot", "kecewa", "jangan", "rugi", "bau", "bising", "berisik",
  "panas", "sumpek", "pengap", "rusak", "tutup", "susah", "sulit", "kapok",
  "parkir susah", "parkir sulit", "tidak recommended", "nggak recommended",
  "mending", "skip", "zonk", "overpriced", "tidak ramah", "judes", "cuek",
  "kecil banget", "sempit banget", "pelayanan buruk", "berbahaya", "awas", "penipuan",
  // English
  "bad", "terrible", "awful", "dirty", "expensive", "overpriced", "slow", "rude",
  "crowded", "overcrowded", "noisy", "loud", "cramped", "disappointing", "disappointed",
  "avoid", "worst", "poor", "horrible", "smelly", "broken", "closed",
  "dangerous", "warning", "beware", "prohibited", "forbidden", "scam", "pickpocket",
];

const NEGATIONS = [
  "not", "no", "never", "n't", "cannot", "can't", "won't", "don't", "doesn't",
  "didn't", "isn't", "aren't", "wasn't", "weren't", "hasn't", "haven't",
  "couldn't", "shouldn't", "tidak", "tak", "bukan", "jangan", "kurang",
  "belum", "tanpa",
];

function scoreTip(text) {
  const words = text
    .toLowerCase()
    .split(/[^a-z'’]+/)
    .filter(Boolean);
  let pos = 0;
  let neg = 0;
  const posHits = [];
  const negHits = [];
  const scan = (list, isPositive) => {
    for (const kw of list) {
      const kwWords = kw.toLowerCase().split(" ");
      for (let i = 0; i <= words.length - kwWords.length; i++) {
        let ok = true;
        for (let k = 0; k < kwWords.length; k++) {
          if (words[i + k] !== kwWords[k]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        // negasi dalam 3 kata sebelumnya membalik polaritas ("not good", "tidak enak")
        let negated = false;
        for (let j = Math.max(0, i - 3); j < i; j++) {
          if (NEGATIONS.includes(words[j])) {
            negated = true;
            break;
          }
        }
        const label = (negated ? "¬" : "") + kw;
        if (isPositive === !negated) {
          pos++;
          if (posHits.length < 3) posHits.push(label);
        } else {
          neg++;
          if (negHits.length < 3) negHits.push(label);
        }
        break; // tiap keyword dihitung sekali per teks
      }
    }
  };
  scan(POSITIVE, true);
  scan(NEGATIVE, false);
  return { pos, neg, posHits, negHits };
}

function snippet(text, max = 160) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

// Wikivoyage: panduan traveler gratis (tanpa key/kartu), bahasanya jujur soal plus-minus.
async function wikivoyageGuide(q) {
  try {
    const s = await fetch(
      `https://en.wikivoyage.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        q
      )}&format=json&srlimit=3&origin=*`,
      { headers: UA }
    );
    const hits = (await s.json())?.query?.search || [];
    if (!hits.length) return null;
    const title = hits[0].title;
    const e = await fetch(
      `https://en.wikivoyage.org/w/api.php?action=query&prop=extracts&explaintext=1&titles=${encodeURIComponent(
        title
      )}&format=json&origin=*`,
      { headers: UA }
    );
    const pages = (await e.json())?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page?.extract || page.extract.length < 200) return null;
    return {
      title,
      text: page.extract.slice(0, 4000),
      url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    };
  } catch {
    return null;
  }
}

// Pecah teks jadi kalimat, pilah pro/kontra pakai skor kata kunci.
function prosConsFromText(text, maxEach = 3) {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 400);
  const scored = sentences.map((t) => ({ text: t, ...scoreTip(t) }));
  const pros = scored
    .filter((s) => s.pos > s.neg)
    .sort((a, b) => b.pos - a.pos)
    .slice(0, maxEach)
    .map((s) => ({ text: snippet(s.text), keywords: s.posHits }));
  const cons = scored
    .filter((s) => s.neg > s.pos)
    .sort((a, b) => b.neg - a.neg)
    .slice(0, maxEach)
    .map((s) => ({ text: snippet(s.text), keywords: s.negHits }));
  return { pros, cons };
}

async function fsq(path, key) {
  const r = await fetch(FSQ + path, {
    headers: {
      ...UA,
      Authorization: `Bearer ${key}`,
      "X-Places-Api-Version": FSQ_VERSION,
      Accept: "application/json",
    },
  });
  if (r.status === 401 || r.status === 403) {
    const e = new Error("API key Foursquare ditolak (401/403).");
    e.code = "FSQ_AUTH";
    throw e;
  }
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    const e = new Error(`Foursquare error ${r.status}: ${body}`);
    e.code = "FSQ_ERR";
    throw e;
  }
  return r.json();
}

async function nominatimReverse(lat, lng) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=id`,
      { headers: UA }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j.display_name || null;
  } catch {
    return null;
  }
}

async function wikipediaSummary(q) {
  // Coba Wikipedia Bahasa Indonesia dulu, fallback ke Inggris.
  for (const lang of ["id", "en"]) {
    try {
      const s = await fetch(
        `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
          q
        )}&format=json&srlimit=1&origin=*`,
        { headers: UA }
      );
      const sj = await s.json();
      const hit = sj?.query?.search?.[0];
      if (!hit) continue;
      const p = await fetch(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
          hit.title.replace(/ /g, "_")
        )}`,
        { headers: UA }
      );
      const pj = await p.json();
      if (pj.extract && pj.type !== "disambiguation") {
        return { text: pj.extract, url: pj.content_urls?.desktop?.page || null, lang };
      }
    } catch {
      /* lanjut */
    }
  }
  return null;
}

function mapsLink(name, lat, lng) {
  const q = lat != null && lng != null ? `${lat},${lng}` : name;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export default async function handler(req, res) {
  const { q, lat, lng } = req.query;
  const name = (q || "").toString().trim();
  const la = parseFloat(lat);
  const ln = parseFloat(lng);
  const hasLL = Number.isFinite(la) && Number.isFinite(ln);

  if (!name && !hasLL) {
    return res.status(400).json({ error: "Isi nama tempat atau koordinat." });
  }

  const key = process.env.FOURSQUARE_API_KEY;
  const result = {
    name: name || null,
    lat: hasLL ? la : null,
    lng: hasLL ? ln : null,
    needsKey: !key,
    source: [],
  };

  // ---- Foursquare: cari -> detail -> tips ----
  let dbg = null;
  if (key) {
    try {
      const ll = hasLL ? `&ll=${la},${ln}` : "";
      const search = await fsq(
        `/search?query=${encodeURIComponent(name || "tempat")}${ll}&limit=5`,
        key
      );
      const candidates = search.results || [];
      if (candidates.length) {
        const best = candidates[0];
        const id = best.fsq_place_id || best.fsq_id;
        const [detail, tipsRaw] = await Promise.all([
          fsq(
            `/${id}?fields=` +
              `fsq_place_id,name,latitude,longitude,location,extended_location,categories,` +
              `rating,stats,hours,price,tel,website,social_media,description`,
            key
          ).catch((e) => ({ _err: String(e.message || e) })),
          fsq(`/${id}/tips?limit=30`, key).catch((e) => ({ _err: String(e.message || e) })),
        ]);
        if (req.query.debug === "1") {
          dbg = {
            detailKeys: detail && !detail._err ? Object.keys(detail).slice(0, 40) : detail,
            ratingRaw: detail?.rating,
            statsRaw: detail?.stats,
            hoursRaw: typeof detail?.hours,
            tipsErr: tipsRaw?._err || null,
            tipsLen: Array.isArray(tipsRaw) ? tipsRaw.length : (tipsRaw?.results || []).length,
            tipsSample: (Array.isArray(tipsRaw) ? tipsRaw : tipsRaw?.results || []).slice(0, 1),
          };
        }
        const d = detail || best;
        const geo = { latitude: d.latitude ?? d.geocodes?.main?.latitude, longitude: d.longitude ?? d.geocodes?.main?.longitude };
        result.name = d.name || result.name;
        result.lat = geo.latitude ?? result.lat;
        result.lng = geo.longitude ?? result.lng;
        result.address =
          d.location?.formatted_address ||
          [d.location?.address, d.location?.locality, d.location?.region]
            .filter(Boolean)
            .join(", ") ||
          null;
        result.categories = (d.categories || []).map((c) => c.name);
        result.rating = d.rating ?? null; // skala 10
        result.ratingCount = d.stats?.total_ratings ?? null;
        result.price = d.price ?? null; // 1-4
        result.tel = d.tel || null;
        result.website = d.website || null;
        result.hours = d.hours?.display || null;
        result.description = d.description || null;
        result.fsqId = id;
        result.source.push("Foursquare");

        const tips = (Array.isArray(tipsRaw) ? tipsRaw : tipsRaw.results || [])
          .map((t) => (typeof t === "string" ? t : t.text))
          .filter((t) => t && t.trim().length > 3);

        const scored = tips.map((text) => ({ text, ...scoreTip(text) }));
        const pros = scored
          .filter((s) => s.pos > s.neg)
          .sort((a, b) => b.pos - a.pos || b.text.length - a.text.length)
          .slice(0, 4);
        const cons = scored
          .filter((s) => s.neg > s.pos)
          .sort((a, b) => b.neg - a.neg || b.text.length - a.text.length)
          .slice(0, 4);

        result.pros = pros.map((s) => ({ text: snippet(s.text), keywords: s.posHits }));
        result.cons = cons.map((s) => ({ text: snippet(s.text), keywords: s.negHits }));
        result.tipsCount = tips.length;
        result.sampleTips = scored.slice(0, 3).map((s) => snippet(s.text, 200));
      }
    } catch (e) {
      if (e.code === "FSQ_AUTH") {
        return res.status(502).json({
          error: "API key Foursquare ditolak. Cek kembali key di env FOURSQUARE_API_KEY.",
        });
      }
      result.fsqError = e.message;
    }
  }

  // ---- Fallback/pelengkap: OSM reverse geocode untuk alamat ----
  if (!result.address && hasLL) {
    const addr = await nominatimReverse(la, ln);
    if (addr) {
      result.address = addr;
      result.source.push("OpenStreetMap");
    }
  }

  // ---- Wikipedia: ringkasan ----
  if (result.name) {
    const wiki = await wikipediaSummary(result.name);
    if (wiki) {
      result.summary = wiki.text;
      result.summaryUrl = wiki.url;
      result.source.push("Wikipedia");
    }
  }

  // ---- Wikivoyage: pro/kontra gratis dari panduan traveler ----
  if ((!result.pros || !result.pros.length) && (!result.cons || !result.cons.length) && result.name) {
    const guide = await wikivoyageGuide(result.name);
    if (guide) {
      const pc = prosConsFromText(guide.text);
      if (pc.pros.length || pc.cons.length) {
        result.pros = pc.pros;
        result.cons = pc.cons;
        result.pcSource = `panduan traveler (Wikivoyage: ${guide.title})`;
        result.pcUrl = guide.url;
        if (!result.source.includes("Wikivoyage")) result.source.push("Wikivoyage");
      }
    }
  }
  if (!result.pcSource && result.tipsCount) {
    result.pcSource = `${result.tipsCount} ulasan pengguna (Foursquare)`;
  }

  result.mapsUrl = mapsLink(result.name || name, result.lat, result.lng);
  if (dbg) result._debug = dbg;

  if (!result.source.includes("Foursquare") && !result.address && !result.summary) {
    return res.status(404).json({
      error: "Tempat tidak ditemukan.",
      needsKey: result.needsKey,
      hint: result.needsKey
        ? "Pasang API key Foursquare di env FOURSQUARE_API_KEY untuk hasil terbaik."
        : "Coba dengan nama yang lebih spesifik atau tempel link Google Maps-nya.",
    });
  }

  return res.status(200).json(result);
}
