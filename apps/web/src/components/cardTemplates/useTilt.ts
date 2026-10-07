"use client";
// Pointer tilt + sheen shared by the classic theme card and TemplateCard (F-022). Touch/reduced-motion users get a static card.
import { useRef } from "react";

export function useTilt<T extends HTMLElement>(interactive: boolean) {
  const ref = useRef<T>(null);
  const onPointerMove = (e: React.PointerEvent) => {
    if (!interactive || !ref.current || e.pointerType === "touch") return;
    const r = ref.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    ref.current.style.transform = `perspective(900px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg)`;
    ref.current.style.setProperty("--sx", `${x * 60}%`);
    ref.current.style.setProperty("--sy", `${y * 60}%`);
  };
  const onPointerLeave = () => {
    if (ref.current) ref.current.style.transform = "";
  };
  return { ref, onPointerMove, onPointerLeave };
}
