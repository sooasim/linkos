// F-015: 외부 OCR 어댑터(비전 모델) 를 같은 13장으로 재 본다 — 기기 내 PP-OCRv5 와 비교하려는 것.
//
//   pnpm ocr:bench:vision <사진 폴더> [--json out.json] [--model <id>]
//   키는 ANTHROPIC_API_KEY 환경변수 또는 --env <파일> 에서 읽는다 (화면에 찍지 않는다).
//
// 모델은 **글자만** 읽는다. 칸 가르기는 기기 내 경로와 똑같이 parseBusinessCard 가 한다 —
// 그래야 "원문에 없는 값 생성 금지"(CLAUDE.md 규칙 6)가 깨지지 않는다.
//
// ⚠️ 사진이 기기를 떠난다. 명함에는 남의 이름·전화·메일이 들어 있다. 측정용으로만 쓰고,
//    제품에 넣을 때는 사용자가 고른 경우에만 동작해야 한다.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import sharp from "sharp";
import { parseBusinessCard, toDraft } from "@linkos/domain";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
const pick = (flag, dflt) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : dflt);
const jsonAt = pick("--json", null);
const model = pick("--model", "claude-sonnet-5-5");
const envFile = pick("--env", null);

let key = process.env.ANTHROPIC_API_KEY ?? "";
let workspace = process.env.ANTHROPIC_WORKSPACE_ID ?? "";
if (envFile) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "ANTHROPIC_API_KEY" && !key) key = m[2].replace(/^["']|["']$/g, "");
    if (m[1] === "ANTHROPIC_WORKSPACE_ID" && !workspace) workspace = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!dir || !key) {
  console.error("사용법: pnpm ocr:bench:vision <사진 폴더> [--env <.env>] [--json out.json] [--model <id>]");
  console.error(key ? "" : "ANTHROPIC_API_KEY 가 없습니다.");
  process.exit(2);
}

// cards/vision.py 와 같은 지시문 — 보이는 글자만, 줄 단위로, 추측 금지
const PROMPT =
  "이 이미지는 명함입니다. 보이는 글자를 **그대로** 줄 단위로 옮겨 적으세요.\n" +
  "규칙:\n" +
  "1. 보이지 않는 정보는 절대 쓰지 마세요. 추측·보완·번역·요약을 하지 마세요.\n" +
  "2. 줄마다 한 줄씩, 인쇄된 순서대로 적으세요.\n" +
  "3. 설명·머리말·번호·따옴표를 붙이지 마세요. 글자만 적으세요.\n" +
  "4. 읽을 수 없는 부분은 그 줄을 건너뛰세요.\n";

const linesFromReply = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .map((raw) => raw.replace(/\s+/g, " ").trim().replace(/^[-*·•]\s*/, "").replace(/^\d+[.)]\s*/, ""))
    .filter((t) => t && !t.startsWith("```"))
    .map((text) => ({ text, confidence: 0.9 }));

async function readCard(path) {
  // 명함은 작게 보내도 충분히 읽힌다. 보내는 양을 줄이는 것이 비용·시간 모두에 낫다.
  const jpeg = await sharp(path).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      ...(workspace ? { "anthropic-workspace-id": workspace } : {}),
    },
    body: JSON.stringify({
      model,
      /*
       * 1024 로 두면 모델이 thinking 블록에 예산을 다 써서 글자 출력이 잘린다 —
       * 13장 중 2장이 통째로 빈 응답이었고, 한 장은 여섯 줄에서 끊겼다.
       * (cards/vision.py 의 max_tokens=1024 를 그대로 옮기면 똑같이 깨진다.)
       * 옮겨 적기에는 추론이 필요 없으므로 thinking 을 끄고 예산을 넉넉히 준다.
       */
      max_tokens: 4096,
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = (body.content ?? []).map((b) => b.text ?? "").join("\n");
  return { lines: linesFromReply(text), bytes: jpeg.length, usage: body.usage ?? null };
}

const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(extname(f))).sort();
console.log(`${files.length}장 · 모델 ${model}\n`);

const report = [];
let inTok = 0;
let outTok = 0;
for (const f of files) {
  const t0 = Date.now();
  try {
    const { lines, bytes, usage } = await readCard(join(resolve(dir), f));
    const parsed = parseBusinessCard(lines);
    const draft = toDraft(parsed.fields);
    inTok += usage?.input_tokens ?? 0;
    outTok += usage?.output_tokens ?? 0;
    report.push({ file: f, lines: lines.map((l) => l.text), draft, unassigned: parsed.unassigned.map((u) => u.text), ms: Date.now() - t0 });
    console.log(`── ${basename(f)}  (${Math.round(bytes / 1024)}KB, ${Date.now() - t0}ms)`);
    for (const l of lines) console.log(`   · ${l.text}`);
    console.log(`   → ${JSON.stringify(draft)}\n`);
  } catch (e) {
    report.push({ file: f, error: String(e.message).slice(0, 200) });
    console.log(`── ${basename(f)}  실패: ${String(e.message).slice(0, 160)}\n`);
  }
}

if (jsonAt) writeFileSync(jsonAt, JSON.stringify(report, null, 2));
const FIELDS = ["fullName", "company", "jobTitle", "department", "mobile", "phone", "fax", "email", "address", "website"];
const ok = report.filter((r) => r.draft);
console.log("칸별 채움:", FIELDS.map((k) => `${k} ${ok.filter((r) => r.draft[k]).length}/${report.length}`).join(" · "));
console.log(`토큰: 입력 ${inTok} · 출력 ${outTok}`);
