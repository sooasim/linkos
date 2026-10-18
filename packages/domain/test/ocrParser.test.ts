/*
 * OCR 파서 — 실제로 찍은 명함 사진에서 나온 꼴들을 고정해 둔다.
 *
 * 여기 적힌 입력은 전부 tesseract 가 실제 사진에서 뱉은 줄이다(KBT 2026-10,
 * 사진 52장 측정). 규칙을 고칠 때 이 줄들이 다시 깨지지 않게 하려는 것이다.
 * 같은 규칙이 KBT 쪽 platform/assets/cardkit.js 에도 들어가 있다 —
 * 한쪽만 고치면 같은 명함을 다르게 읽게 되므로 둘을 함께 손본다.
 */
import { describe, expect, it } from "vitest";
import { assertGrounded, parseBusinessCard, tidyOcrText, toDraft } from "../src/ocrParser";

const draft = (...texts: string[]) => {
  const lines = texts.map((t) => ({ text: tidyOcrText(t) })).filter((l) => l.text);
  const r = parseBusinessCard(lines);
  assertGrounded(r.fields, lines);
  return toDraft(r.fields);
};

describe("tidyOcrText — 사진에서 섞여 들어온 찌꺼기", () => {
  it("음절마다 끊긴 줄을 되붙인다", () => {
    expect(tidyOcrText("최 민 서")).toBe("최민서");
    expect(tidyOcrText("구 매 팀 차장")).toBe("구매팀 차장");
    expect(tidyOcrText("( 주 ) 그 린 코 스 메 틱")).toBe("(주) 그린코스메틱");
  });

  it("인쇄선·테두리가 글자로 들어온 것을 치운다", () => {
    expect(tidyOcrText("| 영업지원팀")).toBe("영업지원팀");
    expect(tidyOcrText("최민서 a")).toBe("최민서");
    expect(tidyOcrText("강태웅 33")).toBe("강태웅");
    expect(tidyOcrText("|")).toBe("");
    expect(tidyOcrText("| Export Division")).toBe("Export Division");
  });

  it("메일 주소 안의 쉼표는 점을 잘못 읽은 것이다", () => {
    expect(tidyOcrText("Email ha,joo@shinkwang.co.kr")).toBe("Email ha.joo@shinkwang.co.kr");
  });

  it("멀쩡한 줄은 건드리지 않는다", () => {
    expect(tidyOcrText("홍길동 대표이사")).toBe("홍길동 대표이사");
    expect(tidyOcrText("M. 010-1234-5678")).toBe("M. 010-1234-5678");
    expect(tidyOcrText("Jane Doe, CEO")).toBe("Jane Doe, CEO");
    expect(tidyOcrText("이 사람은 담당자")).toBe("이 사람은 담당자");
  });
});

describe("한 줄에 붙은 이름·부서·직책", () => {
  it("이름 / 부서 / 직책", () => {
    const d = draft("준바이오셀", "임채원 해외영업팀/ 부장", "Mobile 010-2424-9696");
    expect(d.fullName).toBe("임채원");
    expect(d.department).toBe("해외영업팀");
    expect(d.jobTitle).toBe("부장");
  });

  it("끊긴 이름 + 숫자가 섞인 부서", () => {
    const d = draft("태성산업", "황 도윤 영업2팀 과장", "H.P 010-9292-3838");
    // toDraft 는 원문 조각을 그대로 돌려준다 — 붙인 값은 normalized 에 있다
    expect(d.fullName).toBe("황 도윤");
    expect(d.department).toBe("영업2팀");
    expect(d.jobTitle).toBe("과장");
  });

  it("부서 꼬리말로 끝나는 성명을 부서로 뺏기지 않는다", () => {
    expect(draft("김부 영업팀 과장", "㈜한빛").fullName).toBe("김부");
  });

  it("이름을 못 읽었으면 부서를 이름으로 쓰지 않는다", () => {
    const d = draft("영업 본부 이사", "블루오션무역", "M. 010-3333-2222");
    expect(d.fullName).toBeUndefined();
    expect(d.department).toBe("영업 본부");
    expect(d.jobTitle).toBe("이사");
  });

  it("영문 직책은 두 낱말을 지킨다", () => {
    const d = draft("Northgate Beauty Ltd", "Oliver Hartley", "Sales Director");
    expect(d.fullName).toBe("Oliver Hartley");
    expect(d.jobTitle).toBe("Sales Director");
  });
});

describe("회사 줄", () => {
  it("법인 표기 없는 업종 꼬리말", () => {
    expect(draft("이영희", "영업팀 과장", "서울무역상사").company).toBe("서울무역상사");
    expect(draft("오승현", "품질관리부 부장", "대광정밀").company).toBe("대광정밀");
  });

  it("㈜ 를 잘못 읽은 한 글자는 떼어 낸다", () => {
    expect(draft("준그린코스메틱", "정하윤", "M. 010-1111-2222").company).toBe("그린코스메틱");
    expect(draft("순퓨어스킨", "조현우", "M. 010-1111-2222").company).toBe("퓨어스킨");
  });

  it("실존 상호 '준오헤어' 는 깎지 않는다", () => {
    expect(draft("준오헤어", "김미영", "M. 010-1111-2222").company).toBe("준오헤어");
  });

  it("꼬리말이 없어도 맨 위에 남은 줄을 회사로 본다", () => {
    const d = draft("오가닉스킨랩", "해외사업팀", "팀장", "휴대폰 010-3579-2468");
    expect(d.company).toBe("오가닉스킨랩");
    expect(d.department).toBe("해외사업팀");
  });

  it("부서 줄을 회사로 집어가지 않는다", () => {
    expect(draft("해외영업팀", "김수민", "M. 010-1111-2222").company).toBeUndefined();
  });
});

describe("전화번호", () => {
  it("라벨이 숫자로 흘러도 표준꼴을 고른다", () => {
    expect(draft("주현아", "10616 010-9494-1616").mobile).toBe("010-9494-1616");
  });

  it("국제표기 — 두 자리씩 끊어 적는 나라", () => {
    const d = draft("Claire Dupont", "Mobile +33 6 12 34 56 78", "Tel +33 1 44 55 66 77");
    expect(d.mobile).toBe("+33 6 12 34 56 78");
    expect(d.phone).toBe("+33 1 44 55 66 77");
  });

  it("괄호 지역번호", () => {
    expect(draft("선우재현", "TEL 02)336-7788").phone).toBe("02)336-7788");
  });

  it("라벨 없는 반쪽 번호는 버린다", () => {
    expect(draft("미래글로벌", "구매팀", "2020-6464").phone).toBeUndefined();
  });
});

describe("이름", () => {
  it("OCR 이 같은 이름을 두 번 뱉으면 긴 쪽을 쓴다", () => {
    expect(draft("수비엔코스메틱", "우재현", "선우재현", "M. 010-1111-2222").fullName).toBe("선우재현");
  });

  it("일본·중국 이름도 이름으로 본다", () => {
    expect(draft("广州华美化妆品有限公司", "采购部", "王雪梅", "H.P 139 8765 4321").fullName).toBe("王雪梅");
  });

  it("끊긴 한글 이름은 붙여서 돌려준다", () => {
    const r = parseBusinessCard([{ text: "송 예린" }, { text: "한빛물산" }]);
    const name = r.fields.find((f) => f.key === "fullName");
    expect(name?.value).toBe("송 예린");       // 원문 조각 그대로
    expect(name?.normalized).toBe("송예린");   // 보여 줄 때 쓰는 값
  });
});

describe("지어내지 않는다", () => {
  it("분류한 값은 모두 원문의 일부다", () => {
    const lines = [
      { text: "㈜케이뷰티랩" }, { text: "마케팅팀 팀장" }, { text: "김수민" },
      { text: "M. 010-1234-5678" }, { text: "E. sumin@kbeautylab.co.kr" },
    ];
    const r = parseBusinessCard(lines);
    expect(() => assertGrounded(r.fields, lines)).not.toThrow();
  });
});
