/* TemanJalan — frontend: 3 tab (Tempat, Rute, Itinerary) */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtRp = (n) => "Rp" + Math.round(n).toLocaleString("id-ID");

/* ---------- tab ---------- */
$$(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    $$(".panel").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $("#tab-" + b.dataset.tab).classList.add("active");
  })
);
function gotoTab(name) {
  $(`.tab[data-tab="${name}"]`).click();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ================================================================
   TAB 1 — DESKRIPSI TEMPAT
================================================================ */
async function searchPlace() {
  const input = $("#place-input").value.trim();
  if (!input) return;
  $("#place-loading").classList.remove("hidden");
  $("#place-error").classList.add("hidden");
  $("#place-result").innerHTML = "";
  try {
    let q = input, lat = null, lng = null;
    if (/^https?:\/\//i.test(input)) {
      const r = await fetch("/api/resolve?url=" + encodeURIComponent(input));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Link tidak bisa dibaca.");
      if (j.place) {
        q = j.place.name || ""; lat = j.place.lat; lng = j.place.lng;
      } else if (j.waypoints?.length) {
        throw new Error("Itu link rute, bukan tempat. Pakai tab 🛣️ Rute ya.");
      } else {
        throw new Error("Tidak ada info tempat di link itu.");
      }
    }
    const params = new URLSearchParams({ q });
    if (lat != null) params.set("lat", lat);
    if (lng != null) params.set("lng", lng);
    const r = await fetch("/api/place?" + params);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Tempat tidak ditemukan.");
    renderPlace(j);
  } catch (e) {
    const box = $("#place-error");
    box.textContent = e.message;
    box.classList.remove("hidden");
  } finally {
    $("#place-loading").classList.add("hidden");
  }
}

function renderPlace(p) {
  const cats = (p.categories || []).map((c) => `<span class="chip">${esc(c)}</span>`).join("");
  const rating = p.rating != null
    ? `<div class="rating">⭐ ${esc(p.rating.toFixed(1))}<span style="font-weight:400;font-size:.85rem;color:var(--muted)">/10${p.ratingCount ? ` · ${esc(p.ratingCount)} ulasan` : ""}</span></div>`
    : `<div class="meta">Belum ada rating.</div>`;
  const price = p.price ? " · " + "💰".repeat(Math.min(p.price, 4)) : "";
  const pros = (p.pros || []).map((x) => `<li>${esc(x.text)}<br>${(x.keywords || []).map((k) => `<span class="kw">+${esc(k)}</span>`).join("")}</li>`).join("");
  const cons = (p.cons || []).map((x) => `<li>${esc(x.text)}<br>${(x.keywords || []).map((k) => `<span class="kw">−${esc(k)}</span>`).join("")}</li>`).join("");
  const hasPC = pros || cons;
  const tips = (p.sampleTips || []).map((t) => `<li>“${esc(t)}”</li>`).join("");

  $("#place-result").innerHTML = `
    <div class="place-head" style="margin-top:14px">
      <h3>${esc(p.name || "Tempat")}</h3>
      ${rating}
      <div class="chips">${cats}</div>
      ${p.address ? `<div class="meta">📍 ${esc(p.address)}${price}</div>` : ""}
      ${p.hours ? `<div class="meta">🕐 ${esc(p.hours)}</div>` : ""}
      ${p.tel ? `<div class="meta">📞 <a href="tel:${esc(p.tel)}">${esc(p.tel)}</a></div>` : ""}
      ${p.website ? `<div class="meta">🌐 <a href="${esc(p.website)}" target="_blank" rel="noopener">Website</a></div>` : ""}
    </div>
    ${p.needsKey ? `<div class="keywarn">⚠️ API key Foursquare belum dipasang di server, jadi ulasan & rating belum tampil. Info dasar di bawah tetap bisa dipakai.</div>` : ""}
    ${p.summary ? `<div class="summary"><b>Tentang:</b> ${esc(p.summary)} ${p.summaryUrl ? `<a href="${esc(p.summaryUrl)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}</div>` : ""}
    ${hasPC ? `
    <div class="proscons">
      <div class="pros"><h4>✅ Kelebihan</h4><ul>${pros || "<li>—</li>"}</ul></div>
      <div class="cons"><h4>❌ Kekurangan</h4><ul>${cons || "<li>—</li>"}</ul></div>
    </div>
    <div class="meta">Sumber pro/kontra: ${esc(p.pcSource || "ulasan pengguna")}${p.pcUrl ? ` · <a href="${esc(p.pcUrl)}" target="_blank" rel="noopener">baca panduan ↗</a>` : ""}${p.source?.length ? ` · data: ${esc(p.source.join(", "))}` : ""}.</div>` : ""}
    ${tips ? `<ul class="tips">${tips}</ul>` : ""}
    <div class="row mt">
      <button class="btn ghost sm" id="place-to-it">＋ Itinerary</button>
      <a class="btn ghost sm" href="${esc(p.mapsUrl)}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">🗺️ Google Maps</a>
    </div>`;

  $("#place-to-it").onclick = () =>
    addToItinerary({
      type: "tempat",
      title: p.name,
      detail: [p.address, p.rating != null ? `⭐ ${p.rating.toFixed(1)}/10` : null].filter(Boolean).join(" · "),
    });
}
$("#place-btn").addEventListener("click", searchPlace);
$("#place-input").addEventListener("keydown", (e) => { if (e.key === "Enter") searchPlace(); });

/* ================================================================
   TAB 2 — RUTE
================================================================ */
const fuelStore = {
  get k() { return parseFloat(localStorage.getItem("tj-konsumsi")) || 45; },
  get h() { return parseFloat(localStorage.getItem("tj-harga")) || 10000; },
};
$("#fuel-konsumsi").value = fuelStore.k;
$("#fuel-harga").value = fuelStore.h;

$("#add-stop").addEventListener("click", () => {
  const div = document.createElement("div");
  div.className = "row mb";
  div.innerHTML = `<input class="stop-input" type="text" placeholder="Singgahan…">`;
  $("#route-stops").appendChild(div);
});

let routeMap = null;
const CAT_COLOR = { spbu: "#dc2626", ibadah: "#16a34a", rest: "#2563eb", makan: "#ea580c", minimarket: "#9333ea", atm: "#0d9488", bengkel: "#4b5563" };
const CAT_ICON = { spbu: "⛽", ibadah: "🕌", rest: "☕", makan: "🍜", minimarket: "🏪", atm: "🏧", bengkel: "🔧" };

async function calcRoute() {
  $("#route-loading").classList.remove("hidden");
  $("#route-error").classList.add("hidden");
  $("#route-result").innerHTML = "";
  try {
    let stops = [];
    const link = $("#route-link").value.trim();
    if (link) {
      const r = await fetch("/api/resolve?url=" + encodeURIComponent(link));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Link rute tidak bisa dibaca.");
      if (!j.waypoints?.length) throw new Error("Link itu bukan rute. Tempel link rute (Bagikan → rute) atau isi manual.");
      stops = j.waypoints;
    } else {
      stops = $$(".stop-input").map((i) => ({ name: i.value.trim() })).filter((s) => s.name);
      if (stops.length < 2) throw new Error("Isi minimal titik asal dan tujuan.");
    }
    const konsumsi = parseFloat($("#fuel-konsumsi").value) || 45;
    const harga = parseFloat($("#fuel-harga").value) || 10000;
    localStorage.setItem("tj-konsumsi", konsumsi);
    localStorage.setItem("tj-harga", harga);

    const r = await fetch("/api/route?" + new URLSearchParams({
      stops: JSON.stringify(stops), konsumsi, harga,
    }));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Gagal menghitung rute.");
    renderRoute(j);
  } catch (e) {
    const box = $("#route-error");
    box.textContent = e.message;
    box.classList.remove("hidden");
  } finally {
    $("#route-loading").classList.add("hidden");
  }
}

function renderRoute(j) {
  const groups = {};
  for (const p of j.pois) (groups[p.cat] = groups[p.cat] || []).push(p);
  const groupHtml = Object.entries(groups).map(([cat, arr]) => `
    <div class="poi-group"><h4>${CAT_ICON[cat] || "📍"} ${esc(arr[0].label)} (${arr.length})</h4>
    ${arr.map((p) => `<div class="poi"><span><b>${esc(p.name)}</b></span><span class="d">km ${p.routeKm} · +${p.distFromRouteKm} km</span></div>`).join("")}
    </div>`).join("");

  $("#route-result").innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="v">${esc(j.distanceKm)} km</div><div class="l">Jarak</div></div>
      <div class="stat"><div class="v">${esc(j.duration)}</div><div class="l">Waktu tempuh</div></div>
      <div class="stat"><div class="v">${esc(j.fuel.liter)} L</div><div class="l">Estimasi BBM</div></div>
      <div class="stat"><div class="v">${fmtRp(j.fuel.rupiah)}</div><div class="l">Biaya BBM</div></div>
    </div>
    ${(j.warnings || []).map((w) => `<div class="warn">⚠️ ${esc(w)}</div>`).join("")}
    <div id="route-map"></div>
    ${j.restStops.length ? `<h4 style="margin:12px 0 4px">😴 Saran istirahat</h4>` + j.restStops.map((s) =>
      `<div class="rest-item">Di km ±${s.atKm}: <b>${esc(s.poi.name)}</b> (${esc(s.poi.label)})</div>`).join("") : ""}
    <h4 style="margin:14px 0 4px">📍 Di sepanjang rute</h4>
    ${groupHtml || `<p class="hint">Tidak ada POI ditemukan di dekat rute.</p>`}
    <div class="row mt"><button class="btn ghost sm" id="route-to-it">＋ Itinerary</button></div>`;

  // peta
  if (routeMap) { routeMap.remove(); routeMap = null; }
  const latlngs = j.geometry.map(([lng, lat]) => [lat, lng]);
  routeMap = L.map("route-map");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19,
  }).addTo(routeMap);
  L.polyline(latlngs, { color: "#0e7c5b", weight: 5 }).addTo(routeMap);
  const [s0, s1] = [j.stops[0], j.stops[j.stops.length - 1]];
  L.marker([s0.lat, s0.lng]).addTo(routeMap).bindPopup("Start: " + esc(s0.name));
  L.marker([s1.lat, s1.lng]).addTo(routeMap).bindPopup("Finish: " + esc(s1.name));
  for (const p of j.pois) {
    L.marker([p.lat, p.lng], {
      icon: L.divIcon({
        className: "", html: `<div style="background:${CAT_COLOR[p.cat]};color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:13px;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)">${CAT_ICON[p.cat] || "📍"}</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12],
      }),
    }).addTo(routeMap).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.label)} · km ${p.routeKm}`);
  }
  routeMap.fitBounds(L.latLngBounds(latlngs));

  $("#route-to-it").onclick = () =>
    addToItinerary({
      type: "rute",
      title: `${s0.name} → ${s1.name}`,
      detail: `${j.distanceKm} km · ${j.duration} · BBM ±${j.fuel.liter} L (${fmtRp(j.fuel.rupiah)})`,
    });
}
$("#route-btn").addEventListener("click", calcRoute);

/* ================================================================
   TAB 3 — ITINERARY (localStorage)
================================================================ */
const LS_KEY = "temanjalan-itinerary-v1";
function loadIt() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY));
    if (Array.isArray(j) && j.length) return j;
  } catch { /* abaikan */ }
  return [{ title: "Hari 1", items: [] }];
}
let itinerary = loadIt();
function saveIt() { localStorage.setItem(LS_KEY, JSON.stringify(itinerary)); }

function renderItinerary() {
  const box = $("#itinerary-days");
  box.innerHTML = "";
  itinerary.forEach((day, di) => {
    const d = document.createElement("div");
    d.className = "day";
    d.innerHTML = `
      <div class="day-head">
        <input type="text" value="${esc(day.title)}" data-day-title="${di}">
        <button class="icon-btn" data-day-del="${di}" title="Hapus hari">🗑️</button>
      </div>
      <div data-items="${di}"></div>
      <div class="add-note-row">
        <input type="text" placeholder="Tambah catatan…" data-note="${di}">
        <button class="btn ghost sm" data-note-add="${di}">＋</button>
      </div>`;
    const itemsBox = $("[data-items='" + di + "']", d);
    day.items.forEach((it, ii) => {
      const row = document.createElement("div");
      row.className = "it-item";
      row.innerHTML = `
        <input type="time" value="${esc(it.time || "")}" data-time="${di}:${ii}">
        <div class="grow"><div class="t">${esc(it.title)}</div><div class="d">${esc(it.detail || "")}</div></div>
        <button class="icon-btn" data-up="${di}:${ii}" title="Naik">⬆️</button>
        <button class="icon-btn" data-down="${di}:${ii}" title="Turun">⬇️</button>
        <button class="icon-btn" data-del="${di}:${ii}" title="Hapus">✕</button>`;
      itemsBox.appendChild(row);
    });
    box.appendChild(d);
  });

  // events
  $$("[data-day-title]").forEach((i) => i.addEventListener("change", () => {
    itinerary[+i.dataset.dayTitle].title = i.value.trim() || "Hari"; saveIt();
  }));
  $$("[data-day-del]").forEach((b) => b.addEventListener("click", () => {
    if (itinerary.length <= 1 || confirm("Hapus hari ini?")) { itinerary.splice(+b.dataset.dayDel, 1); saveIt(); renderItinerary(); }
  }));
  $$("[data-note-add]").forEach((b) => b.addEventListener("click", () => {
    const inp = $(`[data-note="${b.dataset.noteAdd}"]`);
    const v = inp.value.trim(); if (!v) return;
    itinerary[+b.dataset.noteAdd].items.push({ type: "catatan", title: v, detail: "", time: "" });
    saveIt(); renderItinerary();
  }));
  $$("[data-time]").forEach((i) => i.addEventListener("change", () => {
    const [di, ii] = i.dataset.time.split(":").map(Number);
    itinerary[di].items[ii].time = i.value; saveIt();
  }));
  const move = (ds, dir) => {
    const [di, ii] = ds.split(":").map(Number);
    const arr = itinerary[di].items, ni = ii + dir;
    if (ni < 0 || ni >= arr.length) return;
    [arr[ii], arr[ni]] = [arr[ni], arr[ii]]; saveIt(); renderItinerary();
  };
  $$("[data-up]").forEach((b) => b.addEventListener("click", () => move(b.dataset.up, -1)));
  $$("[data-down]").forEach((b) => b.addEventListener("click", () => move(b.dataset.down, 1)));
  $$("[data-del]").forEach((b) => b.addEventListener("click", () => {
    const [di, ii] = b.dataset.del.split(":").map(Number);
    itinerary[di].items.splice(ii, 1); saveIt(); renderItinerary();
  }));
}

function addToItinerary(item) {
  if (!itinerary.length) itinerary.push({ title: "Hari 1", items: [] });
  itinerary[itinerary.length - 1].items.push({ time: "", ...item });
  saveIt(); renderItinerary(); gotoTab("itinerary");
}

$("#add-day").addEventListener("click", () => {
  itinerary.push({ title: `Hari ${itinerary.length + 1}`, items: [] });
  saveIt(); renderItinerary();
});
$("#export-json").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(itinerary, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "itinerary-temanjalan.json";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#share-link").addEventListener("click", async () => {
  const enc = btoa(unescape(encodeURIComponent(JSON.stringify(itinerary))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const url = location.origin + location.pathname + "#i=" + enc;
  try { await navigator.clipboard.writeText(url); }
  catch { prompt("Salin link ini:", url); return; }
  const out = $("#share-out");
  out.innerHTML = `✅ Link tersalin! Buka di HP lain untuk memuat itinerary ini.`;
  out.classList.remove("hidden");
  setTimeout(() => out.classList.add("hidden"), 4000);
});
$("#import-btn").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const j = JSON.parse(rd.result);
      if (!Array.isArray(j)) throw new Error("Format salah.");
      itinerary = j; saveIt(); renderItinerary(); alert("Itinerary dimuat ✅");
    } catch { alert("File tidak valid."); }
  };
  rd.readAsText(f);
  e.target.value = "";
});

// muat dari link berbagi (#i=...)
(function () {
  const m = location.hash.match(/#i=([A-Za-z0-9\-_]+)/);
  if (!m) return;
  try {
    const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))));
    const j = JSON.parse(json);
    if (Array.isArray(j) && j.length && confirm("Muat itinerary dari link ini? (mengganti yang di HP ini)")) {
      itinerary = j; saveIt(); gotoTab("itinerary");
    }
  } catch { /* abaikan */ }
  history.replaceState(null, "", location.pathname);
})();

renderItinerary();
