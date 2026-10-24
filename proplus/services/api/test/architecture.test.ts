/**
 * 아키텍처 불변식 테스트 — 전략 §2(비타협 원칙) · §3(계층 규칙)
 *
 * 이 파일은 동작이 아니라 **구조**를 검사한다. 왜 그게 필요한가:
 *   N-2("배지는 결제로 얻을 수 없다")나 계층 규칙은 "어떤 코드가 **없어야** 한다"는 형태의
 *   규칙이다. 그런 규칙은 일반 단위테스트로 지킬 수 없다 — 잘못된 코드를 **추가**하는 순간
 *   깨지는데, 추가된 코드에는 테스트가 따라오지 않기 때문이다.
 *   그래서 소스를 읽어 금지 패턴을 찾는다. 느리지만 한 번 돌면 전체를 덮는다.
 *
 * DB 를 쓰지 않으므로 로컬에서도 돈다 (모듈 통합테스트는 Postgres 가 필요해 CI 전용이다).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = resolve(here, "../src/modules");
const LIB_DIR = resolve(here, "../src/lib");
const DOMAIN_DIR = resolve(here, "../../../packages/domain/src");
const WEB_SRC = resolve(here, "../../../apps/web/src");

function tsFiles(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(tsFiles(p));
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, "utf8");
}

/**
 * 주석을 지운 코드만 돌려준다. 주석에는 규칙을 **설명하는** 문장이 들어 있어서
 * (예: "이 파일은 subscriptions 를 조회하지 않는다") 원문 그대로 검사하면 전부 오탐이 된다.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const moduleFiles = tsFiles(MODULES_DIR);
const domainFiles = tsFiles(DOMAIN_DIR);

describe("전략 §3: 모듈 목록이 기술백서 §2 의 모듈 경계와 일치한다", () => {
  it("11개 모듈만 존재한다 (임의 이름의 모듈 추가 차단)", () => {
    const names = moduleFiles.map((f) => f.split(/[\\/]/).pop()!.replace(/\.ts$/, "")).sort();
    expect(names).toEqual(
      ["admin", "analytics", "billing", "booking", "catalog", "identity", "lead", "org", "profile", "proof", "search"],
    );
  });
});

describe("N-2: 배지 발급 경로에 결제가 닿지 않는다 (보안정책 §4.10)", () => {
  const proof = codeOnly(read(join(MODULES_DIR, "proof.ts")));

  it("proof 모듈은 subscriptions·plans 테이블을 조회하지 않는다", () => {
    expect(proof).not.toMatch(/\bsubscriptions\b/);
    expect(proof).not.toMatch(/\bFROM\s+plans\b/i);
  });

  it("proof 모듈은 billing 모듈을 import 하지 않는다 (import 방향 고정)", () => {
    expect(proof).not.toMatch(/from\s+["']\.\/billing["']/);
  });

  it("billing 모듈은 proof 모듈을 import 하지 않는다", () => {
    const billing = codeOnly(read(join(MODULES_DIR, "billing.ts")));
    expect(billing).not.toMatch(/from\s+["']\.\/proof["']/);
  });

  it("도메인 배지 정책에 요금제 타입이 들어오지 않는다", () => {
    const badge = codeOnly(read(join(DOMAIN_DIR, "badge.ts")));
    expect(badge).not.toMatch(/PlanLimits|planCode|subscription/i);
  });

  it("PlanLimits 에 배지·검증 관련 키가 없다", () => {
    const plans = read(join(DOMAIN_DIR, "plans.ts"));
    const iface = /export interface PlanLimits \{([\s\S]*?)\n\}/.exec(plans)?.[1] ?? "";
    expect(iface.length).toBeGreaterThan(0);
    expect(iface).not.toMatch(/badge|verif|proof|trust/i);
  });
});

describe("전략 §3: 도메인 패키지는 I/O 를 하지 않는다", () => {
  it("pg·fs·fetch·http 를 import 하지 않는다", () => {
    for (const f of domainFiles) {
      const src = codeOnly(read(f));
      expect(src, `${f} 가 pg 를 import 한다`).not.toMatch(/from\s+["']pg["']/);
      expect(src, `${f} 가 node:fs 를 import 한다`).not.toMatch(/from\s+["']node:fs/);
      expect(src, `${f} 가 node:http 를 import 한다`).not.toMatch(/from\s+["']node:http/);
      expect(src, `${f} 가 fetch 를 호출한다`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("Date.now()·new Date() 를 쓰지 않는다 (now 를 인자로 받는다)", () => {
    // 만료 판정(N-9)을 테스트에서 재현 가능하게 유지하려는 규칙이다.
    for (const f of domainFiles) {
      const src = codeOnly(read(f));
      expect(src, `${f} 가 Date.now() 를 쓴다`).not.toMatch(/Date\.now\s*\(/);
      // `new Date(x)` 는 파싱용이라 허용한다. 인자 없는 `new Date()` 만 금지한다.
      expect(src, `${f} 가 new Date() 를 쓴다`).not.toMatch(/new Date\s*\(\s*\)/);
    }
  });

  it("process.env 를 읽지 않는다 (설정은 호출부가 주입한다)", () => {
    for (const f of domainFiles) {
      expect(codeOnly(read(f)), `${f} 가 process.env 를 읽는다`).not.toMatch(/process\.env/);
    }
  });
});

describe("전략 §3: 모듈 계층은 HTTP 를 모른다", () => {
  it("next/server·NextRequest·cookies 를 import 하지 않는다", () => {
    for (const f of [...moduleFiles, ...tsFiles(LIB_DIR)]) {
      const src = codeOnly(read(f));
      expect(src, `${f} 가 next/* 를 import 한다`).not.toMatch(/from\s+["']next\//);
      expect(src, `${f} 가 NextRequest 를 쓴다`).not.toMatch(/\bNextRequest\b|\bNextResponse\b/);
    }
  });
});

describe("N-183: outbox 는 트랜잭션 client 만 받는다", () => {
  it("enqueue 에 pool 오버로드가 생기지 않았다", () => {
    const outbox = read(join(LIB_DIR, "outbox.ts"));
    // 시그니처가 PoolClient 하나뿐이어야 한다. Pool 을 받게 되면 도메인 쓰기와
    // 이벤트가 다른 트랜잭션에 들어가고, 그 순간 "배지는 취소됐는데 외부는 유효하다고 안다" 가 가능해진다.
    expect(outbox).toMatch(/export async function enqueue\(\s*client:\s*PoolClient/);
    expect(outbox).not.toMatch(/client:\s*Pool\b/);
    expect(outbox).not.toMatch(/client:\s*Db\b/);
  });

  it("모듈이 enqueue 를 쓸 때는 tx 안이다", () => {
    // 느슨한 검사: enqueue 를 호출하는 파일은 tx( 도 써야 한다.
    for (const f of moduleFiles) {
      const src = codeOnly(read(f));
      if (/\benqueue\s*\(/.test(src)) {
        expect(src, `${f} 가 tx() 없이 enqueue 를 호출한다`).toMatch(/\btx\s*\(/);
      }
    }
  });
});

describe("N-4 / ADR-002: 공개 조회는 뷰를 거친다", () => {
  it("공개 프로필 조회가 profiles 테이블을 직접 읽지 않는다", () => {
    const profile = codeOnly(read(join(MODULES_DIR, "profile.ts")));
    const fn = /export async function getPublicProfile[\s\S]*?\n\}/.exec(profile)?.[0] ?? "";
    expect(fn.length, "getPublicProfile 을 찾지 못했다").toBeGreaterThan(0);
    expect(fn).toMatch(/public_profile_view/);
    expect(fn).not.toMatch(/FROM\s+profiles\b/i);
  });

  it("검색 인덱싱 입력이 public_profile_view 뿐이다 (P-197)", () => {
    const search = codeOnly(read(join(MODULES_DIR, "search.ts")));
    expect(search).toMatch(/public_profile_view/);
    // 원본 테이블을 FROM 으로 쓰면 비공개 필드가 인덱스에 들어갈 수 있다.
    expect(search).not.toMatch(/FROM\s+profiles\b/i);
  });

  it("공개 배지 조회가 badges 테이블을 직접 읽지 않는다 (N-9 만료 판정 우회 금지)", () => {
    const proof = codeOnly(read(join(MODULES_DIR, "proof.ts")));
    const fn = /export async function listBadges[\s\S]*?\n\}/.exec(proof)?.[0] ?? "";
    expect(fn.length, "listBadges 를 찾지 못했다").toBeGreaterThan(0);
    expect(fn).toMatch(/public_badge_view/);
  });
});

describe("CLAUDE.md §5: SQL 은 파라미터 바인딩만 쓴다", () => {
  /**
   * SQL 템플릿 안의 보간을 전부 금지할 수는 없다 — 자리표시자 생성기(`p.add(v)` → `"$3"`),
   * 조립된 조건 조각(`where.join(" AND ")`), 고정 SELECT 상수는 정당하고 실제로 쓰인다.
   * 그래서 "보간이 있는가"가 아니라 **"요청에서 온 값이 그대로 보간됐는가"** 를 본다.
   *
   * 잡으려는 실수는 하나다: `filter.stage`·`input.slug`·`opts.x` 같은 요청 필드를
   * `$n` 을 거치지 않고 SQL 문자열에 끼워 넣는 것. 그게 이 저장소에서 가능한 유일한
   * injection 경로다(ADR-007: ORM 이 없으므로 생 SQL 을 쓴다).
   */
  const REQUEST_SHAPED = /\$\{\s*(?:filter|input|opts|params|body|query|req|ctx)\s*\.\s*[A-Za-z_$][\w$]*\s*\}/;

  it("요청 필드가 자리표시자를 거치지 않고 SQL 에 들어가지 않는다", () => {
    const suspicious: string[] = [];
    for (const f of moduleFiles) {
      const src = read(f);
      for (const m of src.matchAll(/`[^`]*\b(?:WHERE|VALUES|SET|ORDER\s+BY|LIMIT|OFFSET)\b[^`]*`/gi)) {
        const q = m[0];
        if (REQUEST_SHAPED.test(q)) suspicious.push(`${f}: ${q.slice(0, 140).replace(/\s+/g, " ")}`);
      }
    }
    expect(suspicious, `요청 입력이 보간된 SQL:\n${suspicious.join("\n")}`).toEqual([]);
  });

  it("자리표시자 생성기가 실제로 `$n` 을 만든다 (보간이 안전한 이유의 근거)", () => {
    // 위 테스트가 느슨한 대신, 조립형 쿼리를 쓰는 모듈에는 Params 류 생성기가 있어야 한다.
    for (const f of moduleFiles) {
      const src = read(f);
      const composes = /\$\{\s*where\.join|\$\{\s*p\.add\(/.test(src);
      if (!composes) continue;
      expect(src, `${f} 가 조립형 쿼리를 쓰는데 자리표시자 생성기가 없다`).toMatch(/return `\$\$\{this\.values\.length\}`|\$\{this\.values\.length\}/);
    }
  });
});

describe("SQL 자리표시자와 인자 개수가 맞는다", () => {
  /**
   * TypeScript 가 **절대 잡지 못하는** 버그 하나를 기계로 막는다: `$9` 를 쓰면서 인자를 8개만 넘기는 것.
   * 증상은 런타임 `there is no parameter $9` 이고, 그 쿼리를 타는 기능이 통째로 죽는다.
   * 실제로 `profile.writeProfile()` 에서 `region` 이 빠져 `updateProfile`·`restoreVersion` 이
   * 항상 실패하고 있었다 — 타입체크·빌드·단위테스트가 모두 통과한 채로.
   *
   * 검사 방식: 백틱 SQL 안의 최대 `$N` 과, 바로 뒤 배열 리터럴의 최상위 콤마 개수를 비교한다.
   * 파싱이 확실하지 않은 호출(변수로 넘긴 배열, 스프레드, 중첩 템플릿)은 **건너뛴다** —
   * 거짓 실패로 테스트를 못 믿게 만드는 것보다, 잡을 수 있는 것만 확실히 잡는 편이 낫다.
   */
  function topLevelCount(arrayLiteral: string): number | null {
    let depth = 0;
    let count = 1;
    let inStr: string | null = null;
    for (let i = 0; i < arrayLiteral.length; i++) {
      const ch = arrayLiteral[i]!;
      const prev = arrayLiteral[i - 1];
      if (inStr) {
        if (ch === inStr && prev !== "\\") inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) count++;
      // 스프레드가 있으면 개수를 셀 수 없다.
      if (ch === "." && arrayLiteral.slice(i, i + 3) === "...") return null;
    }
    return arrayLiteral.trim() === "" ? 0 : count;
  }

  it("백틱 SQL 의 최대 $N 이 인자 배열 길이를 넘지 않는다", () => {
    const problems: string[] = [];
    for (const f of moduleFiles) {
      // 주석을 먼저 지운다. SQL 과 인자 배열 **사이에 주석 줄이 끼면** 아래 패턴이 어긋나
      // 검사가 조용히 건너뛴다 — 실제로 그래서 첫 버전이 알려진 버그를 놓쳤다.
      const src = codeOnly(read(f));
      // `...SQL...`, [ ... ]  형태만 본다.
      for (const m of src.matchAll(/`((?:[^`\\]|\\.)*\$\d(?:[^`\\]|\\.)*)`\s*,\s*\[([^\][]*)\]/g)) {
        const sql = m[1] ?? "";
        const args = m[2] ?? "";
        const nums = [...sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
        if (nums.length === 0) continue;
        const maxN = Math.max(...nums);
        const argc = topLevelCount(args);
        if (argc === null) continue; // 스프레드 등 — 셀 수 없으면 건너뛴다
        if (argc < maxN) {
          problems.push(`${f}: $${maxN} 까지 쓰는데 인자는 ${argc}개 — ${sql.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
    expect(problems, `자리표시자/인자 불일치:\n${problems.join("\n")}`).toEqual([]);
  });
});

describe("N-10: 임의 코드 실행 경로가 없다 (CSP 의 'unsafe-inline' 을 보상하는 통제)", () => {
  /**
   * `next.config.ts` 의 CSP 는 Next 16.4 의 nonce 미동작 때문에 `script-src 'unsafe-inline'` 을 쓴다.
   * 그래서 N-10 의 실질적 방어선이 **코드 쪽으로** 옮겨왔다 — 이 테스트가 그 방어선이다.
   *
   * 막는 것: 사용자 데이터가 HTML·코드로 **파싱될 경로**. React 는 보간 문자열을 자동
   * 이스케이프하므로, 그걸 우회하는 수단(아래 목록)이 저장소에 없으면 사용자 입력은 실행되지 않는다.
   */
  const uiFiles = tsFiles(WEB_SRC);

  it("dangerouslySetInnerHTML 을 쓰지 않는다", () => {
    for (const f of uiFiles) {
      expect(codeOnly(read(f)), `${f} 가 dangerouslySetInnerHTML 을 쓴다`).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });

  it("eval · new Function · setTimeout(문자열) 을 쓰지 않는다", () => {
    for (const f of [...uiFiles, ...moduleFiles, ...domainFiles]) {
      const src = codeOnly(read(f));
      expect(src, `${f} 가 eval 을 쓴다`).not.toMatch(/\beval\s*\(/);
      expect(src, `${f} 가 new Function 을 쓴다`).not.toMatch(/new\s+Function\s*\(/);
      // setTimeout("코드문자열") 은 eval 과 같다. 함수 인자는 정상이므로 문자열 리터럴만 잡는다.
      expect(src, `${f} 가 setTimeout 에 문자열을 넘긴다`).not.toMatch(/set(?:Timeout|Interval)\s*\(\s*["'`]/);
    }
  });

  it("CSP 가 'unsafe-eval' 을 프로덕션에서 허용하지 않는다", () => {
    // 주석을 먼저 지운다 — 위 설명 블록에도 "script-src" 가 적혀 있어서 원문을 그대로 찾으면
    // 설명 문장이 먼저 걸리고, 테스트가 **코드가 아니라 주석을 검사**하게 된다.
    const cfg = codeOnly(read(resolve(WEB_SRC, "../next.config.ts")));
    const scriptSrc = /script-src[^\n]*/.exec(cfg)?.[0] ?? "";
    expect(scriptSrc, "script-src 를 찾지 못했다").not.toBe("");
    // 'unsafe-eval' 은 isDev 조건부로만 등장해야 한다. 조건 없이 박혀 있으면 eval 페이로드가 열린다.
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).toMatch(/isDev\s*\?/);
    // 조건 밖에 따로 적혀 있지는 않은지 — 조건식을 지운 뒤에도 남아 있으면 상시 허용이다.
    expect(scriptSrc.replace(/\$\{[^}]*\}/g, "")).not.toContain("'unsafe-eval'");
  });

  it("CSP 가 object-src·base-uri·form-action·frame-ancestors 를 잠근다", () => {
    const cfg = read(resolve(WEB_SRC, "../next.config.ts"));
    for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
      expect(cfg, `CSP 에 ${d} 가 없다`).toContain(d);
    }
  });

  it("CSP 를 내려보내는 곳이 한 군데다 (헤더 두 개면 브라우저가 교집합을 적용한다)", () => {
    const cfg = read(resolve(WEB_SRC, "../next.config.ts"));
    const occurrences = (cfg.match(/key:\s*"Content-Security-Policy"/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

describe("전략 §1: PROPLUS 는 LINKOS 를 import 하지 않는다", () => {
  it("@linkos/* 참조가 없다", () => {
    const all = [...moduleFiles, ...tsFiles(LIB_DIR), ...domainFiles, ...tsFiles(WEB_SRC)];
    for (const f of all) {
      expect(codeOnly(read(f)), `${f} 가 @linkos/* 를 import 한다`).not.toMatch(/@linkos\//);
    }
  });

  it("세션 쿠키 이름이 LINKOS 와 겹치지 않는다", () => {
    // 같은 브라우저에서 두 제품을 쓰면 쿠키 이름이 같을 때 서로의 세션을 덮어쓴다.
    const server = read(join(WEB_SRC, "lib/server.ts"));
    expect(server).toMatch(/pp_session/);
    expect(server).not.toMatch(/lk_session/);
  });
});
