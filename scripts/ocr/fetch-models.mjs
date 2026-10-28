#!/usr/bin/env node
/*
 * F-015: PP-OCRv5(PaddleOCR) 모델을 apps/web/public/ 아래로 내려 둔다.
 *
 * 모델 파일은 합쳐 30MB 가 넘어 저장소에 담지 않는다. 내려 두면 기기 내 OCR 엔진이
 * tesseract 대신 PP-OCRv5 를 쓰고(apps/web/src/lib/ocr.ts), 없으면 그대로 tesseract 로 돈다.
 *
 *   node scripts/ocr/fetch-models.mjs            # 받고, 해시 확인하고, ort wasm 복사
 *   node scripts/ocr/fetch-models.mjs --force    # 이미 있어도 다시 받는다
 *
 * 출처: PaddleOCR(Apache-2.0) 의 PP-OCRv5 추론 모델을 RapidOCR 프로젝트가 ONNX 로
 * 변환해 공개한 것(ModelScope 미러). 사전 파일도 같은 곳이다.
 * 모델 가중치는 PaddlePaddle 쪽 라이선스를 따르므로, 배포 전 해당 조건을 확인한다.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "apps/web/public/models/ocr");
const ORT_OUT = join(ROOT, "apps/web/public/ort");
const BASE = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0";
const force = process.argv.includes("--force");

/*
 * 해시는 RapidOCR default_models.yaml 에 적힌 값이다. 사전 파일에는 거기 해시가 없어
 * 2026-10-22 에 받은 것을 직접 재어 적었다 — 사전이 한 줄이라도 달라지면 CTC 인덱스가
 * 통째로 밀려 글자가 조용히 어긋난다(모델 출력 클래스 수 = 사전 줄 수 + blank + 공백).
 */
const FILES = [
  { name: "ch_PP-OCRv5_det_mobile.onnx", url: `${BASE}/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx`, sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae" },
  { name: "korean_PP-OCRv5_rec_mobile.onnx", url: `${BASE}/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx`, sha256: "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b" },
  { name: "ch_PP-OCRv5_rec_mobile.onnx", url: `${BASE}/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx`, sha256: "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5" },
  { name: "ppocrv5_korean_dict.txt", url: `${BASE}/paddle/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile/ppocrv5_korean_dict.txt`, sha256: "a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7" },
  { name: "ppocrv5_dict.txt", url: `${BASE}/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt`, sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b" },
];

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

async function download(f) {
  const target = join(OUT, f.name);
  if (!force && existsSync(target)) {
    if (!f.sha256 || createHash("sha256").update(readFileSync(target)).digest("hex") === f.sha256) {
      console.log(`· ${f.name} — 이미 있음 (${mb(statSync(target).size)})`);
      return true;
    }
    console.log(`· ${f.name} — 해시가 달라 다시 받는다`);
  }
  process.stdout.write(`↓ ${f.name} … `);
  const res = await fetch(f.url, { redirect: "follow" });
  if (!res.ok) {
    console.log(`실패 (HTTP ${res.status})`);
    return false;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (f.sha256) {
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== f.sha256) {
      console.log(`해시 불일치\n  기대 ${f.sha256}\n  받음 ${got}`);
      return false;
    }
  }
  writeFileSync(target, buf);
  console.log(`${mb(buf.length)}${f.sha256 ? " · 해시 확인" : ""}`);
  return true;
}

/** onnxruntime-web 의 wasm/mjs 런타임을 같은 도메인에서 서빙한다 (바깥 CDN 을 쓰지 않는다). */
function copyOrtRuntime() {
  const dist = join(ROOT, "node_modules/onnxruntime-web/dist");
  if (!existsSync(dist)) {
    const alt = join(ROOT, "apps/web/node_modules/onnxruntime-web/dist");
    if (!existsSync(alt)) {
      console.log("· onnxruntime-web 이 설치돼 있지 않다 — pnpm i 먼저");
      return false;
    }
    return copyFrom(alt);
  }
  return copyFrom(dist);
}

function copyFrom(dist) {
  let n = 0;
  for (const name of readdirSync(dist)) {
    if (!/\.(wasm|mjs)$/.test(name)) continue;
    copyFileSync(join(dist, name), join(ORT_OUT, name));
    n++;
  }
  console.log(`· onnxruntime 런타임 ${n}개 복사 → public/ort/`);
  return n > 0;
}

mkdirSync(OUT, { recursive: true });
mkdirSync(ORT_OUT, { recursive: true });

let ok = true;
for (const f of FILES) ok = (await download(f)) && ok;
ok = copyOrtRuntime() && ok;

if (ok) {
  console.log("\n완료 — 다음 스캔부터 PP-OCRv5 로 읽는다 (모델이 없으면 tesseract).");
} else {
  console.log("\n일부를 받지 못했다. 모델이 없으면 tesseract 로 돌아가므로 기능은 멈추지 않는다.");
  process.exitCode = 1;
}
