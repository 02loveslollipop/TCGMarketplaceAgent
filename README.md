# Pokémon TCG Marketplace Agent

An autonomous multi-agent purchasing and deck-building assistant built with **LangGraph**, **LangChain**, and the **Cloudscape Design System**. The system accepts natural language requests for Pokémon Trading Card Game singles and tournament decks, validates card identities and dated format legality, compares real-time marketplace quotations from TCGplayer and Cardmarket, and produces verifiable purchasing budgets with multi-currency conversion.

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
    Start(["Start Request"]) --> Understand["understand<br/>• Resolve card identities via TCGdex<br/>• Extract format/deck requirements<br/>• Retrieve dated legality snapshot"]

    Understand --> ClarifyCond{"Needs clarification?"}
    ClarifyCond -- "Ambiguous variant / format" --> Clarify["clarify (HITL Interrupt)<br/>Prompt user with selectable options"]
    Clarify -- "User response" --> Understand
    Clarify -- "Cancel" --> EndCancel(["Cancelled"])

    ClarifyCond -- "Resolved" --> Validate["validate<br/>• Check Standard / Expanded legality<br/>• Check International / Japan ruleset<br/>• Verify regulation marks & bans"]

    Validate --> DeckCond{"Is 60-card deck?"}
    DeckCond -- "Yes" --> Review["review (HITL Interrupt)<br/>Present full deck for user review"]
    Review -- "Approve deck" --> Quote["quote<br/>• Async query TCGplayer listings<br/>• Async query Cardmarket listings<br/>• Bounded concurrency (semaphore)"]
    Review -- "Request changes" --> Understand
    Review -- "Cancel" --> EndCancel

    DeckCond -- "No (Singles)" --> Quote

    Quote --> Missing["missing<br/>• Allocate stock & calculate subtotals<br/>• Identify unquoted / missing cards<br/>• Generate researched alternatives"]

    Missing --> MissingCond{"Missing cards found?"}
    MissingCond -- "Yes" --> Decide["decide (HITL Interrupt)<br/>Prompt user for missing cards consent<br/>or alternative substitutions"]
    Decide -- "Substitute" --> Understand
    Decide -- "Keep missing" --> Finish["finish<br/>• Compile supplier budgets<br/>• Format verifiable source citations<br/>• Optional FX currency conversion"]
    Decide -- "Cancel" --> EndCancel

    MissingCond -- "No" --> Finish

    Finish --> EndDone(["Complete Budget & Plan"])

    classDef stage fill:#e1efff,stroke:#3976b7,stroke-width:1.5px,color:#102a43;
    classDef interrupt fill:#fff0d6,stroke:#a67522,stroke-width:2px,color:#102a43;
    classDef stop fill:#fbeae5,stroke:#cf3721,stroke-width:1.5px,color:#102a43;
    classDef done fill:#d8f3e9,stroke:#258368,stroke-width:1.5px,color:#102a43;

    class Understand,Validate,Quote,Missing stage;
    class Clarify,Review,Decide interrupt;
    class EndCancel stop;
    class Finish,EndDone done;
```

### Graph node responsibilities

1. **`understand`**: Performs tool-augmented reasoning via the LLM (OpenAI GPT or Mistral) to interpret the user's intent. Queries TCGdex GraphQL, searches tournament lists on Limitless TCG, and checks dated legality evidence to assemble the card specification.
2. **`clarify`**: An interactive checkpoint triggered when requirements are ambiguous (e.g., distinguishing *Standard (Mega Lucario ex - MEG)* from *Expanded (M Lucario-EX - FFI)*). Pauses execution and returns structured options to the user.
3. **`validate`**: Performs deterministic ruleset verification against the PostgreSQL catalog, verifying regulation marks (e.g. G, H), set codes, and active ban lists for International and Japanese formats.
4. **`review`**: Human-in-the-loop deck gate before initiating marketplace pricing. Presents the 60-card deck composition, archetype identity, and legal status to the user for explicit approval or modification requests.
5. **`quote`**: Executes bounded concurrent queries against TCGplayer and Cardmarket scrapers/APIs via an asynchronous semaphore, retrieving condition, language, unit price, quantity, and seller metadata.
6. **`missing`**: Compiles preliminary purchase budgets, isolates cards with insufficient seller inventory or unmatched variants, and requests alternative card suggestions.
7. **`decide`**: Interactive checkpoint allowing the user to either approve substituting missing cards or explicitly consent to proceeding with an incomplete quotation.
8. **`finish`**: Generates the final budget tables, confirmed supplier totals, reference estimates, and triggers real-time foreign exchange conversion if a target currency was chosen.

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
| **`quote_supplier` (TCGplayer)** | Programmatic / Apify | `quote` | Queries logged-out public marketplace listings (`crawloop/tcgplayer-listings-scraper`) for live prices, seller stock, condition, and shipping. |
| **`quote_supplier` (Cardmarket)** | Programmatic / Apify | `quote` | Queries logged-out public Cardmarket listings (`phantom_coder/cardmarket-listings-scraper`) using exact researched product URLs. |
| **`convert_currency`** | Programmatic / REST API | `finish` | Keyless real-time currency conversion via ExchangeRate-API open endpoint with minor-unit rounding and 24-hour local caching. |

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
