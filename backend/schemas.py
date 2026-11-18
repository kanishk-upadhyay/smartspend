from typing import Optional

from pydantic import BaseModel, ConfigDict


# Pydantic models
class ExpenseBase(BaseModel):
    vendor: str
    total_amount: float
    date: str
    category: str = "General"
    currency: str = "INR"
    source_currency: str = "INR"
    raw_total_amount: Optional[float] = None
    receipt_date: Optional[str] = None
    fx_rate_date: Optional[str] = None
    currency_warning: Optional[str] = None
    item_warning: Optional[str] = None
    items: Optional[list] = None
    image_path: Optional[str] = None
    space_id: Optional[int] = None
    payer_name: Optional[str] = None
    split_type: Optional[str] = "equal"
    split_data: Optional[dict] = None

class ExpenseResponse(ExpenseBase):
    id: int
    owner_id: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)

class ExpenseUpdate(BaseModel):
    vendor: Optional[str] = None
    total_amount: Optional[float] = None
    date: Optional[str] = None
    category: Optional[str] = None
    currency: Optional[str] = None
    source_currency: Optional[str] = None
    raw_total_amount: Optional[float] = None
    receipt_date: Optional[str] = None
    fx_rate_date: Optional[str] = None
    currency_warning: Optional[str] = None
    item_warning: Optional[str] = None
    items: Optional[list] = None
    image_path: Optional[str] = None
    space_id: Optional[int] = None
    payer_name: Optional[str] = None
    split_type: Optional[str] = None
    split_data: Optional[dict] = None


class UploadRequest(BaseModel):
    filename: str
    content_type: Optional[str] = None
    data_base64: str


class AccountSettingsBase(BaseModel):
    display_name: Optional[str] = None
    email: Optional[str] = None
    avatar_url: Optional[str] = None
    currency: str = "INR"
    theme: str = "system"
    custom_categories: Optional[list[str]] = None


class AccountSettingsResponse(AccountSettingsBase):
    id: int
    owner_id: str
    model_config = ConfigDict(from_attributes=True)


class AccountSettingsUpdate(BaseModel):
    display_name: Optional[str] = None
    email: Optional[str] = None
    avatar_url: Optional[str] = None
    currency: Optional[str] = None
    theme: Optional[str] = None
    custom_categories: Optional[list[str]] = None


# Space / Shared Circles Models
class SpaceCreate(BaseModel):
    name: str
    base_currency: str = "INR"


class SpaceMemberResponse(BaseModel):
    member_id: str
    display_name: str
    role: str
    joined_at: Optional[str] = None
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
    members: Optional[list[SpaceMemberResponse]] = None
    model_config = ConfigDict(from_attributes=True)


class SpaceJoinRequest(BaseModel):
    code_or_slug: str
    display_name: Optional[str] = None


class SpaceBalanceItem(BaseModel):
    member_id: str
    display_name: str
    paid_amount: float
    net_balance: float


class SpaceExpensesResponse(BaseModel):
    space: SpaceResponse
    expenses: list[ExpenseResponse]
    balances: list[SpaceBalanceItem]
