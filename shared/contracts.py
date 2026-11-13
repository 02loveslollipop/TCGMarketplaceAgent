"""Validated, fixed-shape agent/UI contracts; money never uses binary floats."""
from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator
from shared.image_context import ImageContext


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Source(Contract):
    url: HttpUrl
    retrieved_at: datetime = Field(default_factory=utcnow)
    title: str
    excerpt: str = ""


class CardRequest(Contract):
    card_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    quantity: int = Field(ge=1, le=60)
    set_name: str
    number: str
    condition: str = Field(
        default="Near Mint",
        description="Physical card condition: 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged', or 'any'. Never 'Not applicable'.",
    )
    language: str = Field(
        default="English",
        description="Card language, e.g. 'English' or 'Japanese'.",
    )
    printing: str = Field(
        default="any",
        description="Card foil/finish variant: 'Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', or 'any'. Do NOT put game format ('Standard'/'Expanded') here.",
    )
    image_url: HttpUrl | None = None
    basic_energy: bool = False
    cardmarket_url: HttpUrl | None = None
    cardmarket_identity_source: Source | None = None


class Offer(Contract):
    id: str
    name: str
    supplier: Literal["TCGplayer", "Cardmarket"]
    set_name: str | None = None
    number: str | None = None
    condition: str | None = None
    language: str | None = None
    printing: str | None = None
    image_url: HttpUrl | None = None
    price: Decimal = Field(gt=0, allow_inf_nan=False)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    quantity: int | None = Field(default=None, ge=0)
    availability: Literal["in_stock", "out_of_stock", "unknown"] = "unknown"
    price_kind: Literal["listing", "reference"]
    shipping: Decimal | None = Field(default=None, ge=0, allow_inf_nan=False)
    shipping_confirmed: bool = False
    seller: str | None = None
    source: Source
    identity_source: Source | None = None


class CollectionGoal(Contract):
    subject: str = Field(min_length=1,max_length=160)
    budget_amount: Decimal = Field(gt=0,allow_inf_nan=False)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    prefer_full_art: bool = False
    max_printings: int | None = Field(default=None,ge=1,le=60)
    copies_per_printing: int = Field(default=1,ge=1,le=60)


class AgentPlan(Contract):
    question: str | None = None
    options: list[str] = Field(default_factory=list, max_length=8)
    ruleset: str | None = None
    format: str | None = None
    is_deck: bool = False
    purpose: Literal["cards", "deck", "collection"] = "cards"
    collection: CollectionGoal | None = None
    cards: list[CardRequest] = Field(default_factory=list, max_length=60)
    sources: list[Source] = Field(default_factory=list)
    explanation: str = ""


class Legality(Contract):
    status: Literal["verified", "unverified"]
    issues: list[str] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    applicable: bool = True


class Decision(Contract):
    action: Literal["clarify", "approve_deck", "revise_deck", "substitute", "keep_missing", "cancel"]
    text: str = Field(default="", max_length=8000)
    selected_option: str | None = None
    approved: bool = False


class UserPreferencesPayload(Contract):
    ruleset: Literal["auto", "international", "japan"] = "auto"
    format: Literal["auto", "standard", "expanded"] = "auto"
    location: str = Field(default="", max_length=160)
    target_currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")


class ConversationRenamePayload(Contract):
    title: str = Field(min_length=1, max_length=160)


class ChatInput(Contract):
    text: str = Field(default="", max_length=8000)
    images: list[ImageContext] = Field(default_factory=list, max_length=3)
    model_id: str
    conversation_id: str | None = None

    @model_validator(mode="after")
    def require_context(self):
        if not self.text.strip() and not self.images:
            raise ValueError("A request or image context is required.")
        return self


class StreamEvent(Contract):
    type: Literal["progress", "cards", "question", "result", "error", "done", "execution", "thinking", "tool"]
    data: dict

