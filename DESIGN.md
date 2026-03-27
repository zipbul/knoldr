# Searhead — Design Draft v0.1

Bun-native technical knowledge database for the zipbul agentic ecosystem.

## Purpose

AI 에이전트가 바이브코딩 시 항상 최신의 검증된 기술 지식을 기반으로 코드를 작성하게 한다.
없는 지식은 직접 리서치해서 수집하고, 멀티모델 검증 후 저장한다.

## Core Concepts

### Knowledge Entry

지식의 최소 단위. DB에 직접 저장된다 (파일 없음).

```
Entry {
  id: string (ulid)
  title: string
  content: string              // 지식 본문
  type: EntryType              // 12종
  domain: string               // nodejs, bun, react, ai-models, ...
  tags: string[]
  technology: string
  versionRange: string | null  // 적용 버전 범위 (e.g. ">=22.0.0")

  // 품질 평가
  trustLevel: 0 | 1 | 2       // UNVERIFIED | BASIC | VERIFIED
  certainty: number            // 0-1, 확실성
  factuality: Factuality       // verified | unverified | disputed | opinion
  value: Value                 // critical | high | medium | low

  // 시간
  createdAt: Date
  lastVerifiedAt: Date | null
  validFrom: Date | null
  validUntil: Date | null
  decayRate: number            // 일별 감쇠율
  reviewBy: Date               // 자동 리뷰 트리거 날짜

  // 출처
  sources: Source[]            // { url, type, trust }
  sourceType: SourceType       // official_docs | blog | paper | forum | ai_generated

  // 관계
  supersedes: string[]         // 대체하는 엔트리 ID
  contradicts: string[]        // 상충하는 엔트리 ID
  relatedTo: string[]          // 관련 엔트리 ID

  // 상태
  status: Status               // draft | active | stale | deprecated | archived

  // 벡터
  embedding: Float32Array      // sqlite-vec용
}
```

### Entry Types (12종)

| type | 설명 | 거짓/부정 포함 | 비교 포함 |
|------|------|:-:|:-:|
| `fact` | 검증된 사실 | - | - |
| `pattern` | 권장 패턴/베스트 프랙티스 | - | - |
| `anti_pattern` | 하지 말아야 할 것 + 올바른 대안 | Y | - |
| `comparison` | X vs Y (장단점 필수) | - | Y |
| `breaking_change` | 버전 간 호환성 변경 | Y | Y |
| `security` | CVE/취약점 + 수정 방법 | Y | - |
| `decision` | 왜 X를 선택했는지 (ADR) | - | Y |
| `migration` | A→B 가이드 | - | Y |
| `deprecation` | 폐기 예정/완료 + 대체재 | Y | - |
| `misconception` | 흔한 오해 + 실제 | Y | - |
| `release` | 릴리즈 요약 + 주요 변경점 | - | - |
| `troubleshoot` | 문제→원인→해결 | - | - |

### Trust Levels (3단계)

```
Level 0: UNVERIFIED
  → 수집 직후. 검색 결과에 포함되지 않음.

Level 1: BASIC
  → 출처 신뢰도 기반 자동 판정 (비용 $0).
  → official_docs, github_release, cve_db → 자동 승격.
  → 검색 결과에 포함됨. 확실성 표시.

Level 2: VERIFIED
  → Pyreez 멀티모델 합의 완료.
  → 검색 결과에서 우선 순위 높음.
  → 확실성/사실성/가치 스코어 확정.
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│              Searhead A2A Server             │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │  A2A Endpoint (JSON-RPC 2.0 / HTTP)  │   │
│  │                                      │   │
│  │  Message (즉시 응답):                 │   │
│  │    query / ingest / list / audit      │   │
│  │                                      │   │
│  │  Task (비동기):                       │   │
│  │    research / analyze / verify        │   │
│  └──────────┬───────────────────────────┘   │
│             │                               │
│  ┌──────────▼───────────────────────────┐   │
│  │          Core Engine                  │   │
│  │                                      │   │
│  │  ┌─────────┐  ┌──────────────────┐   │   │
│  │  │ Search  │  │ Collector        │   │   │
│  │  │ Engine  │  │                  │   │   │
│  │  │         │  │ RSS/Atom parser  │   │   │
│  │  │ FTS5    │  │ GitHub Releases  │   │   │
│  │  │ + vec   │  │ npm Registry     │   │   │
│  │  │ hybrid  │  │ OSV.dev          │   │   │
│  │  │ search  │  │ Web Research     │   │   │
│  │  └─────────┘  └──────────────────┘   │   │
│  │                                      │   │
│  │  ┌─────────┐  ┌──────────────────┐   │   │
│  │  │ Scorer  │  │ Lifecycle Mgr    │   │   │
│  │  │         │  │                  │   │   │
│  │  │ trust   │  │ time decay       │   │   │
│  │  │ level   │  │ auto stale       │   │   │
│  │  │ assign  │  │ review trigger   │   │   │
│  │  └─────────┘  └──────────────────┘   │   │
│  └──────────────────────────────────────┘   │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │  Storage (SQLite + sqlite-vec + FTS5) │   │
│  │  ~/.searhead/searhead.db              │   │
│  └──────────────────────────────────────┘   │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │  CLI (사람용 직접 조작)                │   │
│  │  searhead query "..."                 │   │
│  │  searhead ingest <file>               │   │
│  │  searhead audit                       │   │
│  │  searhead serve (A2A 서버 시작)        │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
         ↕ A2A
┌────────────────────┐
│ Pyreez             │
│ (멀티모델 검증)      │
│ Level 1 → Level 2  │
└────────────────────┘
```

---

## Storage

### SQLite 단일 파일: `~/.searhead/searhead.db`

**Tables:**

```sql
-- 지식 엔트리
CREATE TABLE entry (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL,          -- 12종
  domain TEXT NOT NULL,
  technology TEXT,
  version_range TEXT,
  trust_level INTEGER NOT NULL DEFAULT 0,
  certainty REAL NOT NULL DEFAULT 0.0,
  factuality TEXT NOT NULL DEFAULT 'unverified',
  value TEXT NOT NULL DEFAULT 'medium',
  source_type TEXT NOT NULL,
  sources_json TEXT NOT NULL,   -- JSON array of Source
  status TEXT NOT NULL DEFAULT 'draft',
  decay_rate REAL NOT NULL DEFAULT 0.005,
  created_at TEXT NOT NULL,
  last_verified_at TEXT,
  valid_from TEXT,
  valid_until TEXT,
  review_by TEXT NOT NULL,
  supersedes_json TEXT,         -- JSON array of entry IDs
  contradicts_json TEXT,
  related_to_json TEXT
);

-- 태그 (M:N)
CREATE TABLE entry_tag (
  entry_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag)
);

-- FTS5 전문 검색
CREATE VIRTUAL TABLE entry_fts USING fts5(
  title, content, domain, technology,
  content=entry, content_rowid=rowid
);

-- sqlite-vec 벡터 검색
CREATE VIRTUAL TABLE entry_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[384]          -- nomic-embed-text 기본, 차원 설정 가능
);

-- 수집 소스 관리
CREATE TABLE source_feed (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL,           -- rss | github_release | npm | osv | custom
  domain TEXT NOT NULL,
  schedule TEXT NOT NULL,        -- cron expression
  last_fetched_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- 수집 이력 (중복 방지)
CREATE TABLE ingest_log (
  url_hash TEXT PRIMARY KEY,
  source_feed_id TEXT,
  ingested_at TEXT NOT NULL
);

-- 검증 큐
CREATE TABLE verify_queue (
  entry_id TEXT PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  queued_at TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0  -- 높을수록 우선
);
```

---

## A2A Interface

### AgentCard

```json
{
  "name": "searhead",
  "description": "Technical knowledge database for zipbul agentic ecosystem. Stores, retrieves, and verifies technical knowledge across all domains.",
  "version": "0.1.0",
  "skills": [
    {
      "id": "query",
      "description": "Search knowledge entries by semantic similarity and keywords"
    },
    {
      "id": "ingest",
      "description": "Store new knowledge entry with automatic trust level assignment"
    },
    {
      "id": "research",
      "description": "Research a topic via web search, structure findings, and store verified entries"
    },
    {
      "id": "analyze",
      "description": "Analyze impact of a change or compare technologies using stored knowledge"
    },
    {
      "id": "audit",
      "description": "Report stale, deprecated, or low-certainty entries"
    },
    {
      "id": "list",
      "description": "List entries filtered by domain, type, status, trust level"
    }
  ]
}
```

### Operations

**Message (즉시 응답 — 모델 불필요):**

| skill | input | output |
|-------|-------|--------|
| `query` | `{ query: string, domain?: string, type?: string, minTrust?: 0\|1\|2, limit?: number }` | `Entry[]` with relevance scores |
| `ingest` | `{ title, content, type, domain, sources[], ... }` | `{ entryId, trustLevel }` |
| `list` | `{ domain?, type?, status?, trustLevel?, limit? }` | `Entry[]` |
| `audit` | `{ domain? }` | `{ stale: Entry[], deprecated: Entry[], lowCertainty: Entry[] }` |

**Task (비동기 — 모델 사용):**

| skill | input | output | 왜 Task인가 |
|-------|-------|--------|------------|
| `research` | `{ topic: string, domain?: string }` | `Entry[]` (수집된 엔트리) | 웹 리서치 → 구조화 → 검증. 수 분 소요 |
| `analyze` | `{ question: string, context?: string }` | `{ analysis, affectedEntries, recommendation }` | 다수 엔트리 분석 + 추론. 모델 필요 |

---

## Search Pipeline

```
Query 입력
    │
    ▼
┌─ Hybrid Search ──────────────────────┐
│                                      │
│  FTS5 (키워드 매칭)                   │
│    + sqlite-vec (시맨틱 유사도)        │
│    → Reciprocal Rank Fusion          │
│                                      │
└──────────┬───────────────────────────┘
           │ 상위 50개
           ▼
┌─ Metadata Filter ────────────────────┐
│  trust_level >= minTrust (기본 1)     │
│  status = 'active'                   │
│  certainty > threshold (감쇠 적용 후)  │
└──────────┬───────────────────────────┘
           │
           ▼
┌─ Scoring ────────────────────────────┐
│  final_score =                       │
│    relevance * 0.6                   │
│    + certainty_after_decay * 0.25    │
│    + value_weight * 0.15             │
│                                      │
│  value_weight:                       │
│    critical=1.0, high=0.7,           │
│    medium=0.4, low=0.1               │
└──────────┬───────────────────────────┘
           │ 상위 N개
           ▼
        결과 반환
```

---

## Collection Pipeline

### 자동 수집 (스케줄 기반)

```
source_feed 테이블의 enabled=1 피드를 cron 스케줄에 따라 실행

Feed fetch
    │
    ▼
중복 검사 (ingest_log.url_hash)
    │ 신규만
    ▼
원시 데이터 → LLM 구조화 (type/domain/tags 분류, 요약 생성)
    │
    ▼
Trust Level 판정 (규칙 기반, $0):
    ├─ official_docs / github_release / cve_db → Level 1
    ├─ official_blog → Level 1
    └─ 그 외 → Level 0
    │
    ▼
Entry 저장 + 벡터 임베딩 생성
    │
    ▼
Level 0 엔트리 → verify_queue에 추가
```

### 기본 수집 소스

| 소스 | 대상 | 방식 | 스케줄 |
|------|------|------|--------|
| GitHub Releases Atom | 감시 패키지 릴리즈 | RSS | 1일 |
| npm Registry API | 의존성 패키지 업데이트 | REST | 1일 |
| OSV.dev | 보안 취약점 | REST | 4시간 |
| 공식 블로그 RSS | Bun, Node.js, React, TS 등 | RSS | 1일 |
| arXiv | AI 논문 (cs.AI, cs.CL) | Atom | 1주 |

### 온디맨드 리서치 (A2A Task)

```
research 요청 수신
    │
    ▼
Task 생성 [working]
    │
    ▼
웹 검색 (Tavily/Exa/Jina Reader)
    │
    ▼
결과 분석 + 구조화 → 다수 Entry 생성 (Level 0)
    │
    ▼
Pyreez A2A 호출 → 멀티모델 검증
    │
    ▼
검증 통과 → Level 2 승격, 스코어 확정
    │
    ▼
Task [completed] → 결과 반환
```

---

## Verification Pipeline

```
verify_queue에서 엔트리 꺼냄 (priority DESC)
    │
    ▼
Pyreez A2A 호출:
    - 엔트리 content + sources 전달
    - 멀티모델 심의 요청 (producer → reviewers → leader)
    │
    ▼
심의 결과 수신:
    - certainty: 0-1
    - factuality: verified | unverified | disputed | opinion
    - value: critical | high | medium | low
    - reasoning: string (판단 근거)
    │
    ▼
certainty >= 0.5 → Level 2 승격, 스코어 저장
certainty < 0.5  → status = 'disputed' 또는 삭제
```

---

## Lifecycle Management

### 시간 감쇠

```
effective_certainty = certainty * exp(-decay_rate * days_since_verified)

decay_rate 기준:
  security    → 0.03  (14일 후 절반)
  release     → 0.01  (69일 후 절반)
  pattern     → 0.005 (139일 후 절반)
  fact        → 0.001 (693일 후 절반)
  알고리즘/원리 → 0.0001 (무기한)
```

### 자동 상태 전환

```
active → stale:    effective_certainty < 0.3
stale → archived:  review_by 경과 후 30일간 미검증
active → deprecated: supersedes 관계 설정 시
```

---

## Directory Structure

```
searhead/
├── src/
│   ├── index.ts                 # 엔트리포인트
│   ├── a2a/
│   │   ├── server.ts            # A2A 서버 (JSON-RPC 2.0)
│   │   ├── agent-card.ts        # AgentCard 정의
│   │   ├── handlers/
│   │   │   ├── query.ts         # Message handler
│   │   │   ├── ingest.ts        # Message handler
│   │   │   ├── list.ts          # Message handler
│   │   │   ├── audit.ts         # Message handler
│   │   │   ├── research.ts      # Task handler
│   │   │   └── analyze.ts       # Task handler
│   │   └── types.ts
│   ├── db/
│   │   ├── schema.ts            # drizzle-orm 스키마
│   │   ├── migrate.ts
│   │   └── connection.ts
│   ├── search/
│   │   ├── hybrid.ts            # FTS5 + vec 하이브리드
│   │   ├── embed.ts             # 임베딩 생성 (nomic-embed-text via Ollama)
│   │   └── score.ts             # 최종 스코어링 (relevance + certainty + value)
│   ├── collect/
│   │   ├── scheduler.ts         # cron 스케줄러
│   │   ├── feeds/
│   │   │   ├── rss.ts
│   │   │   ├── github-release.ts
│   │   │   ├── npm-registry.ts
│   │   │   ├── osv.ts
│   │   │   └── arxiv.ts
│   │   └── research.ts          # 온디맨드 웹 리서치
│   ├── verify/
│   │   ├── queue.ts             # 검증 큐 관리
│   │   ├── trust.ts             # Trust Level 판정 규칙
│   │   └── pyreez.ts            # Pyreez A2A 클라이언트
│   ├── lifecycle/
│   │   ├── decay.ts             # 시간 감쇠 계산
│   │   └── transition.ts        # 자동 상태 전환
│   └── cli/
│       └── index.ts             # CLI 커맨드
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
| DB | SQLite (bun:sqlite) | 임베디드, 서버 불필요, Gildash와 동일 |
| Vector Search | sqlite-vec | Bun 공식 지원, FTS5와 같은 DB |
| FTS | SQLite FTS5 | 내장, 하이브리드 검색 |
| ORM | drizzle-orm | 타입 세이프, SQLite 지원 |
| Embedding | nomic-embed-text (Ollama) | 무료, 로컬, 384dim |
| A2A | @anthropic-ai/a2a (또는 직접 구현) | JSON-RPC 2.0, 표준 프로토콜 |
| Collection | 내장 RSS/API 파서 | 의존성 최소화 |
| Verification | Pyreez (A2A) | 기존 zipbul 패키지 활용 |

---

## Phase Plan

### Phase 1: Core (DB + Search + CLI)
- SQLite 스키마 + sqlite-vec + FTS5
- Entry CRUD
- 하이브리드 검색 (벡터 + 키워드)
- CLI (query, ingest, list)
- Ollama 임베딩 연동

### Phase 2: A2A Server
- A2A 서버 (Message handlers: query, ingest, list, audit)
- AgentCard
- 기본 스코어링

### Phase 3: Collection
- RSS/Atom 수집기
- GitHub Releases 수집기
- npm Registry 수집기
- OSV.dev 수집기
- 스케줄러
- Trust Level 자동 판정

### Phase 4: Verification + Lifecycle
- Pyreez A2A 연동
- 검증 큐 + 배치 처리
- 시간 감쇠
- 자동 상태 전환
- verify_queue 처리

### Phase 5: Research + Analyze (Task)
- 온디맨드 웹 리서치 (A2A Task)
- 영향도 분석 (A2A Task)
- Streaming/Push notification 지원
