"use client";
// Global motion layer: scroll reveal ([data-reveal]), button ripples (.btn), cursor spotlight + scroll progress
// (landing, [data-fx-spotlight]), holographic card tilt ([data-tilt]), pastel confetti ([data-confetti]).
// Everything is progressive enhancement: content is visible without JS, and prefers-reduced-motion disables motion.
import { useEffect } from "react";

const CONFETTI = ["#c8bdff", "#ffc8dd", "#bdeedd", "#ffe0b8", "#bcd9ff"];

function burst(x: number, y: number) {
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:80;overflow:hidden";
  document.body.appendChild(layer);
  for (let i = 0; i < 36; i++) {
    const p = document.createElement("span");
    const size = 5 + Math.random() * 6;
    const angle = Math.random() * Math.PI * 2;
    const dist = 80 + Math.random() * 160;
    p.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${size}px;height:${size * (Math.random() > 0.5 ? 1 : 0.45)}px;border-radius:${Math.random() > 0.5 ? "50%" : "2px"};background:${CONFETTI[i % CONFETTI.length]}`;
    layer.appendChild(p);
    p.animate(
      [
        { transform: "translate(-50%,-50%) rotate(0)", opacity: 1 },
        { transform: `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist + 120}px) rotate(${Math.random() * 540}deg)`, opacity: 0 },
      ],
      { duration: 1100 + Math.random() * 500, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" },
    );
  }
  setTimeout(() => layer.remove(), 1800);
}

export function Fx() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const root = document.documentElement;
    const cleanups: (() => void)[] = [];

    // Scroll reveal
    if (!reduce && "IntersectionObserver" in window) {
      root.classList.add("fx");
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add("is-in");
              io.unobserve(e.target);
            }
          }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
      );
      const scan = () => document.querySelectorAll("[data-reveal]:not(.is-in)").forEach((el) => io.observe(el));
      scan();
      const mo = new MutationObserver(scan);
      mo.observe(document.body, { childList: true, subtree: true });
      cleanups.push(() => {
        io.disconnect();
        mo.disconnect();
        root.classList.remove("fx");
      });
    }

    // Ripple + confetti (delegated)
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as HTMLElement | null;
      const btn = t?.closest<HTMLElement>(".btn");
      if (btn && !reduce) {
        const r = btn.getBoundingClientRect();
        const s = Math.max(r.width, r.height);
        const span = document.createElement("span");
        span.className = "ripple";
        span.style.cssText = `width:${s}px;height:${s}px;left:${ev.clientX - r.left - s / 2}px;top:${ev.clientY - r.top - s / 2}px`;
        btn.appendChild(span);
        setTimeout(() => span.remove(), 700);
      }
    };
    const onClick = (ev: MouseEvent) => {
      const c = (ev.target as HTMLElement | null)?.closest("[data-confetti]");
      if (c && !reduce) burst(ev.clientX, ev.clientY);
    };
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("click", onClick);
    cleanups.push(() => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("click", onClick);
    });

    // Spotlight, scroll progress, card tilt — fine pointers only
    if (!reduce) {
      let raf = 0;
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerType !== "mouse") return;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          root.style.setProperty("--mx", `${ev.clientX}px`);
          root.style.setProperty("--my", `${ev.clientY}px`);
          const card = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-tilt]");
          document.querySelectorAll<HTMLElement>("[data-tilt].is-tilting").forEach((el) => {
            if (el !== card) {
              el.classList.remove("is-tilting");
              el.style.transform = "";
            }
          });
          if (card) {
            const r = card.getBoundingClientRect();
            const px = (ev.clientX - r.left) / r.width - 0.5;
            const py = (ev.clientY - r.top) / r.height - 0.5;
            card.classList.add("is-tilting");
            card.style.transform = `perspective(900px) rotateY(${px * 14}deg) rotateX(${-py * 14}deg) translateZ(0)`;
            card.style.setProperty("--sx", `${-30 + px * 40}%`);
            card.style.setProperty("--sy", `${-30 + py * 40}%`);
          }
        });
      };
      const onScroll = () => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        root.style.setProperty("--progress", String(max > 0 ? window.scrollY / max : 0));
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
      cleanups.push(() => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("scroll", onScroll);
        cancelAnimationFrame(raf);
      });
    }
    return () => cleanups.forEach((f) => f());
  }, []);
  return null;
}
