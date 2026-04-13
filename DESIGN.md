# Knoldr — Design v0.2

Universal data platform for the zipbul agentic ecosystem. Backed by PostgreSQL.
AI가 쌓고, AI가 쓴다.

## Purpose

세상의 모든 데이터를 수집하고, 스코어링하여 극한으로 활용한다.
기술 지식뿐 아니라 아이디어, 사례, 포스트, 뉴스, 창작글, 의견, 논문 — 어떤 종류의 데이터든 담고, 평가하고, 꺼내 쓴다.
할루시네이션을 0에 가깝게 하기 위해, 콘텐츠가 아닌 Claim(원자적 주장) 단위로 사실을 검증한다.

## Design Principles

1. **AI-native**: AI가 적재하고 AI가 소비한다. 내부 검색에서 인간 보정 기법(re-ranking, fuzzy matching) 불필요. 적재 품질이 검색 품질을 결정한다. 단, 외부 웹 검색(Deep Crawl Engine)에서는 Query Decomposition + Expansion을 사용하여 검색 커버리지를 극대화한다.
2. **Write path 중심**: 적재 파이프라인(Ingestion Engine)이 핵심. 검색은 단순하게 유지.
3. **Append-only + 제한적 mutation**: 데이터는 쌓고, 저장하거나 버린다. 사실 검증은 v0.3. 내용은 수정하지 않는다. 유일한 예외: `authority` 스코어 피드백 조정 (atomic SQL update).
4. **검색이 관리한다**: 라이프사이클 관리(stale, archived 등) 없음. freshness 감쇠로 오래된 데이터는 자연스럽게 밀려남.
5. **계층 독립성**: Entry → Claim → KG, 각 계층은 독립적으로 동작. 상위 없어도 하위 정상.
6. **점진적 확장**: 테이블 추가만으로 확장. 기존 스키마 변경 없음.
7. **비용 인식**: 비싼 연산(LLM, 멀티모델)은 나중에, 값싼 연산(규칙 기반)은 먼저.

---

## AI-native Write Path

인간을 위한 검색 보정 기법은 사용하지 않는다:

| 기법 | 사용 여부 | 이유 |
|------|:---------:|------|
| Query expansion (HyDE) | 내부 X / 외부 O | 내부 검색: AI가 정확한 쿼리 직접 생성. 외부 웹 검색: Query Decomposition + Expansion 사용. |
| Multi-query retrieval | X | AI가 한 번에 정밀 쿼리 가능 |
| Cross-encoder re-ranking | X | 적재 품질이 높으면 초기 검색만으로 충분 |
| Semantic chunking | X | AI가 적재 시 원자적 단위로 분해 |
| Fuzzy matching | X | AI는 오타를 내지 않음 |
| Semantic vector search | X | AI가 정확한 키워드 쿼리를 직접 생성. 임베딩은 중복 감지 + 스코어링용으로만 사용. |

---

## Evolution Roadmap

```
v0.2 (지금)          v0.3 (데이터 축적 후)     v0.4 (Claim 안정화 후)
─────────────        ─────────────────────     ──────────────────────
Entry                + Claim                   + Knowledge Graph
  tags, domain         statement, type           entity, relation
  sources              verdict, certainty        → 추론, 모순 감지
  embedding            embedding
                       Pyreez 검증
Ingestion Engine     + Claim 추출
  원자적 분해           + Pyreez 검증 (source_check,
  메타데이터 정제          web_search, db_cross_ref)
  중복 → 버림          + entry_score 테이블
  (검증은 하지 않음)      (factuality, novelty)

Search
  pgroonga FTS         + Claim 단위 검색         + Graph traversal
  freshness 감쇠       (pgroonga)
  (시맨틱 검색 불필요:
   AI가 정확한 쿼리 생성)

Authority Score      + factuality              + actionability
  (규칙, $0)           (Pyreez, $$)              + signal
                     + novelty
                       (임베딩 거리, $0)

A2A Server
Deep Crawl Engine
  쿼리 분해 (Query Decomposition)
  DuckDuckGo → seed URL → 딥크롤링 (링크 추적)
  HTML + PDF + 이미지 + YouTube
  도메인 정책 (crawl_domain)
CLI
데이터 수집: 외부 전문 에이전트 (A2A store)
```

---

## v0.2: Core — 구현 완료 (코드가 source of truth)

---

## Agent Interaction Contract

Knoldr와 외부 에이전트의 유일한 인터페이스는 A2A다.
모든 데이터는 Ingestion Engine을 거친다. 우회 경로 없음.

```
외부 에이전트 ──A2A──→ Knoldr
  store    → Ingestion Engine → DB    (에이전트가 직접 적재)
  research → Deep Crawl Engine → Ingestion Engine → DB (Knoldr가 대신 조사)
  query    → Search Engine → 응답
  explore  → Search Engine → 응답
  feedback → Authority 조정 → DB
  audit    → 시스템 통계 → 응답

내부 (A2A 아님, 에이전트 접근 불가):
  CLI (관리자)               → Ingestion Engine → DB
  Batch Dedup Job (일 1회)   → DB
  Retry Queue (5분 간격)     → Ingestion Engine → DB
```

**에이전트 역할:**

| 역할 | 사용 skill | 설명 |
|------|-----------|------|
| Producer | `store` | 자체 데이터 또는 자체 리서치 결과를 적재. 전문 에이전트(보안, 논문 등)가 자기 영역 데이터를 직접 수집 후 저장. |
| Researcher | `research` | "이 주제 조사해서 넣어줘". Knoldr가 web search + 적재. 범용 조사에 적합. |
| Consumer | `query`, `explore` | 데이터를 검색. trustLevel과 score breakdown을 보고 자체 신뢰 판단. |
| Validator | `feedback` | 데이터 사용 후 품질 신호 전달. authority 조정에 반영. |

하나의 에이전트가 여러 역할을 동시에 수행할 수 있다 (예: 리서치 후 store → query로 확인 → feedback).

**Consumer 에이전트의 신뢰 판단:**

query/explore 응답에 포함되는 score breakdown으로 에이전트가 자체 판단:

```
v0.2 응답:
  {
    entry: { id, title, content, sources, ... },
    scores: { relevance, authority, freshness, final },
    trustLevel: 'high' | 'medium' | 'low'  // authority 기반
  }

v0.3 응답 (확장):
  {
    entry: { ... },
    scores: { relevance, authority, freshness, factuality, final },
    trustLevel: 'high' | 'medium' | 'low' | 'unscored',
    claims: [  // includeClaims: true일 때만
      { statement, type, verdict, certainty }
    ]
  }
```

trustLevel 산출:

```
v0.2:
  high:   authority >= 0.7
  medium: authority >= 0.4
  low:    authority < 0.4

v0.3 (factuality 추가):
  high:     authority >= 0.7 AND factuality >= 0.8
  medium:   authority >= 0.4 AND factuality >= 0.5
  low:      나머지
  unscored: factuality 없음 (아직 검증 안 됨)
```

**Consumer 에이전트 행동 가이드:**

```
trustLevel: high
  → 사실로 사용 가능.

trustLevel: medium
  → "~에 따르면" 식으로 출처 인용하며 사용.

trustLevel: low
  → 참고용. 핵심 판단의 근거로 사용하지 않음.

trustLevel: unscored
  → sources와 authority만 보고 자체 판단. 출처 명시 필수.

verdict: disputed (v0.3, claims 포함 시)
  → 해당 claim은 양쪽 관점 모두 제시.

verdict: unverified (v0.3)
  → "검증되지 않은 정보" 표기.
```

---

## v0.3: Claim Layer (데이터 축적 후)

기존 Entry 테이블 변경 없음. 테이블 추가만.
entry_score 테이블도 v0.3에서 추가 (factuality, novelty 저장용).

### Claim

Entry에서 LLM이 추출한 원자적 주장.

```
Claim {
  id: string (ulid)
  entryId: string
  entryCreatedAt: Date         // 파티션 FK용 (entry PK가 id+created_at)
  statement: string
  type: ClaimType              // factual | subjective | predictive | normative
  verdict: Verdict             // verified | disputed | unverified | not_applicable
  certainty: number            // 0-1, Pyreez가 설정 (factual만)
  evidence: object             // 검증 근거 (JSONB)
  embedding: Float32Array      // Claim 단위 시맨틱 검색
  createdAt: Date
}
```

`verifiable` 필드는 불필요 — `type`에서 결정됨 (factual=verifiable, 나머지=not).

### Claim Types (인식론적 고정 분류)

| type | 설명 | 검증 | 예시 |
|------|------|:----:|------|
| `factual` | 참/거짓 판별 가능 | O | "Bun 1.2는 2024년 1월 출시" |
| `subjective` | 개인 판단/선호 | X | "React가 더 쓰기 편하다" |
| `predictive` | 미래 예측 | 사후에만 | "AI가 2년 내 개발자를 대체한다" |
| `normative` | 당위/규범 | X | "테스트 커버리지 80% 이상이어야 한다" |

참고: 정의적("React는 JS 라이브러리다"), 관계적("Bun이 Node보다 빠르다"), 조건적("TS 쓸 때 strict 켜야"), 존재적("log4j 취약점이 있다") 주장은 모두 `factual`에 포함. 검증 방식만 다를 뿐 분류는 동일.

### Claim 추출 + 검증 파이프라인

```
Entry (active 상태)
    │
    ▼ Claim 추출 (Pyreez 또는 고성능 클라우드 모델)
    │  로컬 8B 모델로는 사실/의견 구분 신뢰도 부족.
    │  Pyreez의 멀티모델이 추출 + 분류를 동시에 수행.
    │
    ├─ type=factual
    │    → verify_queue에 등록
    │    → Pyreez 검증 도구로 검증 (아래 상세)
    │    → verdict = verified | disputed | unverified
    │    → certainty = 0-1
    │
    └─ type=subjective|predictive|normative
         → verdict = not_applicable
```

### Pyreez 검증 도구 (Verification Tools)

Pyreez가 factual claim을 검증할 때 사용하는 도구 세트.
GPT-4급 멀티모델 심의로 미묘한 자연어 추론(NLI) 판단 가능.

```
┌─ source_check(url, claim) ───────────────────────────────────┐
│  출처 URL fetch (Playwright + Readability) → 텍스트 추출      │
│  Pyreez가 "이 출처가 이 주장을 뒷받침하는가?" 판단             │
│  결과: confirmed | not_found | contradicted | unreachable     │
│                                                               │
│  한계:                                                        │
│  - URL 50%+는 fetch 실패 (페이월, JS, 죽은 링크)              │
│  - 실패 시 unreachable, 다른 도구로 폴백                      │
│  - 출처 내용이 변경되었을 수 있음                              │
└───────────────────────────────────────────────────────────────┘

┌─ web_search(claim) ──────────────────────────────────────────┐
│  Claim → 검색 쿼리 변환 → DuckDuckGo Lite (HTTP scraping)     │
│  상위 5개 결과 fetch → Pyreez가 각각 대조                      │
│  출처 독립성 검사 (같은 원본 퍼나른 것은 1개로 카운트)          │
│  결과: { independent_supporting: N, contradicting: N }        │
│                                                               │
│  한계:                                                        │
│  - 합의 ≠ 진실 (잘못된 정보도 널리 퍼질 수 있음)               │
│  - 니치한 주장은 검색 결과 없을 수 있음                        │
└───────────────────────────────────────────────────────────────┘

┌─ db_cross_ref(claim) ────────────────────────────────────────┐
│  Claim 임베딩으로 기존 verified claims 검색                    │
│  Pyreez가 기존 검증된 데이터와 대조                            │
│  결과: corroborated | contradicted | no_relevant_data         │
│                                                               │
│  순환 신뢰 방지:                                              │
│  - source_check로 verified된 claim만 cross-ref 대상           │
│  - db_cross_ref로만 verified된 claim은 대상에서 제외           │
│  → A→B→C 순환 차단                                           │
│  - 최소 3개 독립 corroboration 필요                           │
└───────────────────────────────────────────────────────────────┘
```

### 검증 전략 (Pyreez가 실행)

```
factual Claim 수신
    │
    ▼
1. Entry에 sources가 있는가?
   ├─ YES → source_check(url, claim)
   │   ├─ confirmed → verdict: verified, certainty 높음
   │   ├─ contradicted → verdict: disputed
   │   └─ unreachable/not_found → 다음 단계로
   │
   └─ NO → 다음 단계로

2. db_cross_ref(claim)
   ├─ corroborated (source_check 기반 claim 3개+ 뒷받침)
   │   → verdict: verified, certainty 중간
   └─ contradicted / no_relevant_data → 다음 단계로

3. web_search(claim) — 일일 예산 내에서만
   ├─ independent_supporting >= 2 → verdict: verified, certainty 낮음
   ├─ contradicting > supporting → verdict: disputed
   └─ 불충분 → verdict: unverified ("증거 부족")

Pyreez 멀티모델 심의가 각 단계 결과를 종합하여 최종 판정.
```

### 검증 비용 (v0.3)

```
per claim:
  Pyreez: 패키지 설치, deliberation engine 직접 호출 (GPT-4급 모델 3-5개 심의)
  source_check: Playwright + Readability (자체 호스팅)
  web_search: DuckDuckGo Lite HTTP scraping (무료, API key 불필요)
  db_cross_ref: DB 검색 (무료)

일일 예산:
  Playwright: 자체 호스팅, 한도 없음
  초과 시: verdict = unverified, 다음 날 재시도

우선순위:
  1. authority 높은 Entry의 Claims 먼저
  2. 최근 Entry 우선
  3. 예산 소진 시 큐 대기
```

### entry_score 테이블 (v0.3에서 추가)

```
EntryScore {
  entryId: string
  entryCreatedAt: Date         // 파티션 FK용
  dimension: string            // 'factuality' | 'novelty'
  value: number                // 0-1
  scoredAt: Date
  scoredBy: string             // 'pyreez' | 'system'
}

factuality = verified_claims / total_factual_claims
novelty = 1 - max(cosine_similarity(entry, same_domain_entries))
```

---

## v0.4: Knowledge Graph (Claim 안정화 후)

기존 Entry, Claim, entry_score 테이블 변경 없음. 테이블 추가만.

### Knowledge Graph

Claim에서 엔티티와 관계를 추출.

```
Entity {
  id: string (ulid)
  name: string                 // 정규화된 이름
  type: string                 // technology, person, company, concept, ...
  aliases: string[]            // 별칭 (entity resolution용)
  metadata: object
  embedding: Float32Array      // 엔티티 시맨틱 검색용
}

Relation {
  id: string (ulid)
  sourceEntityId: string
  targetEntityId: string
  relationType: string         // written_in, is_a, faster_than, depends_on, ...
  claimId: string              // 근거 Claim 참조 (시간 구분 가능)
  weight: number               // 0-1, Claim certainty에서 파생
}
```

Entity resolution 전략:
```
새 엔티티 추출 시:
  1. 정확 이름 매칭 (name, aliases)
  2. 임베딩 유사도 > 0.9 → 기존 엔티티 후보
  3. LLM에 "같은 엔티티인가?" 확인
  4. 같으면 aliases에 추가, 다르면 새 엔티티 생성
```

UNIQUE 제약: `(source_entity_id, target_entity_id, relation_type, claim_id)`.
같은 관계도 다른 Claim에서 추출되면 별개로 저장 (시간적 구분).

### 추가 스코어 차원 (entry_score에 추가)

```
actionability ← LLM 단일패스 분류 (Entry 레벨)
signal        ← 외부 반응 수집 (GitHub stars, HN upvotes, 인용 수)
```

### Search 확장

```
기존 Entry + Claim 검색 그대로 동작
  +
Graph traversal 추가:
  "Bun과 관련된 모든 기술" → KG 탐색
  모순 감지: 같은 엔티티에 대해 contradicting Claim 발견
  엔티티 시맨틱 검색: "JavaScript 런타임들" → Bun, Node, Deno
```

---

## Storage

### v0.2 스키마 — 구현 완료 (코드가 source of truth: `src/db/schema.ts`, `src/db/migrate.ts`)

### crawl_domain (미구현 — Deep Crawl Engine용)

```sql
CREATE TABLE crawl_domain (
  domain TEXT PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'unknown',
  trust DOUBLE PRECISION NOT NULL DEFAULT 0.1 CHECK (trust >= 0 AND trust <= 1),
  blocked BOOLEAN NOT NULL DEFAULT false,
  block_reason TEXT,
  rate_limit_ms INTEGER NOT NULL DEFAULT 2000,
  robots_txt TEXT,
  robots_fetched_at TIMESTAMPTZ,
  config JSONB,                 -- { headers, waitMs, selectors }
  total_crawled INTEGER NOT NULL DEFAULT 0,
  total_success INTEGER NOT NULL DEFAULT 0,
  last_crawled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_crawl_domain_blocked ON crawl_domain(blocked);
CREATE INDEX idx_crawl_domain_source_type ON crawl_domain(source_type);
```

### v0.3 추가 스키마 (미리보기)

```sql
-- Claim
CREATE TABLE claim (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  entry_created_at TIMESTAMPTZ NOT NULL,
  statement TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('factual', 'subjective', 'predictive', 'normative')),
  verdict TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verdict IN ('verified', 'disputed', 'unverified', 'not_applicable')),
  certainty DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (certainty >= 0 AND certainty <= 1),
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding vector(1536),
  FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
);

CREATE INDEX idx_claim_entry ON claim(entry_id);
CREATE INDEX idx_claim_type_verdict ON claim(type, verdict);
CREATE INDEX idx_claim_embedding ON claim USING hnsw(embedding vector_cosine_ops);

-- 검증 큐
CREATE TABLE verify_queue (
  claim_id TEXT PRIMARY KEY REFERENCES claim(id) ON DELETE CASCADE,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Entry 스코어 (factuality, novelty)
CREATE TABLE entry_score (
  entry_id TEXT NOT NULL,
  entry_created_at TIMESTAMPTZ NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('factuality', 'novelty', 'actionability', 'signal')),
  value DOUBLE PRECISION NOT NULL CHECK (value >= 0 AND value <= 1),
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scored_by TEXT NOT NULL DEFAULT 'system',
  PRIMARY KEY (entry_id, entry_created_at, dimension),
  FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
);
```

### v0.4 추가 스키마 (미리보기)

```sql
-- Entity (KG 노드)
CREATE TABLE entity (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  aliases TEXT[] DEFAULT '{}',
  metadata JSONB,
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relation (KG 엣지)
CREATE TABLE kg_relation (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  target_entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  claim_id TEXT REFERENCES claim(id),
  weight DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_entity_id, target_entity_id, relation_type, claim_id)
);

CREATE INDEX idx_entity_name ON entity(name);
CREATE INDEX idx_entity_type ON entity(type);
CREATE INDEX idx_entity_embedding ON entity USING hnsw(embedding vector_cosine_ops);
CREATE INDEX idx_kg_relation_source ON kg_relation(source_entity_id);
CREATE INDEX idx_kg_relation_target ON kg_relation(target_entity_id);
```

---

## Architecture (v0.2)

```
┌──────────────────────────────────────────────────┐
│                Knoldr A2A Server                  │
│                                                  │
│  ┌───────────────────────────────────────────┐   │
│  │  A2A Endpoint (JSON-RPC 2.0 / HTTP)       │   │
│  │  Auth: Bearer token                       │   │
│  │                                           │   │
│  │  Message: store/query/explore/feedback/audit│  │
│  │  Task:    research                        │   │
│  └──────────┬────────────────────────────────┘   │
│             │                                    │
│  ┌──────────▼────────────────────────────────┐   │
│  │            Core Engine                    │   │
│  │                                           │   │
│  │  ┌─────────────────────────────────────┐  │   │
│  │  │  Ingestion Engine (핵심)             │  │   │
│  │  │  Codex CLI (decompose + classify)     │  │   │
│  │  │                                     │  │   │
│  │  │  원자적 분해 → 메타데이터 분류 →      │  │   │
│  │  │  임베딩 → 중복 감지 → Authority →    │  │   │
│  │  │  저장 or 버림                        │  │   │
│  │  └─────────────────────────────────────┘  │   │
│  │                                           │   │
│  │  ┌───────────┐  ┌─────────────────────┐   │   │
│  │  │  Search   │  │  Authority Scorer   │   │   │
│  │  │  Engine   │  │  + Feedback Loop    │   │   │
│  │  │           │  │                     │   │   │
│  │  │ pgroonga  │  │  규칙 + atomic SQL  │   │   │
│  │  │ +freshness│  │  feedback_log 감사  │   │   │
│  │  │ +authority│  │  rate limit         │   │   │
│  │  │           │  │                     │   │   │
│  │  └───────────┘  └─────────────────────┘   │   │
│  │                                           │   │
│  │  ┌───────────┐  ┌─────────────────────┐   │   │
│  │  │ Research  │  │  Retry Queue        │   │   │
│  │  │           │  │  (API 장애 복구)    │   │   │
│  │  └───────────┘  └─────────────────────┘   │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  ┌───────────────────────────────────────────┐   │
│  │  Storage (PostgreSQL + pgroonga + pgvector)  │   │
│  │  Partitioned by year                      │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  ┌───────────────────────────────────────────┐   │
│  │  Observability                            │   │
│  │  Prometheus metrics + JSON structured log │   │
│  │  GET /health                              │   │
│  └───────────────────────────────────────────┘   │
│                                                  │
│  ┌───────────────────────────────────────────┐   │
│  │  CLI (knoldr --help)                    │   │
│  │  knoldr serve / store / query / explore   │   │
│  │  knoldr feedback / audit                  │   │
│  └───────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

---

## A2A Interface (v0.2)

### AgentCard, Protocol, Server 구조 — 구현 완료 (코드가 source of truth: `src/a2a/`)

### Error Codes

```
JSON-RPC 표준:
  -32700  Parse error (잘못된 JSON)
  -32600  Invalid request (필수 필드 누락)
  -32601  Method not found (잘못된 method)
  -32602  Invalid params (파라미터 검증 실패)
  -32603  Internal error (서버 내부 오류)

Application 에러:
  1001  Validation error (입력 크기/형식 검증 실패, data에 상세 사유)
  1002  Duplicate detected (모든 entries가 중복)
  1003  Rate limited (feedback rate limit 초과)
  1004  Unauthorized (Bearer token 불일치/누락)
  1005  Budget exceeded (research 일일 예산 초과)
```

### Operations

**Message (즉시 응답, method: `message/send`):**

| skill | input | output |
|-------|-------|--------|
| `store` | Mode 1: `{ raw, sources? }` / Mode 2: `{ entries[{ title, content, domain[], tags[]?, language?, decayRate?, metadata? }], sources? }` | `{ entries: [{ entryId, authority, decayRate, action }] }` |
| `query` | `{ query: string, domain?, tags?, language?, minAuthority?, minTrustLevel?, includeClaims?, limit?, cursor? }` | `{ results: [{ entry: Entry, scores: { relevance, authority, freshness, factuality?, final }, trustLevel: string, claims?: Claim[] }], nextCursor? }` |
| `explore` | `{ domain?, tags?, minAuthority?, minTrustLevel?, sortBy?, limit?, cursor? }` | `{ results: [{ entry: Entry, scores: { authority, freshness, factuality?, final }, trustLevel: string }], nextCursor? }` |
| `feedback` | `{ entryId, signal: 'positive' \| 'negative', reason? }` | `{ entryId, newAuthority }` |
| `audit` | `{ domain? }` | `{ totalEntries, activeEntries, avgAuthority, ingestion: { last24h: { stored, duplicate, rejected } }, domainDistribution: { [domain]: count } }` |

**Task (비동기, `message/send`로 시작 → `tasks/get`로 조회):**

| skill | input | output |
|-------|-------|--------|
| `research` | `{ topic: string, domain?, maxUrls?, contentTypes?, maxDepth?, focusDomains? }` | `{ taskId, entries: Entry[], urlsCrawled: number, status: 'completed' \| 'partial' }` |

store/query/explore/feedback/audit 상세 — 구현 완료 (코드가 source of truth: `src/a2a/handlers/`, `src/ingest/validate.ts`)

### Deep Crawl Engine (비동기 Task)

검색 API가 주는 링크만 보는 게 아니라, 링크를 따라가며 깊이 탐색한다.
핵심 가치는 검색 API가 아니라 **크롤러 + LLM 링크 선별 루프**에 있다.
크롤러가 콘텐츠를 정제해서 LLM에 전달. LLM은 HTML 파싱에 컨텍스트를 낭비하지 않는다.

**A2A 흐름:**

```
외부 에이전트 → query "xz-utils backdoor" → knoldr → 결과 부족
외부 에이전트 → research "xz-utils backdoor 공급망 공격 분석" → knoldr
    │
    ▼
  Deep Crawl Engine 시작 (비동기 Task)
    → 쿼리 분해 → DuckDuckGo → seed URL → 딥크롤링 → 적재
    → GetTask로 진행 상황 조회 가능
    │
    ▼
  완료 (or partial) 반환
외부 에이전트 → query "xz-utils backdoor" → 풍부한 결과
```

**research 요청:**

```
{
  topic: string,             // 자연어 요청 (필수)
  domain?: string,           // 특정 도메인으로 제한
  maxUrls?: number,          // URL 예산 (기본 50, 최대 200)
  contentTypes?: string[],   // ["html", "pdf", "image", "youtube"] (기본: 전체)
  maxDepth?: number,         // 링크 추적 깊이 (기본 2, 최대 5)
  focusDomains?: string[],   // 우선 크롤링 도메인 (e.g., ["nvd.nist.gov"])
}
```

**파이프라인:**

```
research 요청 수신
    │
    ▼
1. 쿼리 분해 (Query Decomposition) [Gemini CLI]
    자연어 → 원자적 서브쿼리 3-7개 분해
    + 쿼리 확장 (동의어/관련어 추가)
    프롬프트:
      "Break this research request into 3-7 atomic search queries.
       For each query, add 1-2 synonym expansions.
       Return JSON: { queries: [{ main: string, expansions: string[] }] }"
    예시:
      입력: "xz-utils 백도어 공급망 공격의 타임라인과 영향 범위"
      출력:
        { main: "CVE-2024-3094 timeline", expansions: ["xz-utils backdoor discovery"] }
        { main: "xz-utils 5.6.0 affected distributions", expansions: ["xz backdoor impact linux"] }
        { main: "xz supply chain attack analysis", expansions: ["open source supply chain security"] }
    │
    ▼
2. Seed URL 수집 (DuckDuckGo Lite HTTP scraping)
    서브쿼리별 DuckDuckGo 호출 → 쿼리당 상위 10개 URL
    + expansion 쿼리도 각각 DuckDuckGo 호출
    중복 URL 제거 → seed URL 풀 구성
    │
    ▼
3. 딥크롤링 루프 (Playwright 기반)
    in-memory URL 큐 (Set, 방문 여부 추적)
    │
    ▼ 반복 (URL 예산 소진 or 큐 비면 종료)
    │
    ├─ 3a. 도메인 정책 확인 (crawl_domain 테이블)
    │   ├─ blocked=true → 스킵
    │   ├─ robots.txt 거부 → 스킵
    │   ├─ rate_limit_ms 미충족 → 대기
    │   └─ 신규 도메인 → 행 생성, robots.txt fetch
    │
    ├─ 3b. URL 중복 확인
    │   └─ ingest_log.url_hash에 있음 → 스킵 (이미 적재됨)
    │
    ├─ 3c. 콘텐츠 추출 (Content-Type별 분기)
    │   ├─ text/html → Playwright 렌더링 → Readability 본문 추출
    │   ├─ application/pdf → pdf-parse 텍스트 추출
    │   ├─ image/* → Gemini CLI 멀티모달 (이미지 → 텍스트)
    │   ├─ YouTube URL → 자막 추출 (innertube API)
    │   │   └─ 자막 없음 → Gemini CLI 멀티모달 폴백
    │   └─ 기타 → 스킵
    │
    ├─ 3d. 추출 실패 처리
    │   └─ 본문 < 100자 or 추출 실패 → 스킵, crawl_domain.total_crawled++ (success 아님)
    │
    ├─ 3e. Ingestion Engine으로 적재
    │   └─ Mode 1 (raw) → 분해 → 임베딩 → 중복감지 → authority → 저장
    │       sources = [{ url, sourceType: crawl_domain.source_type or URL 패턴 추정 }]
    │
    └─ 3f. 링크 수집 + LLM 선별
        페이지 내 링크 추출 (a[href])
        maxDepth 미달 시:
          LLM에 링크 목록 + 원래 topic 전달 [Gemini CLI]
          "이 링크 중 topic과 관련 있는 것만 선택하라"
          선별된 링크 → URL 큐에 추가
    │
    ▼
4. 도메인 통계 갱신
    crawl_domain: total_crawled, total_success, last_crawled_at 업데이트
    success_rate 지속 하락 (< 10%) 시 → blocked=true 자동 전환
    │
    ▼
5. 결과 반환 (A2A Task)
    완료 시: status='completed', 저장된 entries 목록
    예산 소진 시: status='partial', 처리된 것까지 반환
```

**쿼리 분해 (Query Decomposition) 상세:**

```
단순 키워드 검색은 품질이 낮다.
자연어 요청을 원자적 서브쿼리로 분해 + 동의어 확장하여 검색 커버리지를 극대화.

기법:
  1. Decomposition: 복합 질문 → 원자적 서브쿼리 (각각 하나의 사실/측면)
  2. Expansion: 각 서브쿼리에 동의어/관련어 추가 (검색 그물 확장)
  3. 언어 분산: topic이 한국어면 영어 쿼리도 생성 (영어 소스가 압도적으로 많음)

Gemini CLI 호출: 구독제 커버. 1M 컨텍스트로 긴 topic도 처리 가능.
```

**콘텐츠 추출 상세:**

```
HTML (SSR/SPA 완벽 대응):
  Playwright (Chromium headless): JS 렌더링. 15초 타임아웃.
  페이지 로드 후 2초 대기 (SPA 동적 콘텐츠 안정화).
  linkedom + @mozilla/readability: 본문 추출.
  Readability는 태그 구조와 무관하게 텍스트 밀도 기반으로 본문 영역을 식별.
  네비게이션, 광고, 사이드바, 푸터 자동 제거.

PDF:
  pdf-parse: PDF → 텍스트 추출. 표, 목차 포함.
  페이지 수 제한: 최대 100페이지 (초과 시 앞 100페이지만).
  이미지 내 텍스트 (스캔 PDF): Gemini CLI 멀티모달로 폴백.

이미지 (png, jpg, svg, webp):
  Gemini CLI 멀티모달: 이미지 파일을 직접 입력.
  프롬프트: "Extract all text, data, and descriptions from this image."
  다이어그램, 스크린샷, 표, 인포그래픽 대응.
  이미지 크기 제한: 최대 10MB.

YouTube:
  자막 추출: innertube scraping → captionTracks → 자막 XML 파싱 (API key 불필요).
  자막 없음: Gemini CLI 멀티모달 (영상 프레임 분석). 비용 높으므로 예산 내에서만.
  쿼리당 상위 3개 영상.
```

**링크 선별 (LLM 기반):**

```
페이지 내 링크를 전부 따라가면 URL이 기하급수적으로 폭발한다.
LLM이 topic과의 관련성을 판단하여 선별.

규칙 기반 사전 필터 ($0, 먼저 실행):
  - 같은 도메인 내 링크 우선 (외부 도메인은 가중치 낮음)
  - 확장자 필터: .css, .js, .woff, .ico 등 제외
  - URL 패턴 필터: /login, /signup, /cart, /account 등 제외
  - 이미 방문한 URL 제외
  - anchor-only 링크 (#section) 제외

LLM 선별 (비쌈, 사전 필터 후 실행):
  남은 링크 목록 + topic을 Gemini CLI에 전달.
  "Select URLs most likely to contain information about: {topic}"
  상위 N개만 큐에 추가 (N은 남은 URL 예산에 비례).
```

**도메인 정책 (crawl_domain):**

```
크롤러가 매 도메인을 처음부터 학습하지 않도록, 도메인별 정책을 축적.

자동 학습:
  - 신규 도메인 방문 시 자동 행 생성 (기본값)
  - robots.txt 자동 fetch + 캐시 (24시간 TTL)
  - 크롤링 결과에 따라 total_crawled, total_success 업데이트
  - success_rate < 10% 지속 시 blocked=true 자동 전환 (알림 로그)

수동 설정:
  - CLI로 도메인 차단/해제, source_type 지정, rate_limit 조정
  - config JSONB에 사이트별 특수 설정 (커스텀 헤더, 대기 시간, CSS 셀렉터)

authority 연동:
  crawl_domain.source_type이 설정된 도메인의 URL은
  해당 source_type으로 authority 계산.
  미설정 시 URL 패턴 기반 추정 (기존 로직 유지).
```

**예산 및 제한:**

```
URL 예산 (maxUrls): 기본 50, 최대 200.
  타임아웃이 아닌 URL 개수로 제어. 딥크롤링은 시간 예측이 어려움.
  예산 소진 시 즉시 partial 반환.

타임아웃: 15분 (URL당 평균 15초 × 50 URL = 12.5분 + 여유).
  타임아웃 도달 시 즉시 partial 반환.

DuckDuckGo Lite: HTTP scraping, 무료, API key 불필요.
YouTube 자막: innertube scraping, 무료, API key 불필요.

동시 research 태스크: 최대 3개 (Playwright 브라우저 리소스 제한).
  초과 시 큐 대기.
```

---

## Directory Structure (v0.2)

```
knoldr/
├── src/
│   ├── index.ts                     # 엔트리포인트
│   ├── a2a/
│   │   ├── server.ts                # Bun.serve() HTTP 핸들러 (A2A + health + metrics + webhook)
│   │   ├── dispatcher.ts            # JSON-RPC 2.0 디스패처 (SendMessage, GetTask 라우팅)
│   │   ├── agent-card.ts            # GET /.well-known/agent-card.json
│   │   ├── auth.ts                  # Bearer token 인증 미들웨어
│   │   ├── handlers/
│   │   │   ├── store.ts
│   │   │   ├── query.ts
│   │   │   ├── explore.ts
│   │   │   ├── feedback.ts
│   │   │   ├── audit.ts
│   │   │   └── research.ts          # Task 생성 → 백그라운드 실행 → GetTask로 조회
│   │   └── types.ts                 # A2A skill 요청 추출
│   ├── lib/
│   │   └── ulid-utils.ts            # ULID 타임스탬프 디코딩
│   ├── db/
│   │   ├── schema.ts                # drizzle-orm 스키마 (PostgreSQL)
│   │   ├── migrate.ts               # drizzle-kit 마이그레이션
│   │   └── connection.ts
│   ├── ingest/
│   │   ├── engine.ts                # 적재 파이프라인 오케스트레이션
│   │   ├── decompose.ts             # 원자적 분해 + 메타데이터 분류 [Codex CLI]
│   │   ├── embed.ts                 # 임베딩 생성 (로컬 @huggingface/transformers, 중복 감지용)
│   │   ├── dedup.ts                 # 시맨틱 중복 감지 (cosine > 0.95)
│   │   └── validate.ts              # 입력 검증 (크기, 형식)
│   ├── score/
│   │   ├── authority.ts             # 출처 기반 authority 스코어
│   │   └── feedback.ts              # 피드백 처리 + rate limit + 감사 로그
│   ├── search/
│   │   ├── search.ts                # pgroonga FTS 검색
│   │   └── rank.ts                  # pgroonga_score 정규화 + authority + freshness 랭킹
│   ├── collect/
│   │   ├── research.ts              # Deep Crawl Engine 오케스트레이션
│   │   ├── query-decompose.ts       # 쿼리 분해 + 확장 (Gemini CLI)
│   │   ├── crawler.ts               # Playwright 딥크롤링 루프 (링크 추적)
│   │   ├── extract-html.ts          # HTML 본문 추출 (Readability)
│   │   ├── extract-pdf.ts           # PDF 텍스트 추출 (pdf-parse)
│   │   ├── extract-image.ts         # 이미지 → 텍스트 (Gemini CLI 멀티모달)
│   │   ├── extract-youtube.ts       # YouTube 자막 추출 + 멀티모달 폴백
│   │   ├── domain-policy.ts         # crawl_domain 조회/갱신, robots.txt 파싱
│   │   ├── link-filter.ts           # 링크 사전 필터 (규칙) + LLM 선별
│   │   ├── retry.ts                 # retry_queue 프로세서 (적재 실패 복구)
│   │   └── batch-dedup.ts           # 일일 중복 정리 (cosine > 0.95)
│   ├── observability/
│   │   ├── metrics.ts               # Prometheus 메트릭
│   │   ├── health.ts                # GET /health
│   │   └── logger.ts                # 구조화된 JSON 로거
│   └── cli/
│       └── index.ts
├── package.json
├── tsconfig.json
├── drizzle.config.ts
└── DESIGN.md
```

---

## Tech Stack

| 레이어 | 선택 | 이유 |
|--------|------|------|
| Runtime | Bun | zipbul 생태계 통일 |
| DB | PostgreSQL | 동시성, JSONB, 파티셔닝 |
| FTS | pgroonga | 다국어 FTS (CJK 네이티브 토큰화). PostgreSQL extension. |
| Vector Store | pgvector | 중복 감지 + 스코어링 전용. 검색에 사용하지 않음. |
| Embedding | @huggingface/transformers (all-MiniLM-L6-v2) | 384dim, 로컬 실행, API key 불필요. |
| ORM | drizzle-orm | 타입 세이프, PostgreSQL 지원. raw SQL 최소화. |
| DB Driver | postgres (porsager) | Bun 호환, 고성능 |
| Migration | drizzle-kit | drizzle-orm 통합 |
| Decompose LLM | Codex CLI (GPT-4.1 mini) | 지시 준수 + 구조화 출력 최고 품질/비용비. 구독제. |
| Research LLM | Gemini CLI (Gemini 2.0 Flash) | 1M 컨텍스트, $0.63/day. 구독제. |
| DOM Parser | linkedom + @mozilla/readability | Playwright 추출 HTML의 본문 파싱 |
| A2A | @a2a-js/sdk (타입 + server 코어) + Bun.serve() | SDK가 타입 + JSON-RPC 파싱/라우팅 제공. Express 불필요 (optional peer dep). HTTP 레이어만 Bun-native. |
| Verification | pyreez (설치형) | 멀티모델 심의, deliberation engine 직접 호출 (v0.3) |
| Web Search | DuckDuckGo Lite (HTTP scraping) | API key 불필요. 무료. |
| Content Extraction | Playwright + @mozilla/readability | JS 렌더링 + 본문 추출 (SSR/SPA 대응). 자체 호스팅. |
| PDF Extraction | pdf-parse | PDF → 텍스트 추출. 표/목차 포함. |
| Image Extraction | Gemini CLI (멀티모달) | 이미지 → 텍스트. 다이어그램/스크린샷/인포그래픽 대응. 구독제. |
| Video Transcript | innertube scraping + 자막 파싱 | 영상 콘텐츠 텍스트화. API key 불필요. 자막 없으면 Gemini 멀티모달 폴백. |
| Observability | prom-client + pino | Prometheus 메트릭 + 구조화 로그 |

### 하드웨어 요구사항

```
최소:
  GPU: 불필요 (로컬 임베딩은 CPU로 실행)
  RAM: 4GB+ (Bun + PostgreSQL)
  Storage: SSD, PostgreSQL 데이터 + pgroonga 인덱스

권장:
  RAM: 8GB+
  Storage: NVMe SSD
```

### Environment Variables

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `DATABASE_URL` | O | - | PostgreSQL 연결 문자열 (e.g., `postgres://user:pass@host:5432/knoldr`) |
| `LANGSEARCH_API_KEY` | O | - | LangSearch web search API key (https://langsearch.com/dashboard) |
| `KNOLDR_API_TOKEN` | X | - | A2A Bearer token 인증. 미설정 시 open access. |
| `KNOLDR_CODEX_CLI` | X | `codex` | Codex CLI 실행 경로 (분해용) |
| `KNOLDR_GEMINI_CLI` | X | `gemini` | Gemini CLI 실행 경로 (리서치용) |
| `KNOLDR_PORT` | X | `5100` | 서버 포트 |
| `KNOLDR_HOST` | X | `0.0.0.0` | 서버 바인드 주소 |
| `KNOLDR_LOG_LEVEL` | X | `info` | 로그 레벨 (`error`, `warn`, `info`, `debug`) |

웹 검색은 LangSearch API, 임베딩은 로컬 @huggingface/transformers (API key 불필요), YouTube 자막은 innertube scraping (API key 불필요).

### CLI Specification — 구현 완료 (`src/cli/index.ts`, `knoldr --help`)

### Testing — 구현 완료 (164 tests passing: `bun test`)

---

## Phase Plan

### Phase 1: DB + Ingestion + Search + CLI ✅

### Phase 2: A2A Server + Deep Crawl Engine + Observability
- ✅ A2A 서버 (Bearer token 인증, @a2a-js/sdk + Bun.serve())
- ✅ Feedback loop (atomic SQL, rate limit, feedback_log)
- ✅ Batch dedup job (일 1회, 동시성 race condition 정리)
- ✅ 에러 핸들링 (지수 백오프, retry_queue)
- ✅ Prometheus 메트릭, 구조화 로그, health check
- ✅ Testing suite (unit + integration + e2e)
- Deep Crawl Engine:
  - crawl_domain 테이블 + 마이그레이션
  - 쿼리 분해 + 확장 (Query Decomposition, Gemini CLI)
  - DuckDuckGo → seed URL → Playwright 딥크롤링 (링크 추적, LLM 선별)
  - 멀티타입 추출 (HTML/Readability, PDF/pdf-parse, 이미지/Gemini 멀티모달, YouTube/자막)
  - 도메인 정책 (robots.txt 파싱, rate limit, 자동 차단)
  - 링크 필터 (규칙 사전 필터 + LLM 선별)
- 데이터 수집은 외부 전문 에이전트가 A2A store로 수행

### Phase 3: Claim Layer (v0.3)
- claim, verify_queue, entry_score 테이블 추가 (Entry 변경 없음)
- LLM Claim 추출 파이프라인
- Pyreez 설치 + 검증 연동 (factual claim 검증)
- Entry factuality 스코어 (claim 집계)
- Claim 단위 검색
- novelty 스코어 (임베딩 거리)

### Phase 4: Knowledge Graph (v0.4)
- entity, kg_relation 테이블 추가
- Entity resolution (이름 + 임베딩 + LLM 확인)
- Claim → 엔티티/관계 추출
- 엔티티 임베딩 + 시맨틱 검색
- Graph traversal 검색
- actionability, signal 스코어 차원
- 모순 감지
