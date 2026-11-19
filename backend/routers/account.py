import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import deps
from database import AccountSettings, Expense, Space, SpaceMember
from deps import (
    _normalize_categories,
    _normalize_theme,
    _settings_payload,
    get_db,
)
from schemas import AccountSettingsResponse, AccountSettingsUpdate

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
    if update_data.get("currency"):
        settings.currency = update_data["currency"]
    if "theme" in update_data:
        settings.theme = _normalize_theme(update_data["theme"])
    if "custom_categories" in update_data:
        settings.custom_categories_json = json.dumps(_normalize_categories(update_data["custom_categories"]))
    elif settings.custom_categories_json is None:
        settings.custom_categories_json = json.dumps([])

    db.commit()
    db.refresh(settings)
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

    # Expenses: transfer owner_id. If an expense row already exists for owner_id with the same image_path,
    # avoid violating ux_expenses_owner_image_path by deleting the duplicate guest row.
    existing_images = {
        row[0]
        for row in db.query(Expense.image_path)
        .filter(Expense.owner_id == owner_id, Expense.image_path.isnot(None), Expense.image_path != "")
        .all()
    }
    guest_expenses = db.query(Expense).filter(Expense.owner_id == guest_id).all()
    for exp in guest_expenses:
        if exp.image_path and exp.image_path in existing_images:
            # If guest expense was attached to a space and the existing auth expense wasn't,
            # preserve the space linkage on the existing auth expense before removing the duplicate.
            if exp.space_id:
                existing_exp = (
                    db.query(Expense).filter(Expense.owner_id == owner_id, Expense.image_path == exp.image_path).first()
                )
                if existing_exp and existing_exp.space_id is None:
                    existing_exp.space_id = exp.space_id
                    existing_exp.payer_name = exp.payer_name
            db.delete(exp)
        else:
            exp.owner_id = owner_id

    # Spaces created by guest: transfer to owner_id
    db.query(Space).filter(Space.created_by == guest_id).update({"created_by": owner_id})

    # Space memberships: if owner_id is already a member of a space that guest_id was in,
    # delete the guest membership to prevent UNIQUE constraint violation on (space_id, member_id).
    existing_spaces = {row[0] for row in db.query(SpaceMember.space_id).filter(SpaceMember.member_id == owner_id).all()}
    guest_memberships = db.query(SpaceMember).filter(SpaceMember.member_id == guest_id).all()
    for gm in guest_memberships:
        if gm.space_id in existing_spaces:
            if gm.role == "creator":
                db.query(SpaceMember).filter(
                    SpaceMember.space_id == gm.space_id,
                    SpaceMember.member_id == owner_id,
                ).update({"role": "creator"})
            db.delete(gm)
        else:
            gm.member_id = owner_id

    if account_settings is None:
        account_settings = AccountSettings(owner_id=owner_id)
        db.add(account_settings)

    if guest_settings is not None:
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
    return _settings_payload(account_settings)
