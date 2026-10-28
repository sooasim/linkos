// F-015: 내려 둔 PP-OCRv5 모델이 우리 코드가 전제한 모양·사전과 맞는지 본다.
//   pnpm ocr:verify            (모델이 없으면 그냥 건너뛴다)
//
// 순수 계산부(전처리·DB 후처리·CTC)는 packages/domain/test/ppocr.test.ts 가 잠근다.
// 여기서 잡는 것은 그 테스트가 볼 수 없는 두 가지다 —
//   ① 검출 모델이 [1,1,H,W] 확률맵을 돌려주는가 (아니면 dbBoxes 가 엉뚱한 걸 읽는다)
//   ② 인식 모델의 출력 클래스 수 = 사전 줄 수 + 2 인가 (어긋나면 글자가 통째로 밀린다)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ort from "onnxruntime-web";

const WEB = dirname(dirname(fileURLToPath(import.meta.url)));
const MODELS = join(WEB, "public/models/ocr");
const DET = "ch_PP-OCRv5_det_mobile.onnx";
const RECS = [
  ["korean_PP-OCRv5_rec_mobile.onnx", "ppocrv5_korean_dict.txt"],
  ["ch_PP-OCRv5_rec_mobile.onnx", "ppocrv5_dict.txt"],
];

if (!existsSync(join(MODELS, DET))) {
  console.log("모델이 없다 — 건너뛴다 (pnpm ocr:models 로 받는다). 스캔은 tesseract 로 돈다.");
  process.exit(0);
}

ort.env.wasm.wasmPaths = pathToFileURL(join(WEB, "public/ort/")).href;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";
const opts = { executionProviders: ["wasm"] };
let bad = 0;

const det = await ort.InferenceSession.create(readFileSync(join(MODELS, DET)), opts);
const probe = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * 64 * 64), [1, 3, 64, 64]) });
const dims = probe[det.outputNames[0]].dims;
if (dims.length !== 4 || Number(dims[1]) !== 1 || Number(dims[2]) !== 64 || Number(dims[3]) !== 64) {
  console.error(`✗ ${DET}: 확률맵이 [1,1,H,W] 가 아니다 → ${JSON.stringify(dims)}`);
  bad++;
} else console.log(`✓ ${DET}: 확률맵 ${JSON.stringify(dims)}`);

for (const [model, dict] of RECS) {
  const lines = readFileSync(join(MODELS, dict), "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const expected = lines.length + 2; // blank + 사전 + 공백
  const rec = await ort.InferenceSession.create(readFileSync(join(MODELS, model)), opts);
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * 48 * 320), [1, 3, 48, 320]) });
  const classes = Number(out[rec.outputNames[0]].dims[2]);
  if (classes !== expected) {
    console.error(`✗ ${model}: 클래스 ${classes} ≠ 사전 ${expected} (${dict}) — CTC 인덱스가 밀린다`);
    bad++;
  } else console.log(`✓ ${model}: 클래스 ${classes} = ${dict} ${lines.length}줄 + blank + 공백`);
}

process.exitCode = bad ? 1 : 0;
