// F-015: 실제로 찍은 명함 사진으로 인식 파이프라인을 끝까지 돌려 본다.
//
//   pnpm ocr:bench <사진들이 든 폴더> [--json out.json] [--no-rectify]
//
// 브라우저에서 도는 것과 같은 순서·같은 함수를 쓴다(캔버스 대신 sharp 로 픽셀을 옮길 뿐):
//   EXIF 보정 → 테두리 검출 → 원근 보정 → PP-OCRv5 검출 → 글자줄 인식 → 파서.
// 사진은 저장소에 두지 않는다 — 폴더를 인자로 받는다.
import { readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ort from "onnxruntime-web";
import sharp from "sharp";
import {
  REC_DROP_SCORE,
  REC_HEIGHT,
  autoContrast,
  buildCharset,
  dbBoxes,
  decodeCtc,
  detResize,
  detectCardQuad,
  mergeNumberRuns,
  mergeSpacedChars,
  normalizeDetInput,
  normalizeRecInput,
  parseBusinessCard,
  recCropQuad,
  recCropWidth,
  recPadWidth,
  rectifiedSize,
  rgbaToGray,
  sortBoxesReadingOrder,
  toDraft,
  warpPerspective,
} from "@linkos/domain";
import { readFileSync } from "node:fs";

const WEB = dirname(dirname(fileURLToPath(import.meta.url)));
const MODELS = join(WEB, "public/models/ocr");
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const jsonAt = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const rectify = !args.includes("--no-rectify");
if (!dir) {
  console.error("사용법: pnpm ocr:bench <사진 폴더> [--json out.json] [--no-rectify]");
  process.exit(2);
}

ort.env.wasm.wasmPaths = pathToFileURL(join(WEB, "public/ort/")).href;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

const det = await ort.InferenceSession.create(readFileSync(join(MODELS, "ch_PP-OCRv5_det_mobile.onnx")), { executionProviders: ["wasm"] });
const rec = await ort.InferenceSession.create(readFileSync(join(MODELS, "korean_PP-OCRv5_rec_mobile.onnx")), { executionProviders: ["wasm"] });
const charset = buildCharset(readFileSync(join(MODELS, "ppocrv5_korean_dict.txt"), "utf8"));

/** apps/web/src/lib/imagePipeline.ts loadCanvas — EXIF 보정 + 긴 변 2000 */
async function loadRgba(file, maxSide = 2000) {
  const img = sharp(file).rotate();
  const meta = await img.metadata();
  const scale = Math.min(1, maxSide / Math.max(meta.width, meta.height));
  const width = Math.round(meta.width * scale);
  const height = Math.round(meta.height * scale);
  const data = await img.resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer();
  return { width, height, data, channels: 4 };
}

const resizeRgba = async (src, width, height) =>
  sharp(Buffer.from(src.data), { raw: { width: src.width, height: src.height, channels: 4 } })
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();

/** apps/web/src/lib/ocrPaddle.ts ocrCanvasPaddle 과 같은 순서 */
async function ocrLines(src) {
  const size = detResize(src.width, src.height);
  const resized = await resizeRgba(src, size.width, size.height);
  const { data: small, applied } = autoContrast({ width: size.width, height: size.height, data: resized });
  lastContrast = applied;
  await dump("det", { width: size.width, height: size.height, data: small });
  const out = await det.run({
    [det.inputNames[0]]: new ort.Tensor("float32", normalizeDetInput({ width: size.width, height: size.height, data: small }), [1, 3, size.height, size.width]),
  });
  const prob = out[det.outputNames[0]];
  const pw = Number(prob.dims[prob.dims.length - 1]);
  const ph = Number(prob.dims[prob.dims.length - 2]);
  const boxes = sortBoxesReadingOrder(dbBoxes(prob.data, pw, ph, { ratioX: src.width / pw, ratioY: src.height / ph }));
  const lines = [];
  const dropped = [];
  for (const box of boxes) {
    const quad = recCropQuad(box.quad);
    const cropW = recCropWidth(quad);
    const padW = recPadWidth(cropW);
    const crop = warpPerspective(src, quad, cropW, REC_HEIGHT);
    const r = await rec.run({
      [rec.inputNames[0]]: new ort.Tensor("float32", normalizeRecInput({ width: cropW, height: REC_HEIGHT, data: crop }, padW), [1, 3, REC_HEIGHT, padW]),
    });
    const L = r[rec.outputNames[0]];
    const { text, confidence } = decodeCtc(L.data, Number(L.dims[1]), Number(L.dims[2]), charset);
    const t = text.trim();
    if (t && confidence >= REC_DROP_SCORE) lines.push({ text: t, confidence: confidence * box.score, bbox: quadBBox(box.quad) });
    else if (t) dropped.push({ text: t, confidence: +confidence.toFixed(2) });
  }
  return { lines: mergeNumberRuns(mergeSpacedChars(lines)), dropped, boxes: boxes.length };
}

let lastContrast = false;
let dumpName = null;
const dumpDir = args.includes("--dump") ? args[args.indexOf("--dump") + 1] : null;
const dump = async (suffix, img) => {
  if (!dumpDir || !dumpName) return;
  await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toFile(join(dumpDir, `${dumpName}.${suffix}.png`));
};
const quadBBox = (q) => ({ x0: Math.min(...q.map((p) => p.x)), y0: Math.min(...q.map((p) => p.y)), x1: Math.max(...q.map((p) => p.x)), y1: Math.max(...q.map((p) => p.y)) });

const files = readdirSync(dir)
  .filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(extname(f)))
  .sort();
console.log(`${files.length}장 · 원근보정 ${rectify ? "켬" : "끔"}\n`);

const report = [];
for (const f of files) {
  const path = join(resolve(dir), f);
  const t0 = Date.now();
  const base = await loadRgba(path);
  let src = base;
  let detection = null;
  if (rectify) {
    detection = detectCardQuad(rgbaToGray(base.data, base.width, base.height));
    if (detection) {
      const { width, height } = rectifiedSize(detection.quad, 1600);
      src = { width, height, data: warpPerspective(base, detection.quad, width, height), channels: 4 };
    }
  }
  dumpName = basename(f, extname(f));
  await dump("rect", src);
  let { lines, dropped, boxes } = await ocrLines(src);
  // lib/ocr.ts 와 같은 폴백: 보정본에서 글자가 거의 안 나오면 원본으로 다시 읽는다
  let retried = false;
  if (lines.length < 4 && src !== base) {
    const again = await ocrLines(base);
    retried = true;
    if (again.lines.length > lines.length) ({ lines, dropped, boxes } = again), (src = base);
  }
  const parsed = parseBusinessCard(lines);
  const draft = toDraft(parsed.fields);
  const ms = Date.now() - t0;
  const round = (b) => (b ? [b.x0, b.y0, b.x1, b.y1].map((v) => Math.round(v)) : null);
  report.push({ file: f, detection: detection ? { method: detection.method, confidence: detection.confidence } : null, size: [src.width, src.height], boxes, lines: lines.map((l) => l.text), geom: lines.map((l) => ({ t: l.text, b: round(l.bbox) })), dropped, draft, unassigned: parsed.unassigned.map((u) => u.text), ms });

  console.log(`── ${basename(f)}  (${src.width}×${src.height}, 상자 ${boxes}개, ${ms}ms)`);
  console.log(`   명암보정: ${lastContrast ? "적용" : "불필요"}`);
  console.log(`   테두리: ${detection ? `${detection.method} conf=${detection.confidence}` : "못 찾음 → 원본 그대로"}${retried ? " · 보정본이 빈약해 원본으로 재시도" : ""}`);
  for (const l of lines) console.log(`   · ${l.text}`);
  if (dropped.length) console.log(`   (버림) ${dropped.map((d) => `${d.text}@${d.confidence}`).join(" | ")}`);
  console.log(`   → ${JSON.stringify(draft, null, 0)}`);
  if (parsed.unassigned.length) console.log(`   남은 줄: ${parsed.unassigned.map((u) => u.text).join(" | ")}`);
  console.log();
}

if (jsonAt) {
  writeFileSync(jsonAt, JSON.stringify(report, null, 2));
  console.log(`JSON → ${jsonAt}`);
}

const FIELDS = ["fullName", "company", "jobTitle", "department", "mobile", "phone", "fax", "email", "address", "website"];
const filled = Object.fromEntries(FIELDS.map((k) => [k, report.filter((r) => r.draft[k]).length]));
console.log("칸별 채움:", Object.entries(filled).map(([k, v]) => `${k} ${v}/${report.length}`).join(" · "));
