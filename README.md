# 🧭 TemanJalan

Web app itinerary + deskripsi jujur tempat + perencana rute buat anak motor & solo traveler.
**100% gratis** — tanpa kartu kredit, tanpa Google Maps Platform API key.

Live: *(isi setelah deploy ke Vercel)*

## Fitur

1. **📍 Deskripsi Tempat** — tempel link Google Maps / ketik nama tempat → profil, ringkasan (Wikipedia),
   info praktis (alamat, jam buka, telp, website), rating, plus **Kelebihan vs Kekurangan** dari ulasan
   pengguna asli (dipilah otomatis, bukan cuma yang bagus-bagus).
2. **🛣️ Perencana Rute** — tempel link rute Google Maps yang dibagikan (atau isi manual A → B + singgahan) →
   estimasi jarak, waktu, **BBM (liter & rupiah)**, peta rute, **SPBU, masjid/mushola, rest area,
   tempat makan, minimarket, ATM, bengkel motor** di sepanjang rute, + saran titik istirahat tiap 100 km.
3. **🗓️ Itinerary** — susun per hari, tambah dari tab lain / tulis manual, atur jam, simpan otomatis di HP
   (localStorage), ekspor JSON, bagikan via link, impor kembali.

## Sumber data (semua gratis)

| Kebutuhan | Layanan |
|---|---|
| Detail tempat, rating, tips/ulasan | Foursquare Places API (key gratis, daftar pakai email, tanpa kartu kredit) |
| Alamat & jam buka | OpenStreetMap / Nominatim |
| Ringkasan tempat terkenal | Wikipedia API |
| Routing | OSRM (demo server) |
| SPBU, masjid, rest area, dll di rute | Overpass API (OpenStreetMap) |
| Peta | Leaflet + tile OpenStreetMap |

> Catatan jujur: rute dihitung untuk kendaraan roda 4 (OSRM) — motor dilarang masuk tol.
> Selalu periksa rambu di jalan. Waktu tempuh belum termasuk macet.

## Cara jalan lokal / deploy

Tanpa build step — file statis + serverless function, siap deploy ke Vercel.

```bash
# pasang API key Foursquare (JANGAN di-commit!)
# di Vercel: Project → Settings → Environment Variables → tambah FOURSQUARE_API_KEY
```

Struktur:

```
index.html  style.css  app.js      # frontend 3 tab (mobile-first)
api/
  resolve.js  # resolve link pendek Google Maps + parse link rute
  place.js    # agregator info tempat + pilah pro/kontra
  route.js    # routing OSRM + POI Overpass + estimasi BBM
vercel.json
```

## Env var

- `FOURSQUARE_API_KEY` — wajib untuk fitur ulasan/rating tempat. Tanpa ini, tab Tempat tetap jalan
  dengan info dasar (OSM + Wikipedia) dan menampilkan peringatan.

## Lisensi

Bebas pakai.
