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

class ExpenseResponse(ExpenseBase):
    id: int
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
