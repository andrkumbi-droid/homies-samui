// Holt die freigegebene Auswahl aus der Mediathek und baut sie in die Website ein.
//
//   node uebernehmen.js            einmal übernehmen (lokal ansehen)
//   node uebernehmen.js --watch    im Hintergrund lauschen und sofort übernehmen
//   node uebernehmen.js --push     übernehmen und live stellen (committen + pushen)
//   node uebernehmen.js --freigegeben  nur ausdrücklich Freigegebenes einbauen
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
// Es gibt keinen Freigabe-Schritt mehr: der Entwurf IST der gültige Stand.
// (--freigegeben liest wieder layout/published, falls wir je zurückschalten)
const DOC = args.includes("--freigegeben") ? "published" : "draft";

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
    return { rel, posterRel, isVideo, w: item.w, h: item.h, alt: item.alt || "" };
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
  return { rel, posterRel, isVideo, w: item.w, h: item.h, alt: item.alt || "" };
}

/* ── HTML umschreiben ────────────────────────────────────── */

const up = (rel, dir) => (dir ? "../" : "") + rel;
const nameOf = (rel) => String(rel).split("/").pop();

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
    const alteDatei = (a.get("src") || "").split("/").pop();
    a.delete("src"); a.delete("poster"); a.delete("width"); a.delete("height");
    a.delete("muted"); a.delete("loop"); a.delete("playsinline"); a.delete("preload"); a.delete("autoplay");

    // Beschreibung gehört zum Motiv, nicht zum Platz: liegt dort eine ANDERE
    // Datei als vorher, wäre der alte Text schlicht falsch (ein Katsu-Clip
    // hieße sonst weiter „Patties auf der Grillplatte"). Dann lieber die
    // Beschreibung aus der Mediathek — und sonst gar keine.
    const andereDatei = alteDatei !== nameOf(file.rel);
    if (andereDatei) { a.delete("alt"); a.delete("aria-label"); }
    const beschreibung = file.alt || (andereDatei ? "" : (a.get("alt") || a.get("aria-label") || ""));

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
      if (beschreibung) neu.set("aria-label", beschreibung);
      a.delete("alt"); a.delete("aria-label");
      for (const [k, v] of a) if (k !== "loading" && k !== "fetchpriority") neu.set(k, v);
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
    neu.set("alt", beschreibung);
    a.delete("alt"); a.delete("aria-label");
    for (const [k, v] of a) neu.set(k, v);
    return buildTag("img", neu);
  });
}

// Menüzeilen ohne festes Bild (Combos, Saucen, Getränke): die Zeile trägt nur
// einen unsichtbaren Marker data-slot-item. Liegt in der Mediathek ein Medium
// auf dem Platz, wird ein Bild in die Zeile EINGEFÜGT; wird der Platz wieder
// geleert, verschwindet das Bild — die Zeile sieht dann aus wie vorher.
function replaceItemThumb(html, key, files, dir) {
  const esc = key.replace(/\./g, "\\.");
  const openRe = new RegExp(`<div\\b[^>]*data-slot-item="${esc}"[^>]*>`);
  const m = html.match(openRe);
  if (!m) return html;
  // Datei fehlt in der Mediathek (Platzhalter null) → Zeile nicht anfassen
  if (files.length && files[0] === null) return html;
  const file = files[0] || null;

  const start = html.indexOf(m[0]);
  // .menu-item enthält keine weiteren <div> — das erste </div> schließt die Zeile
  const end = html.indexOf("</div>", start);
  let open = m[0];
  let seg = html.slice(start + open.length, end);

  // vorhandenes Medium vom letzten Lauf rausnehmen — Beschreibung dabei retten
  const medRe = new RegExp(`\\s*<(?:img|video)\\b[^>]*data-slot="${esc}"[^>]*>(?:\\s*</video>)?`);
  const med = seg.match(medRe);
  let oldAlt = "", oldFileName = "";
  if (med) {
    const a = attrsOf(med[0].trim().slice(0, med[0].trim().indexOf(">") + 1));
    oldAlt = a.get("alt") || a.get("aria-label") || "";
    oldFileName = (a.get("src") || "").split("/").pop();
    seg = seg.replace(medRe, "");
  }

  const thumbKlasse = (an) => {
    open = open.replace(/class="([^"]*)"/, (_, cls) => {
      const list = cls.split(/\s+/).filter(c => c && c !== "with-thumb");
      if (an) list.splice(1, 0, "with-thumb");
      return `class="${list.join(" ")}"`;
    });
  };

  if (!file) {
    thumbKlasse(false);
    return html.slice(0, start) + open + seg + html.slice(end);
  }

  const gleicheDatei = oldFileName === nameOf(file.rel);
  const beschreibung = file.alt || (gleicheDatei ? oldAlt : "");
  const size = file.w ? ` width="${file.w}" height="${file.h}"` : "";
  const tag = file.isVideo
    ? `<video data-slot="${key}" data-i="0" class="thumb lazy-vid" muted loop playsinline preload="none" poster="${up(file.posterRel, dir)}" src="${up(file.rel, dir)}"${size}${beschreibung ? ` aria-label="${beschreibung}"` : ""}></video>`
    : `<img data-slot="${key}" data-i="0" class="thumb" src="${up(file.rel, dir)}"${size} alt="${beschreibung}" loading="lazy">`;
  thumbKlasse(true);
  return html.slice(0, start) + open + "\n            " + tag + seg + html.slice(end);
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
        else if (html.includes(`data-slot-item="${key}"`)) html = replaceItemThumb(html, key, files, dir);
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

// zum Testen einzelner Funktionen ohne echten Lauf (node -e "require('./uebernehmen.js')…")
module.exports = { replaceSingle, replaceList, replaceItemThumb };
if (require.main === module) (async () => {
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
