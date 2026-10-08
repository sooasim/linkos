// X-008 / F-036 — curated Unicode emoji bank with ko/en keywords.
// Rendered as native emoji text (no image downloads). Pure data; NOT re-exported from the package index so it
// never ships on the guest landing — import "@linkos/domain/emojiBank" explicitly.

export const EMOJI_CATEGORIES = ["smileys", "people", "work", "objects", "nature", "food", "travel", "activities", "symbols", "flags"] as const;
export type EmojiCategory = (typeof EMOJI_CATEGORIES)[number];

export const EMOJI_CATEGORY_LABEL: Record<EmojiCategory, { ko: string; en: string }> = {
  smileys: { ko: "표정", en: "Smileys" },
  people: { ko: "사람·손", en: "People" },
  work: { ko: "업무", en: "Work" },
  objects: { ko: "사물", en: "Objects" },
  nature: { ko: "자연·동물", en: "Nature" },
  food: { ko: "음식", en: "Food" },
  travel: { ko: "여행·장소", en: "Travel" },
  activities: { ko: "활동", en: "Activities" },
  symbols: { ko: "기호", en: "Symbols" },
  flags: { ko: "깃발", en: "Flags" },
};

export interface BankEmoji {
  char: string;
  category: EmojiCategory;
  en: string[];
  ko: string[];
}

// one entry per line: emoji | english keywords | korean keywords
const DATA: Record<EmojiCategory, string> = {
  smileys: `
😀|grin happy smile|웃음 행복 미소
😃|smile joy|활짝 기쁨
😄|laugh happy|웃음 즐거움
😁|beaming grin|싱글벙글
😆|laughing lol|빵터짐 웃김
😅|sweat relief|진땀 안도
🤣|rofl funny|폭소 웃김
😂|tears joy|눈물 웃음
🙂|slight smile|미소 살짝
🙃|upside down silly|거꾸로 장난
😉|wink|윙크
😊|blush warm|수줍 따뜻
😇|angel innocent|천사 순수
🥰|love hearts|사랑 하트
😍|heart eyes love|하트눈 반함
🤩|star struck wow|감탄 반짝
😘|kiss|뽀뽀 키스
😗|kissing|쪽
☺️|relaxed smile|편안 미소
😚|kiss closed eyes|부끄 뽀뽀
😙|kiss smile|쪽 미소
🥲|smile tear|웃픈 감동
😋|yum delicious|맛있다 냠
😛|tongue playful|메롱
😜|wink tongue joke|장난 윙크
🤪|zany crazy|정신없음 신남
😝|squint tongue|메롱 장난
🤑|money mouth rich|돈 부자
🤗|hug welcome|포옹 환영
🤭|giggle oops|키득 비밀
🤫|shush secret|쉿 비밀
🤔|thinking hmm|생각 고민
🫡|salute respect|경례 존경
🤐|zipper mouth quiet|입다물기 비밀유지
🤨|raised eyebrow doubt|의심 갸우뚱
😐|neutral|무표정
😑|expressionless|무덤덤
😶|no mouth silent|말없음
😏|smirk|씩 미소
😒|unamused|시큰둥
🙄|eye roll|눈굴림
😬|grimace awkward|어색 민망
😮‍💨|exhale relief|한숨 휴
🤥|lying|거짓말
😌|relieved calm|안도 평온
😔|pensive|시무룩
😪|sleepy|졸림
🤤|drool|군침
😴|sleeping|잠 쿨쿨
😷|mask sick|마스크 아픔
🤒|fever ill|열 아픔
🤕|hurt bandage|부상 다침
🤢|nauseated|메스꺼움
🤧|sneeze cold|재채기 감기
🥵|hot heat|더위 땀
🥶|cold freezing|추위 꽁꽁
🥴|woozy dizzy|어지러움
😵|dizzy shock|멍 충격
🤯|mind blown|머리터짐 대박
🤠|cowboy|카우보이
🥳|party celebrate|파티 축하
🥸|disguise|변장
😎|cool sunglasses|멋짐 쿨
🤓|nerd geek|공부 너드
🧐|monocle inspect|분석 탐구
😕|confused|혼란
😟|worried|걱정
🙁|frown|찡그림
😮|open mouth surprised|놀람
😯|hushed|헉
😲|astonished|깜짝
😳|flushed|당황 화끈
🥺|pleading puppy|부탁 글썽
😦|frowning open|당혹
😨|fearful|무서움
😰|anxious sweat|불안
😢|crying sad|눈물 슬픔
😭|sobbing|오열 엉엉
😱|scream shock|비명 충격
😖|confounded|괴로움
😣|persevere|참음 버팀
😞|disappointed|실망
😓|downcast sweat|식은땀
😩|weary|지침
😫|tired|피곤
🥱|yawn|하품
😤|triumph huff|씩씩 의욕
😡|angry pout|화남 분노
😠|angry|짜증
🤬|cursing|욕 분노
😈|devil smile|악마 장난
💀|skull dead funny|해골 빵터짐
🤡|clown|광대
👻|ghost|유령
👽|alien|외계인
🤖|robot bot|로봇 봇
😺|cat smile|고양이 미소
`,
  people: `
👋|wave hello hi|안녕 손인사
🤚|raised back hand|손등
🖐️|hand fingers|손바닥
✋|raised hand stop|손들기 멈춤
🖖|vulcan salute|인사 손가락
👌|ok perfect|오케이 완벽
🤌|pinched fingers|손가락모음
🤏|pinch small|조금 작은
✌️|victory peace|브이 평화
🤞|crossed fingers luck|행운 기도
🫰|finger heart|손가락하트
🤟|love you gesture|사랑해
🤘|rock on|락
🤙|call me|전화해
👈|point left|왼쪽
👉|point right|오른쪽
👆|point up|위
👇|point down|아래
☝️|index up one|하나 첫째
🫵|point you|너 당신
👍|thumbs up good|최고 좋아요
👎|thumbs down|별로 싫어요
✊|fist raised|주먹 화이팅
👊|fist bump|주먹인사
👏|clap applause|박수 칭찬
🙌|raising hands hooray|만세 환호
🫶|heart hands|하트손 감사
👐|open hands|두손
🤲|palms up|받기 공손
🤝|handshake deal|악수 계약
🙏|thanks please pray|감사 부탁 기도
✍️|writing hand|글쓰기 서명
💅|nail polish|네일
🤳|selfie|셀카
💪|strong muscle|힘 근육 파이팅
🧠|brain smart|뇌 똑똑
👀|eyes look|눈 보기
👁️|eye watch|눈 관찰
👂|ear listen|귀 경청
👃|nose|코
👄|mouth lips|입
🫂|people hugging|포옹 위로
👶|baby|아기
🧒|child|어린이
👦|boy|소년
👧|girl|소녀
🧑|person adult|사람 성인
👨|man|남자
👩|woman|여자
🧓|older person|어르신
👴|old man|할아버지
👵|old woman|할머니
🙋|raising hand|손든사람 질문
🙆|ok gesture|오케이
🙅|no gesture|안돼
💁|tipping hand info|안내
🙇|bowing respect|인사 절 감사
🤦|facepalm|이마짚기
🤷|shrug|모르겠음
🧑‍💻|technologist developer|개발자 프로그래머
🧑‍💼|office worker|직장인 회사원
🧑‍🔬|scientist|과학자 연구원
🧑‍🎨|artist|예술가 디자이너
🧑‍🏫|teacher|선생님 강사
🧑‍⚕️|health worker doctor|의료인 의사
🧑‍🍳|cook chef|요리사 셰프
🧑‍🌾|farmer|농부
🧑‍🔧|mechanic|정비사
🧑‍🏭|factory worker|공장 노동자
🧑‍🚀|astronaut|우주비행사
🧑‍⚖️|judge|판사 법조인
🧑‍✈️|pilot|조종사 파일럿
🧑‍🎤|singer|가수
🧑‍🚒|firefighter|소방관
👮|police officer|경찰
🕵️|detective|탐정
💂|guard|경비
👷|construction worker|건설 노동자
🤵|tuxedo person|턱시도 예복
👰|veil person wedding|웨딩 결혼
🧑‍🎓|student graduate|학생 졸업생
🧑‍🤝‍🧑|people holding hands|함께 동행
👥|busts people|사람들 사용자
👤|bust silhouette|사람 실루엣
🗣️|speaking head|발표 말하기
`,
  work: `
💼|briefcase business|서류가방 비즈니스
📈|chart up growth|상승 성장 그래프
📉|chart down|하락 그래프
📊|bar chart data|막대그래프 데이터
💹|chart yen market|시장 증시
💰|money bag|돈주머니 매출
💵|dollar cash|현금 달러
💴|yen banknote|엔화 지폐
💶|euro banknote|유로 지폐
💷|pound banknote|파운드 지폐
💳|credit card|신용카드 결제
🪙|coin|동전 코인
🧾|receipt|영수증
🏦|bank|은행
🏢|office building|사무실 빌딩
🏭|factory|공장
🏗️|construction|건설 공사
📋|clipboard|클립보드
📌|pushpin|압정 고정
📍|round pin location|위치 핀
📎|paperclip|클립 첨부
🖇️|linked paperclips|클립 묶음
📏|ruler|자
📐|triangle ruler|삼각자
✂️|scissors|가위
🗂️|card index dividers|분류 정리
📁|file folder|폴더
📂|open folder|열린폴더
🗃️|card file box|파일함
🗄️|file cabinet|서류함
🗑️|wastebasket|휴지통
📅|calendar date|달력 날짜
📆|tear off calendar|일정 달력
🗓️|spiral calendar|캘린더 일정
📇|card index rolodex|명함첩 연락처
📒|ledger|장부
📓|notebook|노트
📔|decorated notebook|다이어리
📕|closed book red|책 빨강
📗|green book|책 초록
📘|blue book|책 파랑
📙|orange book|책 주황
📚|books library|책 도서관
📖|open book|펼친책 독서
🔖|bookmark|북마크
🏷️|label tag|라벨 태그
📝|memo note|메모 노트
✏️|pencil|연필
✒️|pen nib|펜촉
🖋️|fountain pen|만년필
🖊️|pen|볼펜
🖌️|paintbrush|붓 페인트
🖍️|crayon|크레용
💡|idea bulb|아이디어 전구
🔍|search magnify|검색 돋보기
🔎|search right|탐색 조사
🔐|locked key|보안 잠금
🔑|key|열쇠 키
🗝️|old key|옛열쇠
🔒|lock|자물쇠
🔓|unlock|잠금해제
📢|loudspeaker announce|공지 확성기
📣|megaphone cheer|메가폰 응원
📯|postal horn|나팔
🔔|bell notify|알림 종
📧|email|이메일
📨|incoming envelope|수신 메일
📩|envelope arrow|메일 보내기
📤|outbox|보낸편지함
📥|inbox|받은편지함
📦|package box|택배 상자
📫|mailbox|우편함
📮|postbox|우체통
✉️|envelope letter|편지 봉투
🤝|deal agreement|합의
🎯|target goal|목표 과녁
🏆|trophy win|트로피 우승
🥇|gold medal first|금메달 1등
🥈|silver medal|은메달 2등
🥉|bronze medal|동메달 3등
🏅|sports medal|메달
🎖️|military medal honor|훈장 명예
📑|bookmark tabs|문서 탭
📄|page document|문서 페이지
📃|page curl|문서
📜|scroll certificate|두루마리 증서
🧮|abacus count|주판 계산
⚖️|balance scale law|저울 법률
`,
  objects: `
📱|mobile phone|휴대폰 스마트폰
📲|phone arrow call me|연락처 전송
☎️|telephone|전화기
📞|telephone receiver|수화기 전화
📟|pager|삐삐
📠|fax machine|팩스
💻|laptop|노트북
🖥️|desktop computer|데스크톱
🖨️|printer|프린터
⌨️|keyboard|키보드
🖱️|mouse|마우스
💽|minidisc|디스크
💾|floppy save|저장 플로피
💿|cd|CD
📀|dvd|DVD
🎥|movie camera|영화 카메라
📷|camera|카메라
📸|camera flash|사진 촬영
📹|video camera|비디오
📺|television|TV 텔레비전
📻|radio|라디오
🎙️|studio microphone|마이크 녹음
🎚️|level slider|볼륨 슬라이더
🎛️|control knobs|컨트롤
🧭|compass|나침반
⏱️|stopwatch|스톱워치
⏰|alarm clock|알람
⌛|hourglass done|모래시계
⏳|hourglass flowing|진행중
📡|satellite antenna|위성 안테나
🔋|battery|배터리
🪫|low battery|방전
🔌|plug|플러그
🕯️|candle|촛불
🧯|fire extinguisher|소화기
🛢️|oil drum|기름 드럼
🔦|flashlight|손전등
🏮|red lantern|등불 초롱
🪔|diya lamp|등잔
🧰|toolbox|공구함
🔧|wrench|렌치 수리
🔨|hammer|망치
⚒️|hammer pick|망치 곡괭이
🛠️|tools|공구
⛏️|pick|곡괭이
🪛|screwdriver|드라이버
🔩|nut bolt|볼트 너트
⚙️|gear settings|톱니 설정
🧱|brick|벽돌
⛓️|chains|체인
🧲|magnet|자석
🪜|ladder|사다리
🧪|test tube|시험관 실험
🧫|petri dish|배양접시
🧬|dna|DNA 유전자
🔬|microscope|현미경
🔭|telescope|망원경
💉|syringe|주사기
💊|pill|알약
🩺|stethoscope|청진기
🩹|bandage|반창고
🚪|door|문
🪞|mirror|거울
🪟|window|창문
🛏️|bed|침대
🛋️|couch|소파
🪑|chair|의자
🚿|shower|샤워
🛁|bathtub|욕조
🧴|lotion bottle|로션
🧷|safety pin|옷핀
🧹|broom|빗자루
🧺|basket|바구니
🧻|roll paper|휴지
🧼|soap|비누
🛒|shopping cart|장바구니 쇼핑
🎁|gift|선물
🎈|balloon|풍선
🎀|ribbon|리본
🪄|magic wand|마법봉
🔮|crystal ball|수정구슬 예측
🧿|nazar amulet|부적
🪬|hamsa|행운 부적
💎|gem diamond|보석 다이아
💍|ring|반지
👓|glasses|안경
🕶️|sunglasses|선글라스
🥽|goggles|고글
👔|necktie|넥타이 정장
👕|t-shirt|티셔츠
👖|jeans|청바지
🧥|coat|코트
👗|dress|드레스
👘|kimono robe|기모노
🥻|sari|사리
👜|handbag|핸드백
🎒|backpack|백팩
👞|shoe|구두
👟|sneaker|운동화
👠|high heel|하이힐
🎩|top hat|중절모
🧢|cap|모자
⛑️|helmet rescue|안전모
👑|crown king|왕관 1위
☂️|umbrella|우산
🧳|luggage|캐리어 짐
⌚|watch|손목시계
🧸|teddy bear|곰인형
🪭|folding fan|접이식부채 부채
`,
  nature: `
🐶|dog|강아지 개
🐱|cat|고양이
🐭|mouse|생쥐
🐹|hamster|햄스터
🐰|rabbit|토끼
🦊|fox|여우
🐻|bear|곰
🐼|panda|판다
🐨|koala|코알라
🐯|tiger|호랑이
🦁|lion|사자
🐮|cow|소
🐷|pig|돼지
🐸|frog|개구리
🐵|monkey|원숭이
🐔|chicken|닭
🐧|penguin|펭귄
🐦|bird|새
🐤|chick|병아리
🦆|duck|오리
🦅|eagle|독수리
🦉|owl|부엉이 올빼미
🦇|bat|박쥐
🐺|wolf|늑대
🐗|boar|멧돼지
🐴|horse|말
🦄|unicorn|유니콘
🐝|bee|꿀벌
🐛|bug|애벌레
🦋|butterfly|나비
🐌|snail|달팽이
🐞|ladybug|무당벌레
🐜|ant|개미
🕷️|spider|거미
🐢|turtle|거북이
🐍|snake|뱀
🦎|lizard|도마뱀
🐙|octopus|문어
🦑|squid|오징어
🦐|shrimp|새우
🦀|crab|게
🐡|blowfish|복어
🐠|tropical fish|열대어
🐟|fish|물고기
🐬|dolphin|돌고래
🐳|whale|고래
🦈|shark|상어
🐊|crocodile|악어
🐅|tiger walking|호랑이 범
🐆|leopard|표범
🦓|zebra|얼룩말
🦍|gorilla|고릴라
🐘|elephant|코끼리
🦒|giraffe|기린
🦘|kangaroo|캥거루
🐪|camel|낙타
🐑|sheep|양
🐐|goat|염소
🦌|deer|사슴
🐕|dog walking|개 산책
🐈|cat walking|고양이 산책
🐓|rooster|수탉
🦚|peacock|공작
🦜|parrot|앵무새
🦢|swan|백조
🕊️|dove peace|비둘기 평화
🐿️|chipmunk|다람쥐
🦔|hedgehog|고슴도치
🐾|paw prints|발자국
🐉|dragon|용
🌵|cactus|선인장
🎄|christmas tree|크리스마스트리
🌲|evergreen tree|상록수 소나무
🌳|tree|나무
🌴|palm tree|야자수
🌱|seedling sprout|새싹 시작
🌿|herb|허브 풀
☘️|shamrock|클로버
🍀|four leaf clover luck|네잎클로버 행운
🎍|bamboo decoration|대나무 장식
🍃|leaves wind|나뭇잎
🍂|fallen leaf autumn|낙엽 가을
🍁|maple leaf|단풍
🌾|rice plant harvest|벼 수확
🌺|hibiscus|무궁화 히비스커스
🌻|sunflower|해바라기
🌹|rose|장미
🥀|wilted flower|시든꽃
🌷|tulip|튤립
🌼|blossom|꽃
🌸|cherry blossom|벚꽃
💐|bouquet|꽃다발
🍄|mushroom|버섯
🌰|chestnut|밤
🐚|shell|조개껍데기
🪨|rock|바위
🌍|earth africa europe|지구 유럽 아프리카
🌎|earth americas|지구 아메리카
🌏|earth asia|지구 아시아
🌕|full moon|보름달
🌙|crescent moon|초승달
⭐|star|별
🌟|glowing star|빛나는별
✨|sparkles|반짝 빛
⚡|lightning|번개 전기
🔥|fire hot|불 열정
🌈|rainbow|무지개
☀️|sun|태양 해
🌤️|sun cloud|구름조금
⛅|partly cloudy|흐림
☁️|cloud|구름
🌧️|rain|비
⛈️|storm|폭풍
❄️|snowflake|눈송이
☃️|snowman|눈사람
🌬️|wind face|바람
💧|droplet|물방울
🌊|wave ocean|파도 바다
🌫️|fog|안개
🌪️|tornado|토네이도
`,
  food: `
🍏|green apple|청사과
🍎|red apple|사과
🍐|pear|배
🍊|tangerine|귤 감귤
🍋|lemon|레몬
🍌|banana|바나나
🍉|watermelon|수박
🍇|grapes|포도
🍓|strawberry|딸기
🫐|blueberries|블루베리
🍈|melon|멜론
🍒|cherries|체리
🍑|peach|복숭아
🥭|mango|망고
🍍|pineapple|파인애플
🥥|coconut|코코넛
🥝|kiwi|키위
🍅|tomato|토마토
🍆|eggplant|가지
🥑|avocado|아보카도
🥦|broccoli|브로콜리
🥬|leafy green|배추 채소
🥒|cucumber|오이
🌶️|hot pepper|고추 매운
🫑|bell pepper|피망
🌽|corn|옥수수
🥕|carrot|당근
🧄|garlic|마늘
🧅|onion|양파
🥔|potato|감자
🍠|sweet potato|고구마
🥐|croissant|크루아상
🥯|bagel|베이글
🍞|bread|빵 식빵
🥖|baguette|바게트
🧀|cheese|치즈
🥚|egg|달걀
🍳|cooking fried egg|요리 계란후라이
🥞|pancakes|팬케이크
🧇|waffle|와플
🥓|bacon|베이컨
🥩|steak meat|고기 스테이크
🍗|poultry leg|치킨 닭다리
🍖|meat bone|고기
🌭|hot dog|핫도그
🍔|burger|햄버거
🍟|fries|감자튀김
🍕|pizza|피자
🥪|sandwich|샌드위치
🌮|taco|타코
🌯|burrito|부리또
🥗|salad|샐러드
🥘|paella pan|빠에야 전골
🍝|spaghetti pasta|파스타 스파게티
🍜|noodles ramen|라면 국수
🍲|stew pot|찌개 탕
🍛|curry rice|카레
🍣|sushi|초밥
🍱|bento|도시락
🥟|dumpling|만두
🍤|fried shrimp|새우튀김
🍙|rice ball|주먹밥
🍚|cooked rice|밥 쌀밥
🍘|rice cracker|쌀과자
🍥|fish cake|어묵
🥠|fortune cookie|포춘쿠키
🍢|oden skewer|꼬치 어묵꼬치
🍡|dango|경단 떡꼬치
🍧|shaved ice|빙수
🍨|ice cream|아이스크림
🍦|soft serve|소프트콘
🥧|pie|파이
🧁|cupcake|컵케이크
🍰|cake slice|조각케이크
🎂|birthday cake|생일케이크
🍮|custard pudding|푸딩
🍭|lollipop|막대사탕
🍬|candy|사탕
🍫|chocolate|초콜릿
🍿|popcorn|팝콘
🍩|doughnut|도넛
🍪|cookie|쿠키
🥜|peanuts|땅콩
🍯|honey|꿀
🥛|milk|우유
☕|coffee hot|커피
🍵|tea green|녹차 차
🧋|bubble tea|버블티
🥤|cup straw drink|음료
🧃|juice box|주스
🍶|sake|정종 청주
🍺|beer|맥주
🍻|cheers beers|건배 회식
🥂|clinking glasses toast|축배 샴페인
🍷|wine|와인
🥃|whisky|위스키
🍸|cocktail|칵테일
🍹|tropical drink|트로피컬
🧉|mate|마테차
🍾|champagne bottle|샴페인 축하
🥢|chopsticks|젓가락
🍽️|plate dining|식사 접시
🍴|fork knife|포크 나이프
🥄|spoon|숟가락
🫕|fondue|퐁듀
🥡|takeout box|포장 테이크아웃
`,
  travel: `
🚗|car|자동차
🚕|taxi|택시
🚙|suv|SUV
🚌|bus|버스
🚎|trolleybus|트롤리버스
🏎️|racing car|레이싱카
🚓|police car|경찰차
🚑|ambulance|구급차
🚒|fire engine|소방차
🚐|minibus van|승합차
🛻|pickup truck|픽업트럭
🚚|delivery truck|배송트럭
🚛|truck lorry|화물트럭
🚜|tractor|트랙터
🛵|scooter|스쿠터
🏍️|motorcycle|오토바이
🚲|bicycle|자전거
🛴|kick scooter|킥보드
🚨|siren|사이렌
🚥|traffic light|신호등
🚧|construction sign|공사중
⚓|anchor|닻
⛵|sailboat|요트 돛단배
🚤|speedboat|보트
🛳️|cruise ship|크루즈
⛴️|ferry|여객선
🚢|ship|배 선박
✈️|airplane|비행기
🛫|departure|출발 이륙
🛬|arrival|도착 착륙
🪂|parachute|낙하산
🚁|helicopter|헬리콥터
🚀|rocket launch|로켓 출시
🛸|ufo|UFO
🚆|train|기차
🚄|high speed train|고속열차 KTX
🚇|metro subway|지하철
🚉|station|역
🚊|tram|트램
🗺️|world map|세계지도
🗾|map japan|일본지도
🏔️|snow mountain|설산
⛰️|mountain|산
🌋|volcano|화산
🗻|mount fuji|후지산
🏕️|camping|캠핑
🏖️|beach|해변
🏜️|desert|사막
🏝️|island|섬
🏞️|national park|국립공원
🏟️|stadium|경기장
🏛️|classical building|박물관 기관
🏘️|houses|주택단지
🏠|house home|집
🏡|house garden|정원주택
🏬|department store|백화점
🏣|post office|우체국
🏤|post office euro|우편
🏥|hospital|병원
🏨|hotel|호텔
🏪|convenience store|편의점
🏫|school|학교
🏩|love hotel|모텔
💒|wedding chapel|예식장
⛪|church|교회
🕌|mosque|모스크
🛕|hindu temple|사원
🕍|synagogue|회당
⛩️|shrine gate|신사
🏯|castle japanese|성 천수각
🏰|castle|성
🗼|tower|타워
🗽|statue liberty|자유의여신상
⛲|fountain|분수
⛺|tent|텐트
🌁|foggy|안개도시
🌃|night stars city|야경
🏙️|cityscape|도시
🌄|sunrise mountains|산일출
🌅|sunrise|일출
🌆|dusk city|노을 도시
🌇|sunset|일몰
🌉|bridge night|다리 야경
🎡|ferris wheel|관람차
🎢|roller coaster|롤러코스터
🎠|carousel|회전목마
🧳|suitcase travel|여행가방
🛎️|bellhop bell|호텔벨 서비스
🗿|moai|모아이
🛤️|railway track|철도
🛣️|motorway|고속도로
⛽|fuel pump|주유소
🚏|bus stop|정류장
🧭|navigation compass|길찾기
🌐|globe meridians|글로벌 인터넷
`,
  activities: `
⚽|soccer|축구
🏀|basketball|농구
🏈|american football|미식축구
⚾|baseball|야구
🥎|softball|소프트볼
🎾|tennis|테니스
🏐|volleyball|배구
🏉|rugby|럭비
🥏|frisbee|프리스비
🎱|billiards|당구
🏓|ping pong|탁구
🏸|badminton|배드민턴
🏒|ice hockey|아이스하키
🏑|field hockey|필드하키
🥍|lacrosse|라크로스
🏏|cricket|크리켓
⛳|golf|골프
🏹|archery|양궁
🎣|fishing|낚시
🤿|diving mask|다이빙
🥊|boxing|복싱
🥋|martial arts|태권도 무술
🎽|running shirt|러닝
🛹|skateboard|스케이트보드
🛼|roller skate|롤러스케이트
⛸️|ice skate|스케이트
🎿|ski|스키
🛷|sled|썰매
🏂|snowboarder|스노보드
🏋️|weight lifting|역도 헬스
🤸|cartwheel|체조
🧘|yoga|요가 명상
🏄|surfing|서핑
🏊|swimming|수영
🚴|biking|사이클
🧗|climbing|클라이밍
🏇|horse racing|경마
🏆|championship|챔피언십
🎮|video game|게임
🕹️|joystick|조이스틱
🎲|dice game|주사위 보드게임
🧩|puzzle piece|퍼즐
♟️|chess pawn strategy|체스 전략
🎯|bullseye|명중
🎳|bowling|볼링
🎭|performing arts|공연 연극
🎨|art palette|미술 팔레트
🎬|clapper film|영화 촬영
🎤|microphone karaoke|마이크 노래방
🎧|headphones|헤드폰 음악
🎼|music score|악보
🎹|piano|피아노
🥁|drum|드럼
🎷|saxophone|색소폰
🎺|trumpet|트럼펫
🎸|guitar|기타
🪕|banjo|밴조
🎻|violin|바이올린
🪘|long drum|장구 북
🎉|party popper|축하 파티
🎊|confetti ball|색종이 축하
🎆|fireworks|불꽃놀이
🎇|sparkler|폭죽
🧨|firecracker|폭죽 화약
🎏|carp streamer|잉어깃발
🎐|wind chime|풍경
🎑|moon viewing|달맞이 추석
🎃|jack o lantern|핼러윈
🎟️|admission ticket|입장권
🎫|ticket|티켓
🪁|kite|연 연날리기
🏮|lantern festival|연등
`,
  symbols: `
❤️|red heart love|빨간하트 사랑
🧡|orange heart|주황하트
💛|yellow heart|노란하트
💚|green heart|초록하트
💙|blue heart|파란하트
💜|purple heart|보라하트
🖤|black heart|검은하트
🤍|white heart|흰하트
🤎|brown heart|갈색하트
💖|sparkling heart|반짝하트
💗|growing heart|설렘
💓|beating heart|두근
💞|revolving hearts|하트들
💕|two hearts|두하트
💝|heart ribbon gift|하트선물
💯|hundred perfect|백점 완벽
💢|anger symbol|분노
💥|collision boom|쾅 임팩트
💫|dizzy star|어질 별
💦|sweat droplets|땀방울
💨|dash fast|쌩 빠름
💬|speech bubble|말풍선 대화
💭|thought bubble|생각풍선
🗯️|anger bubble|외침
♻️|recycle|재활용
✅|check mark done|완료 체크
☑️|ballot check|체크박스
✔️|check|확인
❌|cross no|엑스 아니오
❎|cross button|취소
➕|plus|더하기
➖|minus|빼기
➗|divide|나누기
✖️|multiply|곱하기
♾️|infinity|무한
‼️|double exclamation|강조 느낌표
⁉️|interrobang|뭐라고
❓|question|물음표
❔|white question|질문
❗|exclamation|느낌표 중요
❕|white exclamation|주의
⚠️|warning|경고
🚫|prohibited|금지
⛔|no entry|진입금지
📛|name badge|이름표
🔰|beginner|초보 새내기
⭕|circle o|동그라미 정답
🆕|new|신규 NEW
🆓|free|무료
🆗|ok button|OK
🆙|up|업
🆒|cool|쿨
🔝|top|탑 최고
🔜|soon|곧
🔛|on|켜짐
ℹ️|information|정보
🔤|abc|알파벳
🔢|numbers|숫자
#️⃣|hash key|샵 해시
*️⃣|asterisk|별표
0️⃣|zero|영 0
1️⃣|one|일 1
2️⃣|two|이 2
3️⃣|three|삼 3
🔟|ten|십 10
🅰️|a button|A
🅱️|b button|B
🆎|ab|AB
🆑|cl|CL
🅾️|o button|O
🆘|sos help|도움 SOS
🔴|red circle|빨간원
🟠|orange circle|주황원
🟡|yellow circle|노란원
🟢|green circle|초록원 가능
🔵|blue circle|파란원
🟣|purple circle|보라원
⚫|black circle|검은원
⚪|white circle|흰원
🟥|red square|빨간네모
🟧|orange square|주황네모
🟨|yellow square|노란네모
🟩|green square|초록네모
🟦|blue square|파란네모
🟪|purple square|보라네모
⬛|black square|검은네모
⬜|white square|흰네모
🔶|orange diamond|주황마름모
🔷|blue diamond|파란마름모
🔺|red triangle up|빨간삼각
🔻|red triangle down|역삼각
💠|diamond dot|다이아무늬
🔘|radio button|라디오버튼
🔗|link|링크 연결
➡️|right arrow|오른쪽화살표
⬅️|left arrow|왼쪽화살표
⬆️|up arrow|위화살표
⬇️|down arrow|아래화살표
↗️|up right arrow|오른쪽위
↘️|down right arrow|오른쪽아래
🔄|counterclockwise refresh|새로고침 순환
🔁|repeat|반복
🔀|shuffle|셔플
▶️|play|재생
⏸️|pause|일시정지
⏹️|stop|정지
⏩|fast forward|빨리감기
🔊|speaker loud|소리 크게
🔇|mute|음소거
☯️|yin yang|음양 조화
☮️|peace|평화
🕉️|om|옴
✡️|star of david|육각별
☸️|wheel of dharma|법륜
♈|aries|양자리
♉|taurus|황소자리
♊|gemini|쌍둥이자리
♋|cancer zodiac|게자리
♌|leo|사자자리
♍|virgo|처녀자리
©️|copyright|저작권
®️|registered|등록상표
™️|trademark|상표
🏧|atm|ATM 현금인출
🚾|restroom|화장실
♿|wheelchair accessible|휠체어 접근성
🅿️|parking|주차
🈳|vacancy|빈자리
㊗️|congratulations|축하
㊙️|secret|비밀
`,
  flags: `
🏁|checkered flag finish|결승 체크무늬
🚩|triangular flag|삼각기 표시
🎌|crossed flags|교차깃발
🏴|black flag|검은깃발
🏳️|white flag|흰깃발
🏳️‍🌈|rainbow flag|무지개깃발
🇰🇷|korea flag|대한민국 한국 태극기
🇺🇸|united states flag|미국
🇯🇵|japan flag|일본
🇨🇳|china flag|중국
🇬🇧|united kingdom flag|영국
🇩🇪|germany flag|독일
🇫🇷|france flag|프랑스
🇸🇬|singapore flag|싱가포르
🇻🇳|vietnam flag|베트남
🇪🇺|european union flag|유럽연합 EU
`,
};

function parse(): BankEmoji[] {
  const out: BankEmoji[] = [];
  for (const category of EMOJI_CATEGORIES) {
    for (const line of DATA[category].split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const [char, en, ko] = t.split("|");
      if (!char || !en || !ko) continue;
      out.push({ char, category, en: en.split(/\s+/), ko: ko.split(/\s+/) });
    }
  }
  return out;
}

const ALL = parse();
// the same glyph may be listed under two categories for discovery; the bank keeps the first occurrence
const seen = new Set<string>();
export const EMOJI_BANK: readonly BankEmoji[] = ALL.filter((e) => (seen.has(e.char) ? false : (seen.add(e.char), true)));

const BY_CHAR = new Map(EMOJI_BANK.map((e) => [e.char, e]));

export function getBankEmoji(char: string): BankEmoji | undefined {
  return BY_CHAR.get(char);
}

/** Number of user-perceived characters (extended grapheme clusters). */
export function graphemeCount(s: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment: (s: string) => Iterable<unknown> } }).Segmenter;
  if (!Seg) return Array.from(s).length;
  let c = 0;
  for (const _ of new Seg(undefined, { granularity: "grapheme" }).segment(s)) c++;
  return c;
}

/** A valid bank emoji: exactly one grapheme AND present in the curated bank. */
export function isBankEmoji(s: string): boolean {
  return typeof s === "string" && s.length > 0 && s.length <= 16 && graphemeCount(s) === 1 && BY_CHAR.has(s);
}

export function searchEmoji(query: string, category?: EmojiCategory | null): BankEmoji[] {
  const q = query.trim().toLowerCase();
  return EMOJI_BANK.filter((e) => {
    if (category && e.category !== category) return false;
    if (!q) return true;
    return e.char === q || e.en.some((k) => k.toLowerCase().includes(q)) || e.ko.some((k) => k.includes(q));
  });
}
