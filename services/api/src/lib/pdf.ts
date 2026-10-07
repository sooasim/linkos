// F-126 PDF export — pdfkit + embedded Pretendard (OFL) so Korean renders on every viewer (no system-font fallback).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { unavailable } from "./errors";

const FONT_REL = "dist/public/static/alternative";

/** Resolve Pretendard from node_modules (or PDF_FONT_DIR when bundled/standalone). */
export function pdfFontPath(weight: "Regular" | "SemiBold" = "Regular"): string {
  const file = `Pretendard-${weight}.ttf`;
  const candidates: string[] = [];
  if (process.env.PDF_FONT_DIR) candidates.push(join(process.env.PDF_FONT_DIR, file));
  try {
    const req = createRequire(import.meta.url);
    candidates.push(join(req.resolve("pretendard/package.json"), "..", FONT_REL, file));
  } catch {
    /* not resolvable from this bundle location */
  }
  try {
    const req = createRequire(join(process.cwd(), "package.json"));
    candidates.push(join(req.resolve("pretendard/package.json"), "..", FONT_REL, file));
  } catch {
    /* ignore */
  }
  candidates.push(join(process.cwd(), "node_modules/pretendard", FONT_REL, file)); // standalone output (traced files only)
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw unavailable("pdf_font_missing", "PDF용 한글 글꼴(Pretendard)을 찾지 못했습니다. PDF_FONT_DIR 을 설정하세요.");
  return hit;
}

export async function buildTablePdf(title: string, headers: string[], rows: string[][]): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: title, Creator: "LINKOS", Producer: "LINKOS" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont("ko", pdfFontPath("Regular"));
  doc.registerFont("ko-bold", pdfFontPath("SemiBold"));
  doc.font("ko-bold").fontSize(16).text(title);
  doc.moveDown(0.3).font("ko").fontSize(9).fillColor("#555").text(`${rows.length}명 · ${new Date().toISOString().slice(0, 10)}`);
  doc.moveDown(0.8).fillColor("#000");

  const width = doc.page.width - 80;
  const colW = width / Math.max(1, headers.length);
  const drawRow = (cells: string[], bold: boolean) => {
    doc.font(bold ? "ko-bold" : "ko").fontSize(bold ? 9.5 : 9);
    const heights = cells.map((c) => doc.heightOfString(c || " ", { width: colW - 6 }));
    const h = Math.max(...heights, 12) + 6;
    if (doc.y + h > doc.page.height - 40) doc.addPage();
    const y = doc.y;
    cells.forEach((c, i) => doc.text(c || "", 40 + i * colW + 3, y + 3, { width: colW - 6, lineBreak: true }));
    doc.moveTo(40, y + h).lineTo(40 + width, y + h).lineWidth(0.4).strokeColor(bold ? "#000" : "#ccc").stroke();
    doc.x = 40;
    doc.y = y + h;
  };
  drawRow(headers, true);
  for (const r of rows) drawRow(r, false);
  doc.end();
  return done;
}
