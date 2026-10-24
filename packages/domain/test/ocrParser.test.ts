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

// 정리(tidyOcrText)는 파서가 스스로 한다 — 사진에서 나온 줄을 손대지 않고 그대로 넣는다
const draft = (...texts: string[]) => {
  const lines = texts.map((t) => ({ text: t }));
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

  it("가운데 막대는 칸을 나누는 구분자다 — 지우지 않는다", () => {
    expect(tidyOcrText("Maria Smith | Engineering Dept. | Director")).toBe("Maria Smith | Engineering Dept. | Director");
    expect(tidyOcrText("홍길동 | 마케팅팀 | 팀장")).toBe("홍길동 | 마케팅팀 | 팀장");
    expect(tidyOcrText("| 杨强 · 총괄 |")).toBe("杨强 · 총괄");
  });

  it("파서가 정리를 스스로 한다 — 호출자가 미리 손댈 필요가 없다", () => {
    const d = draft("( 주 ) 그 린 코 스 메 틱", "최 민 서", "| 영업지원팀", "|", "M. 010-1234-5678");
    expect(d.fullName).toBe("최민서");
    expect(d.company).toBe("(주) 그린코스메틱");
    expect(d.department).toBe("영업지원팀");
    expect(d.mobile).toBe("010-1234-5678");
  });
});

describe("직책을 이름보다 먼저 찍은 줄", () => {
  it("'이사 최원석' 에서 이름을 집어낸다", () => {
    const d = draft("SAE JEUN CONST.CO.,LTD.", "이사 최원석", "H.P:010-4927-1175");
    expect(d.fullName).toBe("최원석");
    expect(d.jobTitle).toBe("이사");
  });

  it("직책 낱말을 이름으로 보지 않는다", () => {
    // 'Director/대표이사' 의 대표이사는 네 글자 한글이라 이름 조건을 통과해 버린다
    const d = draft("(주)티브랜딩", "정승호", "Director/대표이사");
    expect(d.fullName).toBe("정승호");
    expect(d.jobTitle).toBe("Director/대표이사");
  });

  it("두 쪽이 다 자격증이면 이름을 만들지 않는다", () => {
    const d = draft("서율회계법인", "공인회계사/세무사", "Tel. 02-735-2425");
    expect(d.fullName).toBeUndefined();
    expect(d.jobTitle).toBe("공인회계사/세무사");
    expect(d.company).toBe("서율회계법인");
  });
});

describe("이름이 아닌 줄을 이름 칸에 넣지 않는다", () => {
  it("업무 낱말이 섞인 영문 두 낱말은 사람 이름이 아니다", () => {
    const d = draft("Medical Community", "MCOM", "dshin3@medicalcom.co.kr");
    expect(d.fullName).toBeUndefined();
  });

  it("보통의 영문 이름은 그대로 잡는다", () => {
    const d = draft("Acme Labs", "Jane Doe", "jane@acme.com");
    expect(d.fullName).toBe("Jane Doe");
  });

  it("조사로 끝나는 문구 조각은 회사가 아니다", () => {
    const d = draft("건강컨설팅의", "유선영", "yoosonia@gmail.com");
    expect(d.company).not.toBe("건강컨설팅의");
    expect(d.fullName).toBe("유선영");
  });

  it("쉼표가 든 줄은 부서가 아니다 (주소 조각)", () => {
    const d = draft("Kim Seong Kwang", "Incheon, Korea", "as817@hanmail.net");
    expect(d.department).not.toBe("Incheon, Korea");
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

describe("OCR 이 읽었는데 분류가 놓치던 것들", () => {
  it("이름 줄이 두 번 나오고 한 번은 앞 글자를 흘렸을 때", () => {
    // "남기훈" 과 "기훈 부장" 이 함께 나온다 — '기훈' 도 성씨로 시작해 이름 판정을 통과한다
    const d = draft("한결테크놀로지", "구매부", "남기훈", "기훈 부장", "M. 010-8080-1212");
    expect(d.fullName).toBe("남기훈");
    expect(d.jobTitle).toBe("부장");
  });

  it("부서가 깨져 꼬리말을 잃으면 직책에 붙이지 않는다", () => {
    // "영업3팀" 이 "영업36" 으로 읽힌 경우
    const d = draft("세일무역", "기 태랑 영업36 팀장", "휴대폰 010-8181-2929");
    expect(d.fullName).toBe("기 태랑");
    expect(d.jobTitle).toBe("팀장");
  });

  /*
   * 예전에는 '남은 짧은 줄' 을 부서로 보아 "Global Sourcing" 을 되찾았다.
   * 실제로 찍은 명함 13장으로 재 보니 그 갈래가 아홉 장에서 틀렸다 —
   * 태그라인·로마자 이름·한자 상호·모임 이름, 심지어 사람 이름까지 부서가 됐다.
   * 틀린 부서는 연락처에 그대로 박히므로 빈 부서보다 나쁘다. 추측을 그만뒀다.
   * 나머지 칸은 그대로 잡혀야 한다.
   */
  it("꼬리말 없는 줄은 부서로 추측하지 않는다", () => {
    const d = draft("Northgate Beauty Ltd", "Oliver Hartley", "Category Manager", "Global Sourcing",
      "Mobile +44 7700 900123");
    expect(d.company).toBe("Northgate Beauty Ltd");
    expect(d.fullName).toBe("Oliver Hartley");
    expect(d.jobTitle).toBe("Category Manager");
    expect(d.department).toBeUndefined();
  });

  it("꼬리말이 있으면 부서를 잡는다", () => {
    const d = draft("한빛솔루션", "김수민", "해외영업팀", "과장", "010-2345-6789");
    expect(d.department).toBe("해외영업팀");
    expect(d.fullName).toBe("김수민");
  });

  it("이름은 직책 줄 옆을 먼저 본다 (지점 이름에 뺏기지 않는다)", () => {
    const d = draft("차돌삼합 진대감", "선릉점", "대표", "박제인", "M 010.4741.1177");
    expect(d.fullName).toBe("박제인");
    expect(d.company).toBe("차돌삼합 진대감");
  });

  it("이름 줄에 로마자 표기가 구분자로 붙어도 한글 이름을 집는다", () => {
    const d = draft("orner studio", "이수진 | SU JIN LEE", "Space Design Director", "010-3229-4983");
    expect(d.fullName).toBe("이수진");
  });

  it("로마자 병기는 회사가 아니다 (이름 옆 줄이어도)", () => {
    const d = draft("SOULRISE", "대표이사 · CEO", "윤종석", "JONGSEOK YOON", "010-7788-3313");
    expect(d.fullName).toBe("윤종석");
    expect(d.company).toBe("SOULRISE");
  });

  it("세 글자 한글 상호는 이름 옆에 있어도 회사로 잡는다", () => {
    const d = draft("BNi PROMISE", "건강컨설팅의 프로", "유선영", "암웨이", "yoosonia@gmail.com");
    expect(d.fullName).toBe("유선영");
    expect(d.company).toBe("암웨이");
  });

  it("두 글자 한글 상호도 회사다", () => {
    const d = draft("이동준 대표변호사", "mobile 010. 5658. 0958", "www.yulamlaw.com", "율암");
    expect(d.company).toBe("율암");
    expect(d.fullName).toBe("이동준");
  });

  it("구분자 뒤에 공백을 둔 번호도 잡는다", () => {
    const d = draft("이동준 대표변호사", "mobile 010. 5658. 0958", "tel 02. 6959. 2558 | fax 02. 567. 2038");
    expect(d.mobile).toBe("010. 5658. 0958");
    expect(d.phone).toBe("02. 6959. 2558");
    expect(d.fax).toBe("02. 567. 2038");
  });

  it("라벨 뒤에 지역번호 괄호가 열려도 팩스로 본다", () => {
    const d = draft("세전건설", "이사 최원석", "TEL : (031)206-5067", "FAX : (031)205-6376");
    expect(d.fax).toBe("031)205-6376");
  });

  it("직책 뒤에 오는 부서도 잡는다", () => {
    const d = draft("한성자동차(주)", "임승관 부장", "Sales Senior | 서초 전시장 영업팀");
    expect(d.department).toBe("서초 전시장 영업팀");
    expect(d.fullName).toBe("임승관");
  });

  it("로마자로 적은 한국 주소도 주소다", () => {
    const d = draft("Kim Seong Kwang", "Team Leader", "14, 443, Anaji-ro, Gyeyang-gu,", "M. +82 10 2934 7976");
    expect(d.address).toBe("14, 443, Anaji-ro, Gyeyang-gu,");
  });

  it("한자 이름 뒤 한 글자 찌꺼기는 버린다", () => {
    expect(draft("广州华美化妆品有限公司", "采购部", "李建国 此", "H.P 139 8765 4321").fullName).toBe("李建国");
  });

  it("한자 이름의 띄어쓰기는 지킨다", () => {
    expect(tidyOcrText("佐藤 健一")).toBe("佐藤 健一");
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
