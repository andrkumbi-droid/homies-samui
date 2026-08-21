// Homies Burger & Fries — shared page behavior

(function () {
  'use strict';

  // Kein Klappmenü mehr: am Handy stehen die Links in einer eigenen Zeile
  // unter dem Logo (siehe Kopfzeilen-Block in style.css).

  // scroll reveal
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  // lazy autoplay for muted loop videos (pause off-screen, respect reduced motion)
  var vids = document.querySelectorAll('video.lazy-vid');
  if (vids.length && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if ('IntersectionObserver' in window) {
      var vio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.play().catch(function () {}); }
          else { e.target.pause(); }
        });
      }, { rootMargin: '120px' });
      vids.forEach(function (v) { vio.observe(v); });
    } else {
      vids.forEach(function (v) { v.play().catch(function () {}); });
    }
  }

  // Großansicht — für die Galerie-Raster und für die Bilder in der Speisekarte.
  // Die Speisekarten-Bilder werden bewusst über ihre eigene src geöffnet und
  // nicht über einen <a href>: die Mediathek tauscht das Bild im laufenden
  // Betrieb aus, ein fest verdrahteter Link würde dabei veralten.
  var galleries = document.querySelectorAll('.gal-grid');
  var zoombar = document.querySelectorAll('.menu-item .thumb');
  var lightbox = document.getElementById('lightbox');

  // Auf Seiten ohne vorbereitete Großansicht (z. B. die Speisekarte) bauen
  // wir sie hier, damit die Seiten selbst nichts davon wissen müssen.
  if (!lightbox && (galleries.length || zoombar.length)) {
    lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.id = 'lightbox';
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.setAttribute('aria-label', document.documentElement.lang === 'de' ? 'Bildansicht'
      : document.documentElement.lang === 'th' ? 'ดูรูปภาพ' : 'Photo viewer');
    lightbox.innerHTML = '<button class="lb-close" aria-label="'
      + (document.documentElement.lang === 'de' ? 'schließen' : document.documentElement.lang === 'th' ? 'ปิด' : 'Close')
      + '">&times;</button><img src="" alt="">';
    document.body.appendChild(lightbox);
  }

  if ((galleries.length || zoombar.length) && lightbox) {
    var lbImg = lightbox.querySelector('img');
    var lbClose = lightbox.querySelector('.lb-close');
    var lastFocus = null;

    function openLb(href, alt, trigger) {
      lbImg.src = href;
      lbImg.alt = alt || '';
      lightbox.classList.add('open');
      lastFocus = trigger;
      lbClose.focus();
      document.body.style.overflow = 'hidden';
    }
    function closeLb() {
      lightbox.classList.remove('open');
      lbImg.src = '';
      document.body.style.overflow = '';
      if (lastFocus) lastFocus.focus();
    }

    Array.prototype.forEach.call(galleries, function (grid) {
      grid.addEventListener('click', function (ev) {
        var a = ev.target.closest('a');
        if (!a) return;
        ev.preventDefault();
        var img = a.querySelector('img');
        openLb(a.getAttribute('href'), img ? img.alt : '', a);
      });
    });

    // Speisekarte: Bild antippen zeigt es groß. Per Tastatur genauso erreichbar.
    Array.prototype.forEach.call(zoombar, function (el) {
      if (el.tagName === 'VIDEO') return;               // Clips laufen ohnehin schon
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      var name = el.closest('.menu-item').querySelector('h3');
      el.setAttribute('aria-label', (el.alt || (name ? name.textContent : '')) + ' — '
        + (document.documentElement.lang === 'de' ? 'groß ansehen'
          : document.documentElement.lang === 'th' ? 'ดูรูปใหญ่' : 'view larger'));
      el.addEventListener('click', function () {
        openLb(el.currentSrc || el.src, el.alt || (name ? name.textContent : ''), el);
      });
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.click(); }
      });
    });

    lbClose.addEventListener('click', closeLb);
    lightbox.addEventListener('click', function (ev) { if (ev.target === lightbox) closeLb(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && lightbox.classList.contains('open')) closeLb();
    });
  }
})();
