"use client";
// 내 명함을 PNG 한 장으로 그린다(문자에 첨부용). sms: 링크는 이미지를 못 실으므로, 이미지를
// 보내는 경로는 Web Share(navigator.share({files}))뿐이다 — 그때 붙일 그림을 여기서 만든다.
// 캔버스로 그린 래스터라 디자인 토큰(CSS var) 대신 'Porcelain & Pastel' 팔레트 값을 직접 쓴다.
import type { MyCard } from "@linkos/domain";

const BG = "#FCFCFE";
const INK = "#1B1B24";
const IRIS_TEXT = "#5B4BD6";
const IRIS = "#6C5CE7";
const MUTE = "#8A8A99";

/** 내 명함을 1024×640 PNG Blob 으로. 캔버스를 못 쓰면 null(그때는 텍스트/링크만 보낸다). */
export async function renderMyCardImage(me: MyCard): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const W = 1024;
  const H = 640;
  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = IRIS;
  ctx.fillRect(0, 0, W, 14);

  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

  ctx.fillStyle = INK;
  ctx.font = "700 66px 'Inter Tight', Pretendard, system-ui, sans-serif";
  ctx.fillText(clip(me.name || "", 18), 72, 190);

  const sub = [me.jobTitle, me.company].filter((x) => x && String(x).trim()).join(" · ");
  if (sub) {
    ctx.fillStyle = IRIS_TEXT;
    ctx.font = "500 36px Pretendard, system-ui, sans-serif";
    ctx.fillText(clip(sub, 34), 72, 250);
  }

  ctx.fillStyle = INK;
  ctx.font = "400 32px Pretendard, system-ui, sans-serif";
  let y = 352;
  const rows = [me.phone && `☎  ${me.phone}`, me.email && `✉  ${me.email}`, me.url].filter(Boolean) as string[];
  for (const row of rows) {
    ctx.fillText(clip(row, 40), 72, y);
    y += 56;
  }

  ctx.fillStyle = MUTE;
  ctx.font = "400 24px Pretendard, system-ui, sans-serif";
  ctx.fillText("LINKOS · 내 명함", 72, H - 44);

  return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png", 0.92));
}
