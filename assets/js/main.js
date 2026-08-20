// Homies Burger & Fries — shared page behavior

(function () {
  'use strict';

  // mobile nav toggle
  var toggle = document.querySelector('.nav-toggle');
  var links = document.getElementById('nav-menu');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

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

  // gallery lightbox
  var gallery = document.getElementById('gallery');
  var lightbox = document.getElementById('lightbox');
  if (gallery && lightbox) {
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

    gallery.addEventListener('click', function (ev) {
      var a = ev.target.closest('a');
      if (!a) return;
      ev.preventDefault();
      var img = a.querySelector('img');
      openLb(a.getAttribute('href'), img ? img.alt : '', a);
    });
    lbClose.addEventListener('click', closeLb);
    lightbox.addEventListener('click', function (ev) { if (ev.target === lightbox) closeLb(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && lightbox.classList.contains('open')) closeLb();
    });
  }
})();
