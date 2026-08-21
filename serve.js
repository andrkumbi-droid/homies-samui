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
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);

  // nicht aus dem Ordner herausklettern
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("nein"); return; }

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

    // Videos brauchen Bereichsabfragen, sonst springt die Wiedergabe nicht
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.replace("bytes=", "").split("-");
      const start = s ? Number(s) : 0;
      const end = e ? Number(e) : stat.size - 1;
      res.writeHead(206, { ...head, "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes" });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }

    res.writeHead(200, { ...head, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => {
  console.log(`Homies-Website läuft auf http://localhost:${PORT}`);
  console.log("Beenden mit Strg + C");
});
