// Holt die freigegebene Auswahl aus der Mediathek und baut sie in die Website ein.
//
//   node uebernehmen.js            einmal übernehmen (lokal ansehen)
//   node uebernehmen.js --watch    im Hintergrund lauschen und sofort übernehmen
//   node uebernehmen.js --push     übernehmen und live stellen (committen + pushen)
//   node uebernehmen.js --entwurf  auch unfreigegebene Änderungen einbauen
//
// Zugangsdaten liegen in zugang.json (nicht im Repo).

const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const SITE = __dirname;
const IMG = path.join(SITE, "assets/img");
const VID = path.join(SITE, "assets/video");
const CACHE = path.join(SITE, "medien-cache.json");

// ffmpeg: auf Andrés Rechner der WinGet-Pfad, bei GitHub das vorinstallierte
const WIN_FFMPEG = "C:/Users/andrk/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0-full_build/bin/ffmpeg.exe";
const FFMPEG = process.env.FFMPEG_PATH || (fs.existsSync(WIN_FFMPEG) ? WIN_FFMPEG : "ffmpeg");

const args = process.argv.slice(2);
const WATCH = args.includes("--watch");
const PUSH = args.includes("--push");
const DOC = args.includes("--entwurf") ? "draft" : "published";

// Zugangsdaten aus der Datei — bei GitHub aus den hinterlegten Geheimnissen
const zugang = fs.existsSync(path.join(SITE, "zugang.json"))
  ? JSON.parse(fs.readFileSync(path.join(SITE, "zugang.json"), "utf8"))
  : {
      projectId: process.env.FB_PROJECT || "homies-samui-media",
      apiKey: process.env.FB_APIKEY,
      email: process.env.FB_EMAIL,
      code: process.env.FB_CODE
    };
if (!zugang.apiKey || !zugang.email || !zugang.code) {
  console.error("Keine Zugangsdaten: zugang.json fehlt und FB_APIKEY/FB_EMAIL/FB_CODE sind nicht gesetzt.");
  process.exit(1);
}
const KEY = zugang.apiKey;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${zugang.projectId}/databases/(default)/documents`;

const log = (...m) => console.log(new Date().toLocaleTimeString("de-DE"), ...m);

/* ── Mediathek lesen ─────────────────────────────────────── */

async function token() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: zugang.email, password: zugang.code, returnSecureToken: true })
  });
  const j = await r.json();
  if (!j.idToken) throw new Error("Anmeldung fehlgeschlagen: " + JSON.stringify(j.error || j));
  return j.idToken;
}

const plain = (v) => v.stringValue ?? (v.integerValue !== undefined ? Number(v.integerValue)
  : v.doubleValue !== undefined ? v.doubleValue
  : v.booleanValue !== undefined ? v.booleanValue
  : v.timestampValue !== undefined ? v.timestampValue
  : v.nullValue !== undefined ? null
  : v.arrayValue ? (v.arrayValue.values || []).map(plain)
  : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]))
  : null);

async function fetchAll(tok) {
  const layoutRes = await fetch(`${FS_BASE}/layout/${DOC}`, { headers: { Authorization: "Bearer " + tok } });
  if (!layoutRes.ok) throw new Error("Keine Freigabe gefunden (layout/" + DOC + ")");
  const layout = plain({ mapValue: { fields: (await layoutRes.json()).fields } });

  const media = {};
  let pageToken = "";
  do {
    const r = await fetch(`${FS_BASE}/media?pageSize=300${pageToken ? "&pageToken=" + pageToken : ""}`,
      { headers: { Authorization: "Bearer " + tok } });
    const j = await r.json();
    (j.documents || []).forEach(d => {
      media[d.name.split("/").pop()] = plain({ mapValue: { fields: d.fields } });
    });
    pageToken = j.nextPageToken || "";
  } while (pageToken);

  return { layout, media };
}

/* ── Dateien holen und web-tauglich machen ───────────────── */

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
// sortiert speichern, damit die Datei bei gleichem Inhalt Byte für Byte gleich
// bleibt — sonst gäbe es bei jedem Automatiklauf einen sinnlosen Commit
const saveCache = () => fs.writeFileSync(CACHE,
  JSON.stringify(Object.fromEntries(Object.keys(cache).sort().map(k => [k, cache[k]])), null, 1) + "\n");

// Dateiname aus dem Namen in der Mediathek: \u201eburger-rotate.mp4" bleibt
// burger-rotate, \u201eClip 007" wird clip-007. Kollidieren zwei Namen, bekommt
// der zweite ein K\u00fcrzel angeh\u00e4ngt \u2014 sonst \u00fcberschriebe er die Datei des ersten.
const stemOwner = {};                                  // stem \u2192 media-id
for (const [cid, crel] of Object.entries(cache)) {
  const s = String(crel).split("/").pop().replace(/\.[^.]+$/, "");
  if (!stemOwner[s]) stemOwner[s] = cid;
}
function stemFor(id, item) {
  let base = String(item.name || id).replace(/\.[^.]+$/, "")
    .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
    || ("medium-" + id.slice(-6));
  if (stemOwner[base] && stemOwner[base] !== id) base += "-" + id.slice(-6);
  stemOwner[base] = id;
  return base;
}

async function ensureFile(id, item) {
  const isVideo = item.type === "video";
  const stem = stemFor(id, item);
  const out = isVideo ? path.join(VID, stem + ".mp4") : path.join(IMG, stem + ".jpg");
  const rel = isVideo ? "assets/video/" + stem + ".mp4" : "assets/img/" + stem + ".jpg";
  const poster = isVideo ? path.join(VID, stem + "-poster.jpg") : null;
  const posterRel = isVideo ? "assets/video/" + stem + "-poster.jpg" : null;

  if (cache[id] === rel && fs.existsSync(out) && (!poster || fs.existsSync(poster))) {
    return { rel, posterRel, isVideo, w: item.w, h: item.h };
  }

  const tmp = path.join(SITE, ".tmp-download");
  const res = await fetch(item.url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status}) für ${item.name || id}`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

  if (isVideo) {
    // auf Web-Format bringen: 540 px breit, ohne Ton, schnell startend
    execFileSync(FFMPEG, ["-nostdin", "-v", "error", "-i", tmp,
      "-vf", "scale=540:-2", "-an", "-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
      "-movflags", "+faststart", out, "-y"]);
    // Standbild: bei sehr kurzen Clips schlägt der Sprung zu 0,5 s fehl → Bild 1 nehmen
    try {
      execFileSync(FFMPEG, ["-nostdin", "-v", "error", "-ss", "0.5", "-i", out,
        "-frames:v", "1", "-q:v", "6", poster, "-y"]);
      if (!fs.existsSync(poster) || fs.statSync(poster).size === 0) throw new Error("leer");
    } catch {
      execFileSync(FFMPEG, ["-nostdin", "-v", "error", "-i", out,
        "-frames:v", "1", "-q:v", "6", poster, "-y"]);
    }
  } else {
    execFileSync(FFMPEG, ["-nostdin", "-v", "error", "-i", tmp,
      "-vf", "scale='min(1600,iw)':-2", "-q:v", "4", out, "-y"]);
  }
  fs.unlinkSync(tmp);
  cache[id] = rel;
  log("  aufbereitet:", rel, "(" + Math.round(fs.statSync(out).size / 1024) + " KB)");
  return { rel, posterRel, isVideo, w: item.w, h: item.h };
}

/* ── HTML umschreiben ────────────────────────────────────── */

const up = (rel, dir) => (dir ? "../" : "") + rel;

// Attribute eines Elements einlesen, damit beim Austausch nichts verlorengeht
// (alt-Texte, fetchpriority, aria-label — alles bleibt, wie es war).
function attrsOf(tagHtml) {
  const out = new Map();
  const re = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
  let m; let first = true;
  while ((m = re.exec(tagHtml))) {
    if (first) { first = false; continue; }         // der Tag-Name selbst
    out.set(m[1], m[2] === undefined ? true : m[2]);
  }
  return out;
}
function buildTag(tag, attrs) {
  const parts = [];
  for (const [k, v] of attrs) parts.push(v === true ? k : `${k}="${v}"`);
  return `<${tag} ${parts.join(" ")}>`;
}

function replaceSingle(html, key, index, file, dir) {
  // frisst ein eventuell vorhandenes </video> gleich mit, damit beim Tausch
  // Video → Bild kein verwaister Schließtag in der Seite zurückbleibt
  const re = new RegExp(`<(img|video)\\b[^>]*data-slot="${key.replace(/\./g, "\\.")}" data-i="${index}"[^>]*>(?:\\s*</video>)?`, "g");
  return html.replace(re, (m) => {
    // nur den öffnenden Tag parsen — der mitgefressene Schließtag würde sonst
    // als Müll-Attribut „video" wieder in die Seite geschrieben
    const open = m.slice(0, m.indexOf(">") + 1);
    const tagName = open.slice(1, open.indexOf(" "));
    const a = attrsOf(open);
    a.delete("src"); a.delete("poster"); a.delete("width"); a.delete("height");
    a.delete("muted"); a.delete("loop"); a.delete("playsinline"); a.delete("preload"); a.delete("autoplay");

    const neu = new Map();
    neu.set("data-slot", key); neu.set("data-i", String(index));
    a.delete("data-slot"); a.delete("data-i");

    if (file.isVideo) {
      const cls = String(a.get("class") || "");
      neu.set("class", cls.includes("lazy-vid") ? cls : (cls ? cls + " lazy-vid" : "lazy-vid"));
      a.delete("class");
      neu.set("muted", true); neu.set("loop", true); neu.set("playsinline", true); neu.set("preload", "none");
      neu.set("poster", up(file.posterRel, dir));
      neu.set("src", up(file.rel, dir));
      if (file.w) { neu.set("width", String(file.w)); neu.set("height", String(file.h)); }
      // ein Bild wird zum Clip: alt-Text wandert in aria-label
      if (tagName === "img" && a.get("alt") && !a.get("aria-label")) { neu.set("aria-label", a.get("alt")); a.delete("alt"); }
      for (const [k, v] of a) if (k !== "alt" && k !== "loading" && k !== "fetchpriority") neu.set(k, v);
      // <video> ist kein selbstschließendes Element — ohne Schließtag würde
      // alles, was danach kommt, als unsichtbarer Ersatzinhalt verschluckt
      return buildTag("video", neu) + "</video>";
    }

    // war der Platz vorher ein Clip, muss die Video-Klasse wieder weg
    const cls = String(a.get("class") || "").split(/\s+/).filter(c => c && c !== "lazy-vid").join(" ");
    if (cls) neu.set("class", cls);
    a.delete("class");
    neu.set("src", up(file.rel, dir));
    if (file.w) { neu.set("width", String(file.w)); neu.set("height", String(file.h)); }
    // ein Clip wird zum Bild: aria-label wandert zurück in alt
    if (tagName === "video" && a.get("aria-label") && !a.get("alt")) { neu.set("alt", a.get("aria-label")); a.delete("aria-label"); }
    for (const [k, v] of a) if (k !== "aria-label") neu.set(k, v);
    if (!neu.has("alt")) neu.set("alt", "");
    return buildTag("img", neu);
  });
}

function replaceList(html, key, files, dir) {
  const openRe = new RegExp(`<div class="gal-grid"([^>]*)data-slot-list="${key.replace(/\./g, "\\.")}"([^>]*)>`);
  const m = html.match(openRe);
  if (!m) return html;
  const start = html.indexOf(m[0]);
  // passendes schließendes </div> finden
  let depth = 0, i = start;
  while (i < html.length) {
    const nextOpen = html.indexOf("<div", i + 1);
    const nextClose = html.indexOf("</div>", i + 1);
    if (nextClose < 0) break;
    if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen; }
    else { if (depth === 0) { i = nextClose; break; } depth--; i = nextClose; }
  }
  // Bildbeschreibungen der bisherigen Kacheln retten: gleiche Datei → gleicher Text
  const alt = {};
  const alteKacheln = html.slice(start, i).matchAll(/(?:src|href)="[^"]*\/([^"\/]+)"[^>]*?alt="([^"]*)"/g);
  for (const k of alteKacheln) if (k[2]) alt[k[1]] = k[2];
  const label = {};
  for (const k of html.slice(start, i).matchAll(/src="[^"]*\/([^"\/]+)"[^>]*?aria-label="([^"]*)"/g)) label[k[1]] = k[2];
  const nameOf = (rel) => rel.split("/").pop();

  const inner = files.map(f => {
    const size = f.w ? ` width="${f.w}" height="${f.h}"` : "";
    if (f.isVideo) {
      const l = label[nameOf(f.rel)] ? ` aria-label="${label[nameOf(f.rel)]}"` : "";
      return `        <div class="vid-cell reveal"><video class="lazy-vid" muted loop playsinline preload="none" poster="${up(f.posterRel, dir)}" src="${up(f.rel, dir)}"${size}${l}></video></div>`;
    }
    const a = alt[nameOf(f.rel)] || "";
    return `        <a href="${up(f.rel, dir)}"><img src="${up(f.rel, dir)}" alt="${a}" loading="lazy"${size}></a>`;
  }).join("\n");
  return html.slice(0, start) + m[0] + "\n" + inner + "\n      " + html.slice(i);
}

/* ── Rückmeldung an die Mediathek ────────────────────────── */

// Fingerabdruck der Belegung — die App vergleicht ihn mit dem eigenen Stand
// und zeigt an, ob die Website schon nachgezogen hat.
function fingerabdruck(slots) {
  return Object.keys(slots).sort().map(k => k + ":" + (slots[k] || []).join(",")).join("|");
}

async function melden(tok, slots, geaendert) {
  try {
    await fetch(`${FS_BASE}/layout/applied`, {
      method: "PATCH",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          fingerprint: { stringValue: fingerabdruck(slots) },
          at: { timestampValue: new Date().toISOString() },
          by: { stringValue: process.env.GITHUB_ACTIONS ? "Automatik" : "PC" },
          quelle: { stringValue: DOC },
          seiten: { integerValue: String(geaendert) }
        }
      })
    });
  } catch (e) { log("Rückmeldung an die Mediathek fehlgeschlagen:", e.message); }
}

/* ── Hauptlauf ───────────────────────────────────────────── */

async function run() {
  const tok = await token();
  const { layout, media } = await fetchAll(tok);
  const slots = layout.slots || {};

  // alle gebrauchten Dateien bereitstellen
  const prepared = {};
  for (const [key, ids] of Object.entries(slots)) {
    prepared[key] = [];
    for (const id of ids) {
      const item = media[id];
      // Platzhalter statt Auslassen: sonst rutschen alle folgenden Dateien um
      // eine Position nach vorn und landen auf den falschen Plätzen
      if (!item) { log("  FEHLT in der Mediathek:", id, "(Platz " + key + ") — Platz bleibt unverändert"); prepared[key].push(null); continue; }
      prepared[key].push(await ensureFile(id, item));
    }
  }
  saveCache();

  const PAGES = {
    "home": "index.html", "gallery": "gallery.html", "menu": "menu.html",
    "about": "about.html", "visit": "contact.html"
  };
  let geaendert = 0;

  for (const dir of ["", "de/", "th/"]) {
    for (const [prefix, file] of Object.entries(PAGES)) {
      const p = path.join(SITE, dir + file);
      if (!fs.existsSync(p)) continue;
      let html = fs.readFileSync(p, "utf8");
      const before = html;

      for (const [key, files] of Object.entries(prepared)) {
        if (!key.startsWith(prefix + ".")) continue;
        if (html.includes(`data-slot-list="${key}"`)) html = replaceList(html, key, files.filter(Boolean), dir);
        else files.forEach((f, i) => { if (f) html = replaceSingle(html, key, i, f, dir); });
      }
      if (html !== before) { fs.writeFileSync(p, html); geaendert++; }
    }
  }

  log(geaendert ? `${geaendert} Seiten aktualisiert.` : "Nichts zu ändern — Website ist auf dem Stand der Freigabe.");

  if (PUSH) {
    // nur die Seiten, Medien und den Aufbereitungs-Merkzettel anfassen,
    // nie zufällig andere Baustellen im Ordner
    const pfade = '-- "*.html" de th assets medien-cache.json';
    execSync(`git add ${pfade}`, { cwd: SITE });
    const offen = execSync(`git status --porcelain ${pfade}`, { cwd: SITE }).toString().trim();
    if (offen) execSync('git commit -q -m "Medien aus der Mediathek übernommen"', { cwd: SITE });
    // Push läuft immer — so wird auch ein liegengebliebener Commit
    // von einem früheren, abgebrochenen Lauf noch live gestellt.
    // Bei Gegenverkehr (jemand anderes hat gepusht) einmal nachziehen.
    try {
      execSync("git push -q origin HEAD", { cwd: SITE });
    } catch {
      log("Push abgewiesen — hole den Gegenstand und versuche es erneut.");
      execSync("git pull --rebase -q origin HEAD", { cwd: SITE });
      execSync("git push -q origin HEAD", { cwd: SITE });
    }
    if (offen || geaendert) log("Live gestellt — GitHub Pages braucht ~10 Minuten.");
  }

  // in der Mediathek vermerken, was auf der Website steht — die App zeigt es an
  await melden(tok, slots, geaendert);
  return layout.publishedAt || layout.changedAt || "";
}

(async () => {
  let last = await run();
  if (!WATCH) return;
  log("Lausche auf neue Freigaben … (Strg + C zum Beenden)");
  setInterval(async () => {
    try {
      const tok = await token();
      const r = await fetch(`${FS_BASE}/layout/${DOC}`, { headers: { Authorization: "Bearer " + tok } });
      if (!r.ok) throw new Error("Freigabe-Abfrage: HTTP " + r.status);
      const j = await r.json();
      const stamp = j.fields && (j.fields.publishedAt || j.fields.changedAt);
      const val = stamp ? stamp.timestampValue : "";
      if (val && val !== last) { log("Neue Freigabe entdeckt."); last = await run(); }
    } catch (e) { log("Fehler beim Nachschauen:", e.message); }
  }, 10000);
})().catch(e => { console.error("ABBRUCH:", e.message); process.exit(1); });
