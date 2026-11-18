import json
import secrets
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import deps
from database import AccountSettings, Expense, Space, SpaceMember
from deps import (
    _attach_items,
    _normalize_image_path,
    _validate_image_path,
    get_db,
)
from schemas import (
    ExpenseBase,
    ExpenseResponse,
    SpaceBalanceItem,
    SpaceCreate,
    SpaceExpensesResponse,
    SpaceJoinRequest,
    SpaceMemberResponse,
    SpaceResponse,
)

router = APIRouter()

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _generate_join_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(6))


def _generate_slug() -> str:
    return f"spc_{uuid4().hex[:12]}"


def _get_display_name(db: Session, owner_id: str, auth_user: dict | None = None) -> str:
    settings = db.query(AccountSettings).filter(AccountSettings.owner_id == owner_id).first()
    if settings and settings.display_name:
        return settings.display_name
    if auth_user and auth_user.get("user_metadata", {}).get("display_name"):
        return auth_user["user_metadata"]["display_name"]
    if auth_user and auth_user.get("email"):
        return auth_user["email"].split("@")[0]
    if owner_id.startswith("guest-"):
        return f"Guest-{owner_id[6:10]}"
    return f"User-{owner_id[:6]}"


def _build_space_response(space: Space, db: Session, include_members: bool = False) -> SpaceResponse:
    members = db.query(SpaceMember).filter(SpaceMember.space_id == space.id).all()
    expenses = db.query(Expense).filter(Expense.space_id == space.id).all()
    total_spend = sum(float(e.total_amount or 0.0) for e in expenses)

    member_models = None
    if include_members:
        member_models = [
            SpaceMemberResponse(
                member_id=m.member_id,
                display_name=m.display_name,
                role=m.role or "member",
                joined_at=m.joined_at,
            )
            for m in members
        ]

    return SpaceResponse(
        id=space.id,
        name=space.name,
        slug=space.slug,
        join_code=space.join_code,
        base_currency=space.base_currency or "INR",
        created_by=space.created_by,
        member_count=len(members),
        total_spend=round(total_spend, 2),
        members=member_models,
    )


@router.post("/spaces", response_model=SpaceResponse)
def create_space(request: Request, payload: SpaceCreate, db: Session = Depends(get_db)):
    owner_id, _, auth_user = deps._resolve_identity(request)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Space name cannot be empty")

    base_currency = (payload.base_currency or "INR").upper().strip()

    # Generate unique join code and slug
    for _ in range(5):
        join_code = _generate_join_code()
        if not db.query(Space).filter(Space.join_code == join_code).first():
            break
    else:
        join_code = f"S{uuid4().hex[:5].upper()}"

    slug = _generate_slug()
    now_iso = datetime.now(UTC).isoformat()

    space = Space(
        name=name,
        slug=slug,
        join_code=join_code,
        base_currency=base_currency,
        created_by=owner_id,
        created_at=now_iso,
    )
    db.add(space)
    db.commit()
    db.refresh(space)

    # Add creator as first member with creator role
    display_name = _get_display_name(db, owner_id, auth_user)
    member = SpaceMember(
        space_id=space.id,
        member_id=owner_id,
        display_name=display_name,
        role="creator",
        joined_at=now_iso,
    )
    db.add(member)
    db.commit()

    return _build_space_response(space, db, include_members=True)


@router.get("/spaces", response_model=list[SpaceResponse])
def list_spaces(request: Request, db: Session = Depends(get_db)):
    owner_id, _, _ = deps._resolve_identity(request)
    memberships = db.query(SpaceMember).filter(SpaceMember.member_id == owner_id).all()
    space_ids = [m.space_id for m in memberships]
    if not space_ids:
        return []

    spaces = db.query(Space).filter(Space.id.in_(space_ids)).all()
    return [_build_space_response(s, db) for s in spaces]


@router.post("/spaces/join", response_model=SpaceResponse)
def join_space(request: Request, payload: SpaceJoinRequest, db: Session = Depends(get_db)):
    owner_id, _, auth_user = deps._resolve_identity(request)
    code_or_slug = payload.code_or_slug.strip()
    if not code_or_slug:
        raise HTTPException(status_code=400, detail="Join code or link slug required")

    space = (
        db.query(Space)
        .filter((Space.join_code == code_or_slug.upper()) | (Space.slug == code_or_slug))
        .first()
    )
    if not space:
        raise HTTPException(status_code=404, detail="Space not found. Check join code or link.")

    # Idempotent: check if already member
    existing = (
        db.query(SpaceMember)
        .filter(SpaceMember.space_id == space.id, SpaceMember.member_id == owner_id)
        .first()
    )
    if existing:
        return _build_space_response(space, db, include_members=True)

    display_name = payload.display_name or _get_display_name(db, owner_id, auth_user)
    member = SpaceMember(
        space_id=space.id,
        member_id=owner_id,
        display_name=display_name,
        role="member",
        joined_at=datetime.now(UTC).isoformat(),
    )
    db.add(member)
    db.commit()

    return _build_space_response(space, db, include_members=True)


@router.get("/spaces/{space_id}", response_model=SpaceResponse)
def get_space(space_id: int, request: Request, db: Session = Depends(get_db)):
    owner_id, _, _ = deps._resolve_identity(request)
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")

    is_member = (
        db.query(SpaceMember)
        .filter(SpaceMember.space_id == space.id, SpaceMember.member_id == owner_id)
        .first()
    )
    if not is_member and space.created_by != owner_id:
        raise HTTPException(status_code=403, detail="You are not a member of this space")

    return _build_space_response(space, db, include_members=True)


@router.get("/spaces/{space_id}/expenses", response_model=SpaceExpensesResponse)
def get_space_expenses(space_id: int, request: Request, db: Session = Depends(get_db)):
    owner_id, _, _ = deps._resolve_identity(request)
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")

    is_member = (
        db.query(SpaceMember)
        .filter(SpaceMember.space_id == space.id, SpaceMember.member_id == owner_id)
        .first()
    )
    if not is_member and space.created_by != owner_id:
        raise HTTPException(status_code=403, detail="You are not a member of this space")

    members = db.query(SpaceMember).filter(SpaceMember.space_id == space.id).all()
    expenses = (
        db.query(Expense)
        .filter(Expense.space_id == space.id)
        .order_by(Expense.id.asc())
        .all()
    )
    for exp in expenses:
        _attach_items(exp)

    # Balance calculation
    member_paid = {m.member_id: 0.0 for m in members}
    total_spend = 0.0

    for exp in expenses:
        amt = float(exp.total_amount or 0.0)
        payer_id = exp.owner_id
        if payer_id in member_paid:
            member_paid[payer_id] += amt
        else:
            member_paid[payer_id] = member_paid.get(payer_id, 0.0) + amt
        total_spend += amt

    member_count = max(len(members), 1)
    fair_share = total_spend / member_count

    balances = [
        SpaceBalanceItem(
            member_id=m.member_id,
            display_name=m.display_name,
            paid_amount=round(member_paid.get(m.member_id, 0.0), 2),
            net_balance=round(member_paid.get(m.member_id, 0.0) - fair_share, 2),
        )
        for m in members
    ]

    return SpaceExpensesResponse(
        space=_build_space_response(space, db, include_members=True),
        expenses=expenses,
        balances=balances,
    )


@router.post("/spaces/{space_id}/expenses", response_model=ExpenseResponse)
def add_expense_to_space(
    space_id: int, request: Request, expense: ExpenseBase, db: Session = Depends(get_db)
):
    owner_id, _, auth_user = deps._resolve_identity(request)
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")

    membership = (
        db.query(SpaceMember)
        .filter(SpaceMember.space_id == space.id, SpaceMember.member_id == owner_id)
        .first()
    )
    if not membership and space.created_by != owner_id:
        raise HTTPException(status_code=403, detail="You are not a member of this space")

    payer_name = getattr(expense, "payer_name", None) or (
        membership.display_name if membership else _get_display_name(db, owner_id, auth_user)
    )

    if expense.image_path:
        expense.image_path = _normalize_image_path(expense.image_path)
        _validate_image_path(expense.image_path)

    payload = expense.model_dump(exclude={"items", "split_data"})
    payload["owner_id"] = owner_id
    payload["space_id"] = space.id
    payload["payer_name"] = payer_name
    if getattr(expense, "split_data", None):
        payload["split_data_json"] = json.dumps(expense.split_data)

    db_expense = Expense(**payload)
    db_expense.items_json = json.dumps(expense.items or [])
    db.add(db_expense)
    db.commit()
    db.refresh(db_expense)
    _attach_items(db_expense)
    return db_expense


@router.delete("/spaces/{space_id}")
def delete_space(space_id: int, request: Request, db: Session = Depends(get_db)):
    owner_id, _, _ = deps._resolve_identity(request)
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")

    if space.created_by != owner_id:
        raise HTTPException(status_code=403, detail="Only the space creator can delete this space")

    # Detach space expenses rather than hard-deleting them so personal ledger stays safe
    db.query(Expense).filter(Expense.space_id == space.id).update({"space_id": None})
    db.query(SpaceMember).filter(SpaceMember.space_id == space.id).delete()
    db.delete(space)
    db.commit()

    return {"id": space_id, "deleted": True}
