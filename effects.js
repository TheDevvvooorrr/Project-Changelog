// ===== Ciego Visual Effects =====
(function() {
  'use strict';

  // ===== PARTICLE SYSTEM =====
  const canvas = document.getElementById('particleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let particles = [];
  let w, h;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * w;
      this.y = Math.random() * h;
      this.size = Math.random() * 2 + 0.5;
      this.speedX = (Math.random() - 0.5) * 0.3;
      this.speedY = (Math.random() - 0.5) * 0.3;
      this.opacity = Math.random() * 0.4 + 0.1;
      this.hue = Math.random() > 0.5 ? 255 : 200; // purple or cyan
      this.pulse = Math.random() * Math.PI * 2;
    }
    update() {
      this.x += this.speedX;
      this.y += this.speedY;
      this.pulse += 0.02;
      if (this.x < 0 || this.x > w || this.y < 0 || this.y > h) this.reset();
    }
    draw() {
      const o = this.opacity * (0.5 + 0.5 * Math.sin(this.pulse));
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      if (this.hue === 255) {
        ctx.fillStyle = `rgba(110, 86, 255, ${o})`;
      } else {
        ctx.fillStyle = `rgba(0, 212, 255, ${o})`;
      }
      ctx.fill();
    }
  }

  // Create particles (fewer on mobile)
  const count = window.innerWidth < 600 ? 30 : 60;
  for (let i = 0; i < count; i++) particles.push(new Particle());

  // Draw connections between nearby particles
  function drawConnections() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120) {
          const o = (1 - dist / 120) * 0.08;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(110, 86, 255, ${o})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  function animate() {
    ctx.clearRect(0, 0, w, h);
    particles.forEach(p => { p.update(); p.draw(); });
    drawConnections();
    requestAnimationFrame(animate);
  }
  animate();

  // ===== 3D TILT EFFECT ON CARDS =====
  function addTilt(card) {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = (y - centerY) / centerY * -3;
      const rotateY = (x - centerX) / centerX * 3;
      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = 'perspective(1000px) rotateX(0) rotateY(0)';
    });
  }

  // Apply tilt to all cards
  document.querySelectorAll('.card').forEach(addTilt);
  // Also apply to dynamically added cards
  const observer = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      m.addedNodes.forEach(n => {
        if (n.classList && n.classList.contains('card')) addTilt(n);
        if (n.querySelectorAll) n.querySelectorAll('.card').forEach(addTilt);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ===== RIPPLE EFFECT ON BUTTONS =====
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-send, .btn-connect, .mode-tab, .privacy-opt');
    if (!btn) return;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.style.position = 'relative';
    btn.style.overflow = 'hidden';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  });

  // ===== SMOOTH TAB TRANSITIONS =====
  const modeTabs = document.querySelectorAll('.mode-tab');
  const pages = [
    document.getElementById('txForm'),
    document.getElementById('batchMode'),
    document.getElementById('bridgeMode')
  ];

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      pages.forEach(p => {
        if (p && !p.classList.contains('hidden')) {
          p.style.animation = 'fadeOut 0.15s ease';
          setTimeout(() => {
            p.style.animation = '';
          }, 150);
        }
      });
    });
  });

  // Add fadeOut keyframe
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeOut { to { opacity: 0; transform: translateY(-5px); } }
    .card, .batch-progress, .receipt-wrap, .tx-step-bar {
      animation: fadeIn 0.3s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  `;
  document.head.appendChild(style);

})();
