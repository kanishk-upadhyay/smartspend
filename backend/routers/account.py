import json

from fastapi import APIRouter, Request, HTTPException, Depends
from sqlalchemy.orm import Session

from database import Expense, AccountSettings
from schemas import AccountSettingsResponse, AccountSettingsUpdate
import deps
from deps import (
    get_db,
    _settings_payload,
    _normalize_theme,
    _normalize_categories,
    _sync_supabase_user_metadata,
)

router = APIRouter()


@router.get("/account-settings", response_model=AccountSettingsResponse)
def get_account_settings(request: Request, db: Session = Depends(get_db)):
    owner_id, _, auth_user = deps._resolve_identity(request)
    settings = db.query(AccountSettings).filter(AccountSettings.owner_id == owner_id).first()
    if settings is None:
        metadata = (auth_user or {}).get("user_metadata", {})
        settings = AccountSettings(
            owner_id=owner_id,
            display_name=metadata.get("display_name"),
            email=(auth_user or {}).get("email"),
            avatar_url=metadata.get("avatar_url"),
            currency=metadata.get("currency") or "INR",
            theme=metadata.get("theme") or "system",
            custom_categories_json=json.dumps(metadata.get("custom_categories") or []),
        )
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return _settings_payload(settings)


@router.put("/account-settings", response_model=AccountSettingsResponse)
def update_account_settings(request: Request, payload: AccountSettingsUpdate, db: Session = Depends(get_db)):
    owner_id, identity_type, auth_user = deps._resolve_identity(request)
    settings = db.query(AccountSettings).filter(AccountSettings.owner_id == owner_id).first()
    if settings is None:
        settings = AccountSettings(owner_id=owner_id)
        db.add(settings)

    update_data = payload.model_dump(exclude_unset=True)
    if "display_name" in update_data:
        settings.display_name = update_data["display_name"]
    if "email" in update_data:
        settings.email = update_data["email"]
    if "avatar_url" in update_data:
        settings.avatar_url = update_data["avatar_url"]
    if "currency" in update_data and update_data["currency"]:
        settings.currency = update_data["currency"]
    if "theme" in update_data:
        settings.theme = _normalize_theme(update_data["theme"])
    if "custom_categories" in update_data:
        settings.custom_categories_json = json.dumps(_normalize_categories(update_data["custom_categories"]))
    elif settings.custom_categories_json is None:
        settings.custom_categories_json = json.dumps([])

    db.commit()
    db.refresh(settings)
    if identity_type == "auth":
        _sync_supabase_user_metadata(owner_id, settings)
    return _settings_payload(settings)


@router.post("/account-migrate-guest", response_model=AccountSettingsResponse)
def migrate_guest_account(request: Request, db: Session = Depends(get_db)):
    owner_id, identity_type, auth_user = deps._resolve_identity(request)
    guest_id = request.headers.get("x-smartspend-guest-id", "").strip()
    if not guest_id:
        raise HTTPException(status_code=400, detail="Guest id required for migration")
    # Same namespacing invariant as _resolve_identity: only "guest-"-prefixed ids
    # are real guest sessions, so migration can only ever move guest-owned rows,
    # never another auth user's data.
    if not guest_id.startswith("guest-"):
        raise HTTPException(status_code=400, detail="Invalid guest session.")
    if owner_id == guest_id:
        raise HTTPException(status_code=400, detail="Guest and account identity must differ for migration")
    if identity_type != "auth":
        raise HTTPException(status_code=401, detail="Sign in required for guest migration")

    guest_settings = db.query(AccountSettings).filter(AccountSettings.owner_id == guest_id).first()
    account_settings = db.query(AccountSettings).filter(AccountSettings.owner_id == owner_id).first()
    migrated = db.query(Expense).filter(Expense.owner_id == guest_id).update({"owner_id": owner_id})

    # The frontend POSTs this on every settings load, so on the common no-op
    # path (no guest rows, no guest settings) nothing actually changes and we
    # must skip the wasteful Supabase admin write below.
    changed = bool(migrated)

    if account_settings is None:
        account_settings = AccountSettings(owner_id=owner_id)
        db.add(account_settings)

    if guest_settings is not None:
        changed = True
        if not account_settings.display_name:
            account_settings.display_name = guest_settings.display_name
        if not account_settings.email:
            account_settings.email = guest_settings.email or (auth_user or {}).get("email")
        if not account_settings.avatar_url:
            account_settings.avatar_url = guest_settings.avatar_url
        if not account_settings.currency:
            account_settings.currency = guest_settings.currency or "INR"
        if not account_settings.theme:
            account_settings.theme = guest_settings.theme or "system"
        if not account_settings.custom_categories_json:
            account_settings.custom_categories_json = guest_settings.custom_categories_json
        db.delete(guest_settings)

    db.commit()
    db.refresh(account_settings)
    if changed:
        _sync_supabase_user_metadata(owner_id, account_settings)
    return _settings_payload(account_settings)
