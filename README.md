# Pokémon TCG Marketplace Agent

A purchasing and deck-building assistant built with **LangGraph**, **LangChain**, and the **Cloudscape Design System**. The system accepts natural language requests for Pokémon Trading Card Game singles and tournament decks, validates card identities and dated format legality, compares baseline price guides and, when enabled, seller quotations from TCGplayer and Cardmarket, and produces verifiable purchasing budgets with multi-currency conversion.

## Notice

> [!IMPORTANT]
> This is an independent research demonstration and proof of concept, **not affiliated with or endorsed by Nintendo, Creatures Inc., GAME FREAK, or The Pokémon Company**. Marketplace listings are retrieved via logged-out, read-only extraction through Apify without bypassing authentication or protection mechanisms. Source data and game assets remain property of their respective owners.

## Try the demo

Open **[TCG Marketplace Chat](https://chat.tcg-marketplace.02labs.me/)** · **[Administration Portal](https://admin.tcg-marketplace.02labs.me/)**.

<!-- TODO: Replace mock credentials and temporary URLs with verified production credentials once final deployment is active -->
| Email / Username | Password | Second Factor (2FA) | Daily Shared Allowance | Role |
|---|---|---|---|---|
| `demo@02labs.me` | `demo1234` | Authenticator App (TOTP) / Security Key (WebAuthn) | 50,000 input/output tokens | User |
| `admin@02labs.me` | `admin1234` | Authenticator App (TOTP) / Security Key (WebAuthn) | 200,000 input/output tokens | Administrator |

*Note: For testing against local development stacks, 2FA can be configured with an authenticator app (e.g. Google Authenticator) or a WebAuthn/FIDO2 passkey. In local mode, `LOCAL_DEV_PASSWORD_ONLY=true` may also be enabled to bypass second-factor challenges during development.*

### Example prompts to try

- **Deck search & budgeting**: *"I need to buy the cards for an M Lucario deck. Check two suppliers and prepare a budget in USD."*
- **Collection curation**: *"I want a Gardevoir collection with a product budget of 150000 JPY. English, Near Mint, one per printing. Prefer full-art cards, including non-secret full arts; older cards are welcome. Research candidates and prepare a buying estimate."*
- **Specific card singles**: *"I need 4 copies of Professor's Research, 2 Boss's Orders, and 4 Ultra Ball for the current Standard format in Near Mint condition."*
- **Multi-currency budget**: *"Prepare a purchasing budget for a Dragapult ex tournament deck with prices converted to EUR."*
- **Format legality verification**: *"Check if Mewtwo & Mew-GX is legal in the current Japanese Standard format."*

Completed budgets include **Download Excel**: export card names and codes, Cardmarket and TCGplayer prices in original and converted currencies, clickable product/listing links, supplier totals and dated exchange-rate evidence. See [Excel budget exports](docs/budget-exports.md) for workbook contents and availability limits.

---

## Commands and instructions to run and test locally

### Prerequisites

- **Python 3.11+**
- **Node.js 24+** and **npm**
- **Docker** and **Docker Compose**
- Accessible **PostgreSQL 16+** database instance (an external shared database or local instance)

### 1. Environment configuration

Clone the repository and prepare the root configuration:

```bash
git clone git@github.com:02loveslollipop/TCGMarketplaceAgent.git
cd TCGMarketplaceAgent
cp .env.example .env
```

Configure the connection variables in `.env`:

```env
# Required for one-shot database role & schema provisioning (never exposed to runtime containers)
EXTERNAL_JDBC_POSTGRES_URI_ADMIN=postgresql://administrator:YOUR_PASSWORD@host:5432/postgres

# Model provider API keys (supplied to orchestrator at runtime)
OPENAI_API_KEY=your_openai_key
MISTRAL_API_KEY=your_mistral_key

# Optional live marketplace scraping credentials (read-only Apify actors)
APIFY_API_KEY=your_apify_key

# WebAuthn relying party configuration
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=http://localhost:8080

# Session lifetime controls
MAX_SESSION_HOURS=168
REFRESH_GRACE_SECONDS=86400
```

### 2. Dependency installation & database provisioning

Create a virtual environment and install backend dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[test]'
npm --prefix frontend ci
```

Run the isolated provisioner script to create the dedicated `pokemon_tcg_poc` schema, restricted service roles, and cryptographic secrets:

```bash
# Provision isolated schema and service roles in PostgreSQL
python -m scripts.provision

# Verify database schema connectivity and table permissions
python -m scripts.check_database

# Create the initial administrator account (prompts privately for credentials)
python -m scripts.bootstrap_admin
# Alternatively, generate random administrator credentials:
# python -m scripts.bootstrap_admin --generate
```

*Security note: The provisioner uses the admin URI only to create the `pokemon_tcg_poc` schema and grant least-privilege permissions to three separate service roles (`auth`, `admin`, and `orchestrator`). It never touches other schemas.*

### 3. Launching the full stack with Docker Compose

Start all microservices, the DuckDuckGo MCP search server, and the Cloudscape frontend through the unified gateway:

```bash
docker compose config --quiet
docker compose up --build -d --wait
```

The gateway listens at `http://127.0.0.1:8080`:
- **Chat Portal**: [http://localhost:8080/](http://localhost:8080/)
- **Administration Portal**: [http://localhost:8080/admin/](http://localhost:8080/admin/)
- **Health check**: [http://localhost:8080/health](http://localhost:8080/health)

To bypass 2FA challenges during local automated smoke testing:

```bash
LOCAL_DEV_PASSWORD_ONLY=true docker compose up -d --build auth
```

### 4. Running the test suite

Execute the backend unit, integration, and regression suite (paid live tests are opt-in):

```bash
.venv/bin/pytest -q
```

Execute the frontend suite across Cloudscape chat, collections, admin, and authentication flows:

```bash
npm --prefix frontend test
```

Build the production frontend bundle:

```bash
npm --prefix frontend run build
```

Live post-deployment pytest scenarios and the manual research suite are documented in [Agent evaluations and CI](docs/ci/agent-evaluations.md). The Heroku workflow runs smoke tests only after all services deploy successfully.

See the [hosted validation record](docs/ci/validation-2026-11-13.md) for the verified deck, exact-card and collection scenarios, example budgets and explicit availability limits.

The admin [consumption dashboard and execution workspace](docs/admin-observability.md) provide user/API-principal usage, historical-role breakdowns, current quotas and snapshotted model cost estimates.

### 5. Updating the dated legality catalog

To synchronize the latest Pokémon TCG sets, regulation marks, and ban lists from TCGdex and official sources:

```bash
python -m scripts.refresh_legality
```

---

## Flow of LangGraph agents

The orchestrator executes a multi-step LangGraph workflow with deterministic state management, asynchronous supplier queries, and **Human-in-the-Loop (HITL)** checkpoints. Checkpoints and interruption states are persisted to PostgreSQL (`graph_checkpoints`), allowing seamless resumption across browser refreshes and multi-turn user decisions.

```mermaid
flowchart TD
    Start(["Start request"]) --> Router["router: deck, collection or specified cards"]
    Router -- "Build or revise deck" --> Builder["deck_builder: sourced deck research"]
    Router -- "Build a collection" --> Collector["collection_builder: researched printings"]
    Collector --> Question
    Router -- "Specified cards" --> Understand["understand: resolve card identities"]
    Builder --> Question{"Needs clarification?"}
    Understand --> Question
    Question -- "Yes" --> Clarify["clarify: saved user question"]
    Clarify -- "Answer" --> Router
    Clarify -- "Cancel" --> Cancel(["Cancelled"])
    Question -- "No" --> Validate["validate: identity and format legality"]
    Validate --> Deck{"Deck or non-collection 60-card list?"}
    Deck -- "Yes" --> Review["review: approve deck"]
    Review -- "Revise" --> Router
    Review -- "Cancel" --> Cancel
    Review -- "Approve" --> Baseline["card_search: baseline price guides"]
    Deck -- "No" --> Baseline
    Baseline --> Collection{"Collection request?"}
    Collection -- "Yes" --> Select["collection_budget: FX and spending-cap selection"]
    Select --> Quote["quote: selected-card stock and product links"]
    Collection -- "No" --> Quote
    Quote --> Missing["missing: allocate stock and classify evidence"]
    Missing --> Shortfall{"Verified listing shortfall?"}
    Shortfall -- "Yes" --> Decide["decide: alternatives or retain shortfall"]
    Decide -- "Research substitutes" --> Router
    Decide -- "Cancel" --> Cancel
    Decide -- "Retain shortfall" --> Finish["finish: budget, sources and optional FX"]
    Shortfall -- "No; stock may be unverified" --> Finish
    Finish --> Done(["Budget and estimates"])
```

Text equivalent: route to playable-deck construction, collectible-collection research or specified-card resolution; clarify and verify identities; check tournament legality and request approval only for playable decks; retrieve baseline prices; select a collection within its product budget using verified exchange rates; check seller stock separately; ask about substitutes only for verified shortfalls; return sourced budgets and explicit limitations. Follow-ups resume the same execution.

### Graph node responsibilities

1. **`router`**: Uses a structured response to choose deck construction/revision, collection research or specified-card resolution.
2. **`deck_builder` / `collection_builder` / `understand`**: Share bounded tool-augmented research for verified card identities, sourced deck lists, user preferences and dated legality evidence. Deck construction must resolve 60 cards before pricing. Collections research distinct collectible printings and a product budget, including older non-tournament cards. Research context omits repeated pricing, image and HTML payloads; complete evidence and streamed summaries/tool calls remain available.
3. **`clarify`**: Persists an interruption with selectable answers when a format, ruleset or card preference materially changes the result; the answer returns through routing.
4. **`validate`**: Checks every card identity and applicable International/Japan Standard/Expanded legality. Collections retain identity checks but do not require tournament eligibility.
5. **`review`**: Requires explicit deck approval before pricing. Requested revisions return through routing and require a new approval.
6. **`card_search`**: Retrieves TCGplayer and Cardmarket price-guide references through TCGdex, without inventory assumptions. Market/trend values are preferred to individual low-price references when available.
7. **`collection_budget`**: For collections only, ranks the researched candidates using the catalog art preference and selects affordable printings from verified price guides with dated FX. It enforces the requested product-subtotal cap, never invents a missing price or exchange rate, and lists excluded candidates. Unknown shipping/taxes are outside the cap and remain explicit.
8. **`quote`**: Independently checks seller listings through the configured Apify adapters, retaining exact variants, stock, product links and source diagnostics. The current testing configuration disables live scraping; baseline pricing still runs.
9. **`missing`**: Allocates actual seller inventory once across requested variants, and distinguishes verified listing shortfalls from unverified availability. Empty, disabled, blocked or failed retrieval never proves no stock.
10. **`decide`**: Asks for explicit substitute research, retention of the listed shortfall, or cancellation. Follow-ups remain in the same saved execution.
11. **`finish`**: Returns supplier budgets, separate reference estimates, limitations and source links; optionally converts display currency. Unknown shipping and unverified stock never become a confirmed purchase total.

---

## MCPs and tools per agent

The agent orchestration utilizes a combination of **Model Context Protocol (MCP)** servers, GraphQL APIs, and specialized programmatic tools:

| Tool / MCP Name | Type / Source | Agent Node | Description & Capabilities |
|---|---|---|---|
| **`search_web`** | MCP Tool (`ddg-mcp`) | `understand` | Free public web search via DuckDuckGo MCP server over Streamable HTTP. SSRF-guarded to prevent local network traversal. |
| **`fetch_public_page`** | MCP Tool (`ddg-mcp`) | `understand` | Fetches and parses public HTTPS pages (port 443 only) into clean markdown for tournament standings or card documentation. |
| **`query_tcgdex_graphql`** | Programmatic / GraphQL | `understand`, `validate` | Direct GraphQL queries to TCGdex (`https://api.tcgdex.net/v2/graphql`) in English and Japanese for card metadata, sets, and regulation marks. |
| **`search_cards`** | Programmatic / GraphQL | `understand` | Finds card printings and variants across English (`en`) and Japanese (`ja`) localizations. |
| **`get_card` / `get_cards`** | Programmatic / GraphQL | `understand`, `validate` | High-performance batched card verification (up to 60 distinct card IDs in a single call) to fetch official images, rarity, and local set IDs. |
| **`query_legality`** | Programmatic / PostgreSQL | `validate` | Queries the local PostgreSQL catalog for legal sets, banned cards, and regulation marks across International and Japanese Standard/Expanded formats. |
| **`current_legality`** | Programmatic / Cache | `understand` | Retrieves dated official legality rules and ban lists from the persistent database snapshot. |
| **`search_deck_lists`** | Programmatic / HTTP | `understand` | Searches Limitless TCG tournament records for competitive archetypes, deck codes, and tournament deck lists. |
| **`get_deck_list`** | Programmatic / HTTP | `understand` | Fetches complete 60-card tournament deck lists from Limitless TCG, automatically mapping tournament set abbreviations to TCGdex IDs. |
| **`check_supplier_stock` (TCGplayer)** | Programmatic / Apify | `quote` | Queries logged-out public marketplace listings (`crawloop/tcgplayer-listings-scraper`) for live prices, seller stock, condition, and shipping. |
| **`check_supplier_stock` (Cardmarket)** | Programmatic / Apify | `quote` | Queries logged-out public Cardmarket listings (`phantom_coder/cardmarket-listings-scraper`) using exact researched product URLs. |
| **`baseline_prices`** | Programmatic / TCGdex | `card_search` | Retrieves separate TCGplayer and Cardmarket price-guide references, never seller stock. |
| **`convert_currency`** | Programmatic / REST API | `finish` | Keyless real-time currency conversion via ExchangeRate-API open endpoint with minor-unit rounding and 24-hour local caching. |

Retrieval events and the final budget retain the source layer, stage, outcome, HTTP status when available, retrieval time and a safe diagnostic message. MCP transport errors, webpage challenges, Apify failures and disabled searches are distinguished from actual listing evidence; raw credentials and response bodies are excluded. `APIFY_LIVE_SCRAPE=false` currently leaves seller availability unverified.

### Web Search MCP server (`ddg-mcp`)

The DuckDuckGo MCP server runs as a separate stateless service (`services.ddg_mcp.main`) within the private network:
- Exposed via **Streamable HTTP** at `/mcp`.
- Guarded by a shared bearer token (`MCP_AUTH_TOKEN`).
- Implements strict Server-Side Request Forgery (SSRF) protection (`public_https`), refusing private subnets, localhost, and non-443 ports.
- Provides zero-cost web exploration without relying on proprietary search APIs.
- Uses ordinary HTTPX retrieval only; blocked access is reported without browser/TLS impersonation retries. Marketplace planning lookups are deferred to the dedicated supplier stage.

---

## Architecture diagram

The system employs a defense-in-depth, microservice-based architecture deployed across private networks, managed through Nginx / Heroku routers, and fronted by Cloudflare Pages:

```mermaid
flowchart LR
    subgraph Clients["Client Layer (Cloudflare Pages)"]
        ChatUI["Chat Portal<br/>(React 18 + Cloudscape)"]
        AdminUI["Admin Portal<br/>(React 18 + Cloudscape)"]
    end

    subgraph GatewayLayer["Ingress & Gateway"]
        Gateway["Nginx Reverse Proxy<br/>(:8080 / Heroku Router)"]
    end

    subgraph BackendServices["Backend Microservices (Python 3.11+ / FastAPI / Starlette)"]
        AuthSvc["Auth Service (:8000)<br/>• Argon2id password hashing<br/>• WebAuthn (FIDO2) & TOTP (pyotp)<br/>• RS256 JWT & sliding session cap<br/>• Portal session cookie management"]
        AdminSvc["Admin API (:8000)<br/>• Model catalog activation<br/>• Role policies & token quotas<br/>• Execution & thread audit logs"]
        OrchSvc["Orchestrator (:8000)<br/>• LangGraph DeckAgent engine<br/>• SSE event streaming<br/>• HITL decision resumption<br/>• FX currency conversion"]
        DDGMCP["DDG MCP Service (:8000)<br/>• Streamable HTTP /mcp<br/>• SSRF-guarded web search & fetch"]
    end

    subgraph StorageLayer["Persistence (PostgreSQL 16)"]
        DB[(PostgreSQL Database<br/>Schema: pokemon_tcg_poc<br/>• accounts & authenticators<br/>• iam_roles, api_principals & api_tokens<br/>• daily_token_usage<br/>• graph_checkpoints & audit_logs<br/>• legality_sets & legality_bans)]
    end

    subgraph ExternalServices["External APIs & Suppliers"]
        LLMs["Model Providers<br/>• OpenAI (gpt-6-luna, gpt-6.1-terra)<br/>• Mistral (mistral-medium-latest)"]
        Marketplaces["Marketplace Scrapers (Apify)<br/>• TCGplayer listings<br/>• Cardmarket listings"]
        CardData["Card & Tournament Data<br/>• TCGdex GraphQL API<br/>• Limitless TCG decks"]
        FXRate["ExchangeRate-API<br/>• Free open currency rates"]
    end

    ChatUI -->|HTTP / SSE| Gateway
    AdminUI -->|HTTP| Gateway

    Gateway -->|/api/auth/*| AuthSvc
    Gateway -->|/api/admin/*| AdminSvc
    Gateway -->|/api/chat/*| OrchSvc

    AuthSvc -->|least-privilege connection| DB
    AdminSvc -->|least-privilege connection| DB
    OrchSvc -->|least-privilege connection| DB

    OrchSvc -->|Internal HTTP + Bearer Token| DDGMCP
    OrchSvc -->|Internal auth check| AuthSvc
    AdminSvc -->|Internal auth check| AuthSvc

    OrchSvc -->|Inference| LLMs
    OrchSvc -->|Price Scraping| Marketplaces
    OrchSvc -->|Metadata & Lists| CardData
    OrchSvc -->|Exchange Rates| FXRate
    DDGMCP -->|Outbound Web| CardData

    classDef frontend fill:#e1efff,stroke:#3976b7,color:#102a43;
    classDef gateway fill:#ede7f6,stroke:#5e35b1,color:#102a43;
    classDef service fill:#d8f3e9,stroke:#258368,color:#102a43;
    classDef store fill:#fff0d6,stroke:#a67522,color:#102a43;
    classDef external fill:#f5f5f5,stroke:#616161,color:#212121;

    class ChatUI,AdminUI frontend;
    class Gateway gateway;
    class AuthSvc,AdminSvc,OrchSvc,DDGMCP service;
    class DB store;
    class LLMs,Marketplaces,CardData,FXRate external;
```

### Key architectural highlights

1. **Strict Schema Isolation**: The application connects to a shared PostgreSQL cluster but operates solely within the `pokemon_tcg_poc` schema. Three restricted database roles (`pokemon_poc_auth`, `pokemon_poc_admin`, `pokemon_poc_orchestrator`) hold explicit, minimal permissions. Cross-schema access is blocked.
2. **Enterprise Authentication & 2FA**: Passwords are saved with Argon2id hashes. Second-factor authentication is mandatory via TOTP or FIDO2/WebAuthn passkeys. Sessions use asymmetric RS256 JWTs with a strict sliding-session cap (`MAX_SESSION_HOURS`) and seamless cross-portal session restoration via `SameSite=Strict`, `HttpOnly` cookies.
3. **Token Accounting & Quotas**: Provider-reported input/output usage is tracked independently for each human account and API principal. All of a principal’s credentials share its counter. Hierarchical role quotas reset at midnight Japan time; an admitted response may finish beyond the balance. Quotas limit expenditure and do not guarantee prompt-injection prevention.
4. **Resilient Human-in-the-Loop Orchestration**: State checkpoints are stored in `pokemon_tcg_poc.graph_checkpoints`. The agent pauses when asking questions or presenting deck reviews, freeing resources until the user submits a decision.
5. **Native Cloudscape UX**: Both the Chat Portal and Admin Portal are crafted with AWS's Cloudscape Design System, providing responsive data tables, modal review panels, reasoning disclosure traces, and dark/light mode theming.

### Custom IAM and programmatic testing

See [IAM roles and managed API tokens](docs/security/iam.md) for inherited policies, explicit Deny, per-principal quotas, the admin token flow, CLI usage and the additive migration.

### API-token chat test client (`/api-test/`)

The standalone frontend route `/api-test/` ([`frontend/api-test/index.html`](frontend/api-test/index.html)) provides a dedicated Cloudscape test harness for API principals (`tcg_api_...` tokens) without altering the human chat portal (`/`) or admin portal (`/admin/`).

- **Local development**: With the API gateway running on `http://127.0.0.1:8080`, start the Vite dev server on port `5176`:
  ```bash
  npm --prefix frontend run dev -- --host 127.0.0.1 --port 5176 --strictPort
  ```
  Then open `http://127.0.0.1:5176/api-test/`.
- **Strict in-memory isolation**: Connects via `GET /api/auth/session` using `Authorization: Bearer <token>` and `credentials: 'omit'`. Rejects human sessions (`principal_type !== 'api'`), never uses `/api/auth/portal-session` cookies or token-refresh callbacks, and holds the token in React component memory only (never `localStorage`, `sessionStorage`, `IndexedDB`, cookies, URLs, logs, exports, or screenshots).
- **Local disconnect semantics**: Clicking **Disconnect** aborts active browser streams and requests, clears principal state, and unmounts the workspace locally without calling `/api/auth/logout` or revoking the server-side API token. Stopping an active execution halts SSE consumption in the browser; server-side cancellation relies on connection teardown.
- **Minimum useful `agent:*` permissions**:
  - Core interactive chat: `agent:models:list`, `agent:models:invoke`, `agent:executions:create`, and (when answering clarification or deck approval prompts) `agent:executions:resume`.
  - Optional permissions that degrade cleanly when absent or denied (`403`): `agent:usage:read`, `agent:conversations:read`, `agent:conversations:write`, `agent:conversations:delete`, `agent:executions:read`, `agent:preferences:read`, and `agent:preferences:write`.
- **Principal ownership**: Usage counters, saved conversations, execution snapshots, and **Agent preferences** read and mutated in `/api-test/` belong to the authenticated API principal, not a human operator account.
- **Automated test scope**: Frontend automated checks validate the `/api-test/` route using synthetic tokens and mocked SSE/API responses without invoking live billable LLM providers.
