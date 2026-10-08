// E. 명함 인식 구조화 (S-051 ~ S-062) — 다양한 실제 명함 레이아웃, 원문 외 값 생성 금지 검증
import { expect, test } from "@playwright/test";
import { anon } from "./helpers";

type Line = { text: string; confidence?: number };
async function parse(lines: Line[]) {
  const r = await (await anon()).post("/api/v1/capture/parse", { data: { lines } });
  expect(r.status()).toBe(200);
  const b = await r.json();
  // invariant: every extracted value appears verbatim in some input line
  for (const f of b.fields) expect(lines.some((l) => l.text.replace(/\s+/g, " ").includes(f.value)), `${f.key}=${f.value}`).toBe(true);
  const get = (k: string) => b.fields.find((f: { key: string }) => f.key === k)?.value;
  return { b, get };
}

test("S-051 한국 표준 명함(회사·이름 직책·휴대폰·이메일·주소·웹)", async () => {
  const { get, b } = await parse([{ text: "주식회사 링코스" }, { text: "김민지 팀장" }, { text: "M 010-2345-6789" }, { text: "minji@linkos.co.kr" }, { text: "서울특별시 성동구 성수이로 77, 5층" }, { text: "www.linkos.co.kr" }]);
  expect(get("company")).toBe("주식회사 링코스");
  expect(get("fullName")).toBe("김민지");
  expect(get("jobTitle")).toBe("팀장");
  expect(get("mobile")).toBe("010-2345-6789");
  expect(get("email")).toBe("minji@linkos.co.kr");
  expect(get("address")).toContain("성수이로");
  expect(b.language).toBe("ko");
});

test("S-052 영문 명함(이름 줄 + 직함 줄 + Inc.)", async () => {
  const { get } = await parse([{ text: "Daniel Kim" }, { text: "VP of Engineering" }, { text: "Northwind Systems Inc." }, { text: "daniel.kim@northwind.io" }, { text: "+1 650 555 0142" }]);
  expect(get("fullName")).toBe("Daniel Kim");
  expect(get("jobTitle")).toBe("VP of Engineering");
  expect(get("company")).toBe("Northwind Systems Inc.");
});

test("S-053 일본어 명함(株式会社, 部長)", async () => {
  const { get } = await parse([{ text: "株式会社サクラテック" }, { text: "営業部 部長" }, { text: "sato@sakura-tech.jp" }, { text: "03-1234-5678" }]);
  expect(get("company")).toBe("株式会社サクラテック");
  expect(get("email")).toBe("sato@sakura-tech.jp");
});

test("S-054 중국어 명함(有限公司, 总经理)", async () => {
  const { get } = await parse([{ text: "上海星辰科技有限公司" }, { text: "wang@xingchen.cn" }, { text: "+86 21 5555 6666" }]);
  expect(get("company")).toBe("上海星辰科技有限公司");
  expect(get("email")).toBe("wang@xingchen.cn");
});

test("S-055 한 줄에 Tel/Fax 함께 — 라벨로 구분", async () => {
  const { b } = await parse([{ text: "이준호 과장" }, { text: "Tel. 031-777-1234 / Fax. 031-777-1235" }]);
  const fax = b.fields.find((f: { key: string }) => f.key === "fax");
  const tel = b.fields.find((f: { key: string }) => f.key === "phone");
  expect(fax.value).toBe("031-777-1235");
  expect(tel.value).toBe("031-777-1234");
});

test("S-056 국제번호 +82 → E.164 정규화, 원문은 보존", async () => {
  const { b } = await parse([{ text: "Mobile +82 10-3333-4444" }]);
  const m = b.fields.find((f: { key: string }) => f.key === "mobile");
  expect(m.value).toBe("+82 10-3333-4444");
  expect(m.normalized).toBe("+821033334444");
});

test("S-057 이메일 2개 모두 추출", async () => {
  const { b } = await parse([{ text: "sales@acme.kr · ceo@acme.kr" }]);
  expect(b.fields.filter((f: { key: string }) => f.key === "email").map((f: { value: string }) => f.value)).toEqual(["sales@acme.kr", "ceo@acme.kr"]);
});

test("S-058 www 없는 도메인과 이메일 도메인을 혼동하지 않음", async () => {
  const { b } = await parse([{ text: "hello@studio.kr" }, { text: "studio.kr/portfolio" }]);
  const sites = b.fields.filter((f: { key: string }) => f.key === "website");
  expect(sites).toHaveLength(1);
  expect(sites[0].normalized).toBe("https://studio.kr/portfolio");
});

test("S-059 영문 주소(Suite, Street) 인식", async () => {
  const { get } = await parse([{ text: "Jane Park" }, { text: "500 Market Street, Suite 300, San Francisco" }]);
  expect(get("address")).toContain("Market Street");
});

test("S-060 글자 사이 띄어 쓴 한글 이름 '홍 길 동' 정규화", async () => {
  const { b } = await parse([{ text: "홍 길 동" }, { text: "hong@x.kr" }]);
  const n = b.fields.find((f: { key: string }) => f.key === "fullName");
  expect(n.value).toBe("홍 길 동");
  expect(n.normalized).toBe("홍길동");
});

test("S-061 저신뢰 OCR 줄은 검토 대상(needsReview)", async () => {
  const { b } = await parse([{ text: "박서준", confidence: 35 }]);
  expect(b.fields[0].needsReview).toBe(true);
});

test("S-062 의미 없는 잡음은 아무 값도 만들지 않음", async () => {
  const { b } = await parse([{ text: "|||| ~~~ ::" }, { text: "#### @@" }]);
  expect(b.fields).toHaveLength(0);
});
