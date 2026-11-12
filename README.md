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
- **Specific card singles**: *"I need 4 copies of Professor's Research, 2 Boss's Orders, and 4 Ultra Ball for the current Standard format in Near Mint condition."*
- **Multi-currency budget**: *"Prepare a purchasing budget for a Dragapult ex tournament deck with prices converted to EUR."*
- **Format legality verification**: *"Check if Mewtwo & Mew-GX is legal in the current Japanese Standard format."*

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

Execute the full backend test suite (179 unit, integration, and regression tests):

```bash
.venv/bin/pytest -q
```

Execute the frontend test suite (77 tests across Cloudscape chat, admin, and authentication flows):

```bash
npm --prefix frontend test
```

Build the production frontend bundle:

```bash
npm --prefix frontend run build
```

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
    Start(["Start request"]) --> Router["router: deck or specified cards"]
    Router -- "Build or revise deck" --> Builder["deck_builder: sourced deck research"]
    Router -- "Specified cards" --> Understand["understand: resolve card identities"]
    Builder --> Question{"Needs clarification?"}
    Understand --> Question
    Question -- "Yes" --> Clarify["clarify: saved user question"]
    Clarify -- "Answer" --> Router
    Clarify -- "Cancel" --> Cancel(["Cancelled"])
    Question -- "No" --> Validate["validate: identity and format legality"]
    Validate --> Deck{"Deck or 60-card list?"}
    Deck -- "Yes" --> Review["review: approve deck"]
    Review -- "Revise" --> Router
    Review -- "Cancel" --> Cancel
    Review -- "Approve" --> Baseline["card_search: baseline price guides"]
    Deck -- "No" --> Baseline
    Baseline --> Quote["quote: seller stock and product links"]
    Quote --> Missing["missing: allocate stock and classify evidence"]
    Missing --> Shortfall{"Verified listing shortfall?"}
    Shortfall -- "Yes" --> Decide["decide: alternatives or retain shortfall"]
    Decide -- "Research substitutes" --> Router
    Decide -- "Cancel" --> Cancel
    Decide -- "Retain shortfall" --> Finish["finish: budget, sources and optional FX"]
    Shortfall -- "No; stock may be unverified" --> Finish
    Finish --> Done(["Budget and estimates"])
```

Text equivalent: route the request to deck construction or specified-card research; clarify and validate it; obtain deck approval when applicable; retrieve baseline prices; separately check stock and product links; ask about alternatives only for verified listing shortfalls; return the buying budget with source evidence and optional currency conversion. Follow-ups resume the same execution.

### Graph node responsibilities

1. **`router`**: Uses a structured model response to select deck construction/revision or research of already specified cards.
2. **`deck_builder` / `understand`**: Share bounded tool-augmented research for verified card identities, sourced deck lists, user preferences and dated legality evidence. Deck construction must resolve 60 cards before pricing and does not use stock to silently change the deck.
3. **`clarify`**: Persists an interruption with selectable answers when a format, ruleset or card preference materially changes the result; the answer returns through routing.
4. **`validate`**: Checks card identity and applicable International/Japan Standard/Expanded legality against the dated catalog and metadata.
5. **`review`**: Requires explicit deck approval before pricing. Requested revisions return through routing and require a new approval.
6. **`card_search`**: Retrieves TCGplayer and Cardmarket price-guide references through TCGdex, without inventory assumptions. Market/trend values are preferred to individual low-price references when available.
7. **`quote`**: Independently checks seller listings through the configured Apify adapters, retaining exact variants, stock, product links and source diagnostics. The current testing configuration disables live scraping; baseline pricing still runs.
8. **`missing`**: Allocates actual seller inventory once across requested variants, and distinguishes verified listing shortfalls from unverified availability. Empty, disabled, blocked or failed retrieval never proves no stock.
9. **`decide`**: Asks for explicit substitute research, retention of the listed shortfall, or cancellation. Follow-ups remain in the same saved execution.
10. **`finish`**: Returns supplier budgets, separate reference estimates, limitations and source links; optionally converts display currency. Unknown shipping and unverified stock never become a confirmed purchase total.

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
        DB[(PostgreSQL Database<br/>Schema: pokemon_tcg_poc<br/>• accounts & authenticators<br/>• role_policies & daily_token_usage<br/>• graph_checkpoints & audit_logs<br/>• legality_sets & legality_bans)]
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

1. **Strict Schema Isolation**: The application connects to a shared PostgreSQL cluster but operates solely within the `pokemon_tcg_poc` schema. Three restricted database roles (`app_auth`, `app_admin`, `app_orchestrator`) hold explicit, minimal permissions. Cross-schema access is blocked.
2. **Enterprise Authentication & 2FA**: Passwords are saved with Argon2id hashes. Second-factor authentication is mandatory via TOTP or FIDO2/WebAuthn passkeys. Sessions use asymmetric RS256 JWTs with a strict sliding-session cap (`MAX_SESSION_HOURS`) and seamless cross-portal session restoration via `SameSite=Strict`, `HttpOnly` cookies.
3. **Token Accounting & Quotas**: Real-time token usage is tracked per account across all LangChain/LLM calls. Daily token allowances (e.g. 50,000 for Users, 200,000 for Admins) reset at midnight JST, preventing runaway API expenditures.
4. **Resilient Human-in-the-Loop Orchestration**: State checkpoints are stored in `pokemon_tcg_poc.graph_checkpoints`. The agent pauses when asking questions or presenting deck reviews, freeing resources until the user submits a decision.
5. **Native Cloudscape UX**: Both the Chat Portal and Admin Portal are crafted with AWS's Cloudscape Design System, providing responsive data tables, modal review panels, reasoning disclosure traces, and dark/light mode theming.
