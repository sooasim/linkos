// ADR-011 게이트 — **응답 HTML 의 `<script>` 태그에 CSP nonce 가 실제로 붙는지** 확인한다.
//
//   사용: node proplus/scripts/check-csp-nonce.mjs [http://127.0.0.1:4400/]
//
// ## 왜 이 검사가 필요한가
//
// ADR-011 은 Next 16.4.0 에서 nonce 가 동작하지 않는다는 측정으로 `script-src 'unsafe-inline'`
// 을 택했고, 그 ADR 이 남긴 경고가 이것이다: **헤더에 nonce 가 보이는 것만으로는 동작 증거가 아니다.**
// Next 는 CSP 헤더를 응답에 그대로 실어 보내면서도 렌더 컨텍스트에 nonce 를 전달하지 않을 수 있다.
// 그러면 `'strict-dynamic'` 때문에 `'self'` 가 무시되어 `/_next/static/chunks/*.js` 까지 전부 차단되는데,
// 서버는 200 을 주고 SSR 마크업도 정상이라 **빌드·타입체크·SSR 스모크가 전부 통과한다.**
// 깨지는 것은 브라우저의 하이드레이션뿐이라 사람이 버튼을 눌러 봐야 안다 — 그래서 기계로 확인한다.
//
// 검사하는 것:
//   1. CSP 응답 헤더에서 nonce 를 뽑는다
//   2. 여는 `<script>` 태그를 전부 세고, 그중 **몇 개에 그 nonce 가 붙었는지** 센다
//      (`<link rel=preload nonce>` 는 세지 않는다 — 스크립트 실행 여부와 무관하다)
//   3. RSC 페이로드에 `"nonce":"$undefined"` 가 찍혔는지 본다 (16.4.0 의 고장 신호)
//   4. HTML 이 참조하는 `/_next/static/chunks/*.js` 가 실제로 200 인지 받아 본다
//   5. **CSP 에 `'strict-dynamic'` 이 없는지** 본다 — 있으면 `'self'` 가 무시되어
//      nonce 를 넣을 수 없는 정적 오류 페이지(`_not-found`·`_global-error`)의 스크립트가
//      전부 차단된다. 2026-10-25 에 실제로 그걸 밟았다(ADR-011 갱신 절).

const target = process.argv[2] ?? "http://127.0.0.1:4400/";

const res = await fetch(target, { redirect: "manual" });
const html = await res.text();
const csp = res.headers.get("content-security-policy") ?? res.headers.get("content-security-policy-report-only") ?? "";

const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";

console.log(`대상: ${target}  (HTTP ${res.status})`);
console.log(`CSP: ${csp || "(없음)"}`);
console.log(`CSP nonce: ${nonce || "(없음)"}`);

const problems = [];
if (!nonce) problems.push("CSP 응답 헤더에 nonce 가 없다 — proxy.ts 가 매칭되지 않았거나 CSP 를 보내지 않는다.");

/**
 * `'strict-dynamic'` 은 `'self'` 를 무시한다. 그러면 요청별 nonce 를 넣을 수 없는 페이지
 * (빌드 시점에 굽는 `_not-found.html`·`_global-error.html`)의 스크립트가 **전부** 차단된다.
 * 아래 404 검사가 그걸 잡지만, 디렉티브 자체를 먼저 거부해서 이유를 분명히 말해 준다.
 */
if (/script-src[^;]*'strict-dynamic'/.test(csp)) {
  problems.push(
    "CSP 에 'strict-dynamic' 이 있다 — 'self' 가 무시되어 정적 오류 페이지가 전부 차단된다 (ADR-011 갱신 절).",
  );
}

// 여는 태그만 — 닫는 </script> 는 세지 않는다.
const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
const withNonce = nonce ? scriptTags.filter((t) => t.includes(`nonce="${nonce}"`)) : [];
const withoutNonce = scriptTags.filter((t) => !nonce || !t.includes(`nonce="${nonce}"`));

console.log(`전체 <script> 여는 태그: ${scriptTags.length}`);
console.log(`nonce 가 붙은 <script>: ${withNonce.length}`);
console.log(`nonce 가 없는 <script>: ${withoutNonce.length}`);
for (const t of withoutNonce) console.log(`  nonce 없음 → ${t.slice(0, 180)}`);

if (scriptTags.length === 0) problems.push("<script> 태그가 하나도 없다 — 측정 대상이 아니다(정적 오류 페이지인가?).");
// 'strict-dynamic' 이 있으면 nonce 없는 스크립트는 **전부** 차단된다. 하나도 빠지면 안 된다.
if (withoutNonce.length > 0) problems.push(`${withoutNonce.length}개의 <script> 에 nonce 가 없다 — 'strict-dynamic' 아래에서 차단된다.`);

const undef = (html.match(/"nonce":"\$undefined"/g) ?? []).length;
console.log(`RSC 페이로드의 "nonce":"$undefined": ${undef}개`);
if (undef > 0) problems.push('RSC 페이로드에 "nonce":"$undefined" 가 찍혔다 — nonce 가 렌더 컨텍스트에 도달하지 않았다.');

// 외부 청크가 실제로 받아지는지. `'strict-dynamic'` 은 `'self'` 를 무시하므로
// 부트스트랩 스크립트에 nonce 가 붙어야만 여기서 내려받는 청크들이 브라우저에서 실행된다.
const chunks = [...new Set((html.match(/\/_next\/static\/chunks\/[^"']+?\.js/g) ?? []))].slice(0, 12);
console.log(`참조된 /_next/static/chunks/*.js: ${chunks.length}개 (최대 12개 확인)`);
for (const c of chunks) {
  const r = await fetch(new URL(c, target));
  console.log(`  ${r.status}  ${c}`);
  if (!r.ok) problems.push(`${c} 가 ${r.status} 다 — 청크를 받을 수 없다.`);
}

/**
 * 404 페이지는 Next 가 빌드 시점에 구운 정적 HTML 이다(`_not-found.html`). 요청별 nonce 를
 * 넣을 수 없으므로, CSP 가 `'self'` 를 살려 두지 않으면 **외부 청크까지 전부** 차단된다.
 * 여기서는 "적어도 외부 청크는 받아진다"만 확인한다 — 인라인 부트스트랩이 막혀
 * 하이드레이션이 안 되는 것은 이 페이지들의 **의도된 상태**다
 * (`scripts/check-no-prerender.mjs` 주석: "하이드레이션이 필요 없다").
 */
const notFoundUrl = new URL("/__csp-nonce-probe-404__", target);
const nf = await fetch(notFoundUrl);
const nfHtml = await nf.text();
const nfExternal = (nfHtml.match(/<script\b[^>]*\bsrc=/g) ?? []).length;
console.log("");
console.log(`404 페이지(${notFoundUrl.pathname}): HTTP ${nf.status}, 외부 <script src> ${nfExternal}개`);
if (nf.status !== 404) {
  console.log("  (404 가 아니다 — 이 경로에 실제 라우트가 생겼나? 검사를 건너뛴다)");
} else {
  // 정적 페이지라 nonce 는 없는 게 정상이다. 'self' 가 살아 있으면 이 청크들은 받아진다.
  const nfChunks = [...new Set(nfHtml.match(/\/_next\/static\/chunks\/[^"']+?\.js/g) ?? [])].slice(0, 4);
  for (const c of nfChunks) {
    const r = await fetch(new URL(c, target));
    console.log(`  ${r.status}  ${c}`);
    if (!r.ok) problems.push(`404 페이지의 ${c} 가 ${r.status} 다.`);
  }
}

console.log("");
if (problems.length > 0) {
  console.error("check-csp-nonce: 실패");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nADR-011 참조: nonce 가 동작하지 않으면 'strict-dynamic' 을 두면 안 된다.");
  process.exit(1);
}
console.log("check-csp-nonce: 통과 — 모든 <script> 에 요청별 nonce 가 붙고 청크도 받아진다 (ADR-011 갱신 근거).");
