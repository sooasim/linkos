/**
 * P-001 로그인 — 매직링크 요청 화면.
 *
 * 비밀번호 입력란이 없는 것이 설계다: `identity.requestLoginLink()` 는 주소로 1회성 링크만 보내고
 * **계정은 링크를 클릭한 시점에 만들어진다**(identity.ts 주석 2번). 그래서 "회원가입" 탭을 따로 두지
 * 않는다 — 가입과 로그인이 같은 동작이고, 탭을 나누면 화면이 없는 구분을 있는 것처럼 말하게 된다.
 *
 * 성공 문구가 가입 여부를 단정하지 않는 이유: 라우트 응답이 성공·미가입·정지를 **같은 모양**으로
 * 돌려준다(보안정책 §2 계정 열거). 화면이 서버보다 더 아는 척하면 그 자리가 계정 열거 도구가 된다.
 *
 * `DEMO_LOGIN` 은 **서버 환경변수**다. 클라이언트에서 `process.env` 를 읽으면 번들 시점 값이 박히거나
 * undefined 가 되므로 서버에서 읽어 prop 으로 내린다. 운영 기본값은 꺼짐이다.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer, safeNext } from "@/lib/server";
import { linkosSso } from "@proplus/api";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "로그인",
  // 로그인·검증 화면은 색인될 이유가 없다. 공개 대상은 /p/[slug] 뿐이다 (P-030).
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).next;
  // open redirect 방지는 서버에서 끝낸다 — 클라이언트는 이미 걸러진 경로만 받는다 (lib/server.safeNext).
  const next = safeNext(typeof raw === "string" ? raw : null);

  const { userId } = await getViewer();
  if (userId) redirect(next);

  const demoLogin = process.env.DEMO_LOGIN === "1";
  // 연동이 설정되지 않았으면 버튼을 아예 그리지 않는다 (05 §5: 연동 env 가 비면 그 연동만 꺼진다).
  const linkosSsoOn = linkosSso.linkosSsoEnabled();

  return (
    <div>
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <Link href="/" className="display text-[22px] tracking-tight">
          PROPLUS
        </Link>
        <Link href="/search" className="rounded-full px-3 py-2 text-[14px] text-[var(--fg-mute)] hover:text-[var(--fg)]">
          전문가 찾기
        </Link>
      </header>

      <main id="main" className="mx-auto max-w-xl px-5 pb-20 pt-8 sm:px-8 sm:pt-16">
        <p className="eyebrow">로그인 · 가입</p>
        <h1 className="display mt-4 text-[34px] sm:text-[44px]">메일로 받은 링크로 들어옵니다</h1>
        <p className="lede mt-5">
          비밀번호를 만들지 않습니다. 주소를 적으면 로그인 링크를 보내고, 처음 들어오는 주소라면 그 링크를
          누른 시점에 계정이 만들어집니다.
        </p>

        <div className="card mt-9 p-6 sm:p-7">
          <LoginForm next={next} demoLogin={demoLogin} />

          {/*
            연동 ① SSO (ADR-012 / 05 §1). 서버에 연동이 설정됐을 때만 보인다 —
            꺼져 있는데 버튼만 보이면 누르는 사람에게 404 를 주게 된다.

            `<a>` 다. 이 링크는 **다른 출처로 나가는 이동**이고(LINKOS 가 신원을 확인한다),
            클라이언트 라우팅으로 가로채면 안 된다. GET 이라 CSRF 도 성립하지 않는다 —
            실제 교환은 state 쿠키를 대조하는 POST 에서 일어난다.
          */}
          {linkosSsoOn ? (
            <div className="mt-6 border-t border-[var(--line)] pt-6">
              <a href="/api/v1/auth/linkos/start" className="btn btn-ghost w-full" data-testid="login-linkos">
                LINKOS 계정으로 계속
              </a>
              <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--fg-mute)]">
                LINKOS 에서 본인 확인만 하고 돌아옵니다. 같은 이메일이면 기존 PROPLUS 계정에 연결되고,
                연락처·명함 내용은 가져오지 않습니다.
              </p>
            </div>
          ) : null}
        </div>

        <ul className="mt-7 flex flex-col gap-2.5 text-[13.5px] leading-relaxed text-[var(--fg-mute)]">
          <li className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-[8px] size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
            <span>링크는 10분 동안 한 번만 쓸 수 있습니다. 새로 요청하면 이전 링크는 바로 쓸 수 없게 됩니다.</span>
          </li>
          <li className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-[8px] size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
            <span>링크를 누르면 확인 화면이 한 번 뜹니다. 메일 보안 검사가 링크를 먼저 열어 토큰을 태우는 일을 막기 위한 단계입니다.</span>
          </li>
          <li className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-[8px] size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
            <span>
              로그인하면 <Link href="/legal/terms" className="underline underline-offset-2">이용약관</Link>과{" "}
              <Link href="/legal/privacy" className="underline underline-offset-2">개인정보 처리방침</Link>이 적용됩니다.
            </span>
          </li>
        </ul>
      </main>
    </div>
  );
}
