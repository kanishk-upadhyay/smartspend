
from pydantic import BaseModel, ConfigDict


# Pydantic models
class ExpenseBase(BaseModel):
    vendor: str
    total_amount: float
    date: str
    category: str = "General"
    currency: str = "INR"
    source_currency: str = "INR"
    raw_total_amount: float | None = None
    receipt_date: str | None = None
    fx_rate_date: str | None = None
    currency_warning: str | None = None
    item_warning: str | None = None
    items: list | None = None
    image_path: str | None = None
    space_id: int | None = None
    payer_name: str | None = None
    split_type: str | None = "equal"
    split_data: dict | None = None

class ExpenseResponse(ExpenseBase):
    id: int
    owner_id: str | None = None
    model_config = ConfigDict(from_attributes=True)

class ExpenseUpdate(BaseModel):
    vendor: str | None = None
    total_amount: float | None = None
    date: str | None = None
    category: str | None = None
    currency: str | None = None
    source_currency: str | None = None
    raw_total_amount: float | None = None
    receipt_date: str | None = None
    fx_rate_date: str | None = None
    currency_warning: str | None = None
    item_warning: str | None = None
    items: list | None = None
    image_path: str | None = None
    space_id: int | None = None
    payer_name: str | None = None
    split_type: str | None = None
    split_data: dict | None = None


class UploadRequest(BaseModel):
    filename: str
    content_type: str | None = None
    data_base64: str


class AccountSettingsBase(BaseModel):
    display_name: str | None = None
    email: str | None = None
    avatar_url: str | None = None
    currency: str = "INR"
    theme: str = "system"
    custom_categories: list[str] | None = None


class AccountSettingsResponse(AccountSettingsBase):
    id: int
    owner_id: str
    model_config = ConfigDict(from_attributes=True)


class AccountSettingsUpdate(BaseModel):
    display_name: str | None = None
    email: str | None = None
    avatar_url: str | None = None
    currency: str | None = None
    theme: str | None = None
    custom_categories: list[str] | None = None


# Space / Shared Circles Models
class SpaceCreate(BaseModel):
    name: str
    base_currency: str = "INR"


class SpaceMemberResponse(BaseModel):
    member_id: str
    display_name: str
    role: str
    joined_at: str | None = None
    model_config = ConfigDict(from_attributes=True)


class SpaceResponse(BaseModel):
    id: int
    name: str
    slug: str
    join_code: str
    base_currency: str
    created_by: str
    member_count: int = 1
    total_spend: float = 0.0
    members: list[SpaceMemberResponse] | None = None
    model_config = ConfigDict(from_attributes=True)


class SpaceJoinRequest(BaseModel):
    code_or_slug: str
    display_name: str | None = None


class SpaceBalanceItem(BaseModel):
    member_id: str
    display_name: str
    paid_amount: float
    net_balance: float


class SpaceExpensesResponse(BaseModel):
    space: SpaceResponse
    expenses: list[ExpenseResponse]
    balances: list[SpaceBalanceItem]
