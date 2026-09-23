// rivethub.io home: hero flow canvas, scroll spine, RivetOS step stage, theme gallery, sticky CTA.
(function () {
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;
  root.classList.add('js');

  /* ── Hero: five tools feeding one record ── */
  var canvas = document.getElementById('flow');
  if (canvas && canvas.getContext) {
    var ctx = canvas.getContext('2d');
    var tools = ['claude-code', 'codex', 'grok-build', 'kimi-code', 'hermes'];
    var kinds = ['prompt', 'tool_call', 'result', 'summary'];
    var W = 640, H = 560, dpr = 1;
    var hub = { x: 470, y: 280 };
    var colors = {};
    var packets = [];
    var captured = 0, recalled = 0;
    var capturedEl = document.querySelector('[data-count-captured]');
    var recalledEl = document.querySelector('[data-count-recalled]');

    function readColors() {
      var cs = getComputedStyle(root);
      ['--green', '--brass', '--rule', '--soft', '--faint', '--ink', '--surface', '--green-wash', '--brass-wash']
        .forEach(function (k) { colors[k] = cs.getPropertyValue(k).trim(); });
    }
    function size() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function laneY(i) { return 110 + i * 88; }
    // Cubic from lane start to hub.
    function lanePoint(i, t) {
      var x0 = 120, y0 = laneY(i), x3 = hub.x - 34, y3 = hub.y;
      var x1 = 260, y1 = y0, x2 = 330, y2 = y3;
      var u = 1 - t;
      return {
        x: u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        y: u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
      };
    }
    function spawn() {
      var lane = Math.floor(Math.random() * tools.length);
      var isRecall = Math.random() < 0.28;
      if (isRecall) {
        var from = Math.floor(Math.random() * tools.length);
        var to = (from + 1 + Math.floor(Math.random() * (tools.length - 1))) % tools.length;
        packets.push({ lane: to, from: from, t: 0, speed: 0.006 + Math.random() * 0.003, recall: true, label: 'memory_search' });
      } else {
        packets.push({ lane: lane, t: 0, speed: 0.005 + Math.random() * 0.004, recall: false, label: kinds[Math.floor(Math.random() * kinds.length)] });
      }
    }
    var hubPulse = 0, recallFlash = [0, 0, 0, 0, 0];

    function draw() {
      ctx.clearRect(0, 0, W, H);
      // lanes
      for (var i = 0; i < tools.length; i++) {
        ctx.beginPath();
        for (var s = 0; s <= 40; s++) {
          var p = lanePoint(i, s / 40);
          if (s === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = colors['--rule']; ctx.lineWidth = 2; ctx.stroke();
        // tool node
        var y = laneY(i);
        ctx.fillStyle = recallFlash[i] > 0 ? colors['--brass-wash'] : colors['--surface'];
        ctx.strokeStyle = recallFlash[i] > 0 ? colors['--brass'] : colors['--rule'];
        ctx.lineWidth = 1.5;
        roundRect(18, y - 15, 112, 30, 8); ctx.fill(); ctx.stroke();
        ctx.fillStyle = colors['--soft'];
        ctx.font = '12px "JetBrains Mono", ui-monospace, monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText(tools[i], 28, y + 1);
        if (recallFlash[i] > 0) recallFlash[i] -= 1;
      }
      // hub
      var r = 34 + Math.sin(hubPulse) * 1.5;
      ctx.beginPath(); ctx.arc(hub.x, hub.y, r + 16, 0, Math.PI * 2);
      ctx.fillStyle = colors['--green-wash']; ctx.fill();
      ctx.beginPath(); ctx.arc(hub.x, hub.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colors['--green']; ctx.fill();
      ctx.beginPath(); ctx.arc(hub.x, hub.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = colors['--surface']; ctx.fill();
      ctx.fillStyle = colors['--ink'];
      ctx.font = '700 15px "DM Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('your hub', hub.x, hub.y + r + 34);
      ctx.fillStyle = colors['--faint'];
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText('postgres · on your hardware', hub.x, hub.y + r + 54);
      ctx.textAlign = 'left';
      // packets
      for (var k = 0; k < packets.length; k++) {
        var pk = packets[k];
        // recalls travel hub → tool (reverse along the lane)
        var pt = lanePoint(pk.lane, pk.recall ? 1 - pk.t : pk.t);
        var c = pk.recall ? colors['--brass'] : colors['--green'];
        ctx.beginPath(); ctx.arc(pt.x, pt.y, pk.recall ? 5 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = c; ctx.fill();
        if (pk.t > 0.12 && pk.t < 0.7) {
          ctx.globalAlpha = Math.min(1, (0.7 - pk.t) * 4);
          ctx.fillStyle = c;
          ctx.font = '10.5px "JetBrains Mono", ui-monospace, monospace';
          ctx.fillText(pk.label, pt.x + 9, pt.y - 9);
          ctx.globalAlpha = 1;
        }
      }
    }
    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function step() {
      hubPulse += 0.05;
      for (var k = packets.length - 1; k >= 0; k--) {
        var pk = packets[k];
        pk.t += pk.speed;
        if (pk.t >= 1) {
          if (pk.recall) { recalled++; recallFlash[pk.lane] = 36; }
          else { captured++; hubPulse = 0; }
          packets.splice(k, 1);
        }
      }
      if (Math.random() < 0.05 && packets.length < 14) spawn();
      if (capturedEl) capturedEl.textContent = captured.toLocaleString();
      if (recalledEl) recalledEl.textContent = recalled.toLocaleString();
    }

    readColors(); size();
    // Seed a believable resting frame so the still image already shows traffic.
    for (var n = 0; n < 9; n++) { spawn(); packets[packets.length - 1].t = Math.random() * 0.9; }
    packets[0].recall = true; packets[0].label = 'memory_search';
    draw();

    var visible = true, raf = 0;
    function loop() { step(); draw(); raf = requestAnimationFrame(loop); }
    if (!reduce) {
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (e) {
          visible = e[0].isIntersecting;
          cancelAnimationFrame(raf);
          if (visible) raf = requestAnimationFrame(loop);
        }).observe(canvas);
      } else { raf = requestAnimationFrame(loop); }
    }
    new MutationObserver(function () { readColors(); draw(); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { readColors(); draw(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
  }

  /* ── Problem: silos line up once seen ── */
  var silos = document.querySelector('.silos');
  if (silos && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (e, o) {
      if (e[0].isIntersecting) { silos.classList.add('is-joined'); o.disconnect(); }
    }, { threshold: 0.6 }).observe(silos);
  }

  /* ── RivetOS steps drive the sticky stage ── */
  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'));
  var shots = Array.prototype.slice.call(document.querySelectorAll('.shot'));
  function activate(i) {
    steps.forEach(function (s, j) { s.classList.toggle('is-active', j === i); });
    shots.forEach(function (s, j) { s.classList.toggle('is-active', j === i); });
  }
  if (shots.length) {
    shots.forEach(function (s) { s.querySelector('img').loading = 'eager'; });
    activate(0);
    if ('IntersectionObserver' in window) {
      var stepObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) activate(+e.target.dataset.step); });
      }, { rootMargin: '-45% 0px -45% 0px' });
      steps.forEach(function (s) { stepObs.observe(s); });
    }
  }

  /* ── Hub gallery: real captures in other desktop themes ── */
  var galleryImg = document.querySelector('[data-gallery-img]');
  var swatchButtons = document.querySelectorAll('[data-theme-shot]');
  swatchButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = 'images/omarchy/' + btn.dataset.themeShot + '-chat-expanded.png';
      swatchButtons.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
      galleryImg.classList.add('is-swapping');
      var pre = new Image();
      pre.onload = pre.onerror = function () {
        galleryImg.src = next;
        galleryImg.alt = 'The RivetHub desktop app in the ' + btn.textContent + ' desktop theme, with saved conversations and a memory search';
        galleryImg.classList.remove('is-swapping');
      };
      pre.src = next;
    });
  });

  /* ── Scroll: header progress, spine fill, lit studs, sticky CTA ── */
  var bar = document.querySelector('[data-progress]');
  var story = document.querySelector('[data-story]');
  var fill = document.querySelector('[data-spine-fill]');
  var chapters = document.querySelectorAll('.chapter');
  var sticky = document.querySelector('[data-sticky-cta]');
  var hero = document.querySelector('.hero');
  var finalCta = document.getElementById('final-cta');
  var ticking = false;
  function onScroll() {
    ticking = false;
    var vh = window.innerHeight;
    var max = document.documentElement.scrollHeight - vh;
    if (bar) bar.parentNode.style.setProperty('--p', max > 0 ? (window.scrollY / max).toFixed(4) : 0);
    if (story && fill) {
      var r = story.getBoundingClientRect();
      var f = Math.min(1, Math.max(0, (vh * 0.55 - r.top) / r.height));
      fill.parentNode.style.setProperty('--fill', f.toFixed(4));
    }
    chapters.forEach(function (c) {
      var stud = c.querySelector('.stud');
      if (stud) c.classList.toggle('is-lit', stud.getBoundingClientRect().top < vh * 0.55);
    });
    if (sticky && hero && finalCta) {
      var pastHero = hero.getBoundingClientRect().bottom < 0;
      var atEnd = finalCta.getBoundingClientRect().top < vh;
      sticky.hidden = !(pastHero && !atEnd);
    }
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();
})();
