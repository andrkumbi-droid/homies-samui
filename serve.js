// Kleiner Server für die Website — nur zum Anschauen auf dem eigenen Rechner.
// Starten:  node serve.js       (dann http://localhost:8080 öffnen)
// Beenden:  Strg + C

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".xml": "application/xml; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"
};

// ein Lesestrom, der bei Störungen die Antwort sauber kappt statt den Server zu reißen
function send(file, res, opts) {
  const s = fs.createReadStream(file, opts);
  s.on("error", () => { res.destroy(); });
  s.pipe(res);
}

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]); }
  catch { res.writeHead(400).end("kaputte Adresse"); return; }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(ROOT, "." + path.posix.normalize("/" + rel));

  // nicht aus dem Ordner herausklettern — mit Trenner, sonst käme man in
  // Nachbarordner, deren Name nur gleich anfängt (homies-samui-site-backup …)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end("nein"); return; }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      const notFound = path.join(ROOT, "404.html");
      if (fs.existsSync(notFound)) {
        res.writeHead(404, { "Content-Type": TYPES[".html"] });
        return res.end(fs.readFileSync(notFound));
      }
      res.writeHead(404).end("nicht gefunden");
      return;
    }

    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    const head = {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      // damit die Mediathek die Seite in ihrem Vorschaufenster zeigen darf
      "Access-Control-Allow-Origin": "*"
    };

    // HEAD darf keinen Inhalt schicken, sonst bricht der Server ab
    if (req.method === "HEAD") { res.writeHead(200, head); return res.end(); }

    // Videos brauchen Bereichsabfragen, sonst springt die Wiedergabe nicht.
    // Grenzen werden geprüft und gekappt — Unsinn gibt 416 statt eines Absturzes.
    const range = req.headers.range;
    const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      let start, end;
      if (m[1] === "") {                      // bytes=-500 → die letzten 500 Bytes
        const n = Math.min(Number(m[2]), stat.size);
        start = stat.size - n; end = stat.size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? stat.size - 1 : Math.min(Number(m[2]), stat.size - 1);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...head, "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes" });
      return send(file, res, { start, end });
    }

    res.writeHead(200, { ...head, "Accept-Ranges": "bytes" });
    send(file, res);
  });
}).listen(PORT, () => {
  console.log(`Homies-Website läuft auf http://localhost:${PORT}`);
  console.log("Beenden mit Strg + C");
});
