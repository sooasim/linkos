import { identity, proplusSso } from "@linkos/api";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Logo } from "@/components/Icon";
import { getViewer } from "@/lib/server";

export const dynamic = "force-dynamic";
// 이 URL 에는 PROPLUS 가 발급한 state(CSRF 값)가 붙어 온다. 검색에 남기지 않고 Referer 로도 흘리지 않는다.
export const metadata: Metadata = { title: "PROPLUS 연결", robots: { index: false }, referrer: "no-referrer" };

/** 로그인 후 이 화면으로 정확히 되돌아오기 위한 경로(쿼리 포함). */
function selfPath(redirectUri: string, state: string): string {
  return `/sso/proplus?${new URLSearchParams({ redirect_uri: redirectUri, state }).toString()}`;
}

/**
 * PROPLUS 연동 — proplus/docs/05_LINKOS_INTEGRATION.md §1 (LINKOS 가 신원 제공자)
 *
 * PROPLUS 에서 "LINKOS 계정으로 계속"을 누르면 여기로 온다:
 *   /sso/proplus?redirect_uri=<PROPLUS>/login/linkos&state=<csrf>
 *
 * **자동으로 리다이렉트하지 않는다.** 신원이 다른 제품으로 넘어가는 일이고, 사용자는 넘어가기 전에
 * 어떤 계정이 어디로 가는지 볼 수 있어야 한다. 그래서 확인 화면을 먼저 보여주고 명시적으로 누르게 한다.
 */
export default async function ProplusSsoPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  // 연동 env 가 비면 이 연동만 조용히 꺼진다(05 §5) — 이 배포에 없는 화면처럼 보여야 한다.
  if (!proplusSso.proplusSsoEnabled()) notFound();
  const sp = await searchParams;
  const redirectUri = sp.redirect_uri ?? "";
  const state = sp.state ?? "";

  const { userId } = await getViewer();
  // 비로그인: LINKOS 로그인을 먼저 거치고 이 화면으로 복귀한다(05 §1 흐름 3단계).
  if (!userId) redirect(`/login?next=${encodeURIComponent(selfPath(redirectUri, state))}`);

  // 목적지 검증은 화면에서도 미리 한다 — 틀린 주소면 버튼을 주지 않고 여기서 멈추는 편이
  // 누른 다음 실패하는 것보다 설명 가능하다. 실제 차단은 발급 직전에 한 번 더 한다.
  const destinationOk = Boolean(state) && proplusSso.isAllowedRedirect(redirectUri);
  // 목적지가 틀렸으면 계정을 조회할 이유도 없다.
  const email = destinationOk ? (await identity.getMe(userId)).user.email : null;

  // 서버 액션: [계속] 을 누르면 브라우저가 이 폼을 POST 하고, 서버가 assertion 을 발급해
  // PROPLUS 로 보낸다. assertion 은 클라이언트 JS 를 거치지 않고, JS 가 꺼져 있어도 동작한다.
  async function continueToProplus(form: FormData): Promise<void> {
    "use server";
    if (!proplusSso.proplusSsoEnabled()) notFound();
    const uri = String(form.get("redirect_uri") ?? "");
    const csrf = String(form.get("state") ?? "");
    // 폼 값은 클라이언트가 바꿔 보낼 수 있으므로 발급 직전에 다시 검증한다(오픈 리다이렉트 차단).
    if (!csrf || !proplusSso.isAllowedRedirect(uri)) notFound();
    const viewer = await getViewer();
    if (!viewer.userId) redirect(`/login?next=${encodeURIComponent(selfPath(uri, csrf))}`);
    const assertion = await proplusSso.issueAssertion(viewer.ctx, viewer.userId);
    // PROPLUS 가 state 를 자기 쿠키와 대조하고(로그인 CSRF 차단) assertion 을 검증한다(05 §1).
    redirect(proplusSso.redirectWithAssertion(uri, assertion, csrf));
  }

  return (
    <main className="stage-ink grain flex min-h-dvh flex-col px-5 pb-10 pt-5">
      <header>
        <Link href="/">
          <Logo />
        </Link>
      </header>
      <div className="mx-auto my-auto w-full max-w-sm animate-rise">
        <p className="eyebrow">서비스 연결</p>
        <h1 className="display mt-2 text-[40px]">PROPLUS 연결</h1>
        {!destinationOk ? (
          <p className="mt-6 rounded-2xl border border-[var(--line)] p-4 text-[14px]">
            연결 요청이 올바르지 않습니다. PROPLUS 로그인 화면에서 다시 시작해 주세요.
          </p>
        ) : !email ? (
          // PROPLUS 는 이메일로 자기 계정을 잇는다(05 §1 계정 연결 규칙) — 이메일 없는 계정은 연결할 수 없다.
          <p className="mt-6 rounded-2xl border border-[var(--line)] p-4 text-[14px]">
            이 계정에는 이메일이 없어 PROPLUS 와 연결할 수 없습니다. 설정에서 이메일을 등록한 뒤 다시 시도해 주세요.
          </p>
        ) : (
          <>
            <p className="mt-3 text-[15px] text-[var(--fg-mute)]">
              PROPLUS 에 <strong className="text-[var(--fg)]">{email}</strong> 계정으로 연결합니다.
            </p>
            <p className="mt-2 text-[13px] text-[var(--fg-mute)]">
              이동할 주소: <span className="break-all">{new URL(redirectUri).origin}</span>
            </p>
            <p className="mt-3 text-[13px] text-[var(--fg-mute)]">
              전달되는 것은 이메일과 표시 이름뿐입니다. 내 연락처·관계 데이터는 넘어가지 않습니다.
            </p>
            <form action={continueToProplus}>
              <input type="hidden" name="redirect_uri" value={redirectUri} />
              <input type="hidden" name="state" value={state} />
              <button type="submit" className="btn btn-signal btn-lg mt-8 w-full">
                계속
              </button>
            </form>
            <Link href="/app" className="mt-4 block text-center text-[14px] text-[var(--fg-mute)] underline">
              취소
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
