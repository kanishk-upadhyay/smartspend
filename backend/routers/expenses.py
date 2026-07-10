import os
import json
from datetime import datetime
from typing import List

from fastapi import APIRouter, Request, HTTPException, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import Expense, AccountSettings
from schemas import ExpenseBase, ExpenseResponse, ExpenseUpdate
import deps
from deps import (
    get_db,
    _attach_items,
    _normalize_image_path,
    _validate_image_path,
    _safe_upload_path,
    _delete_supabase_object,
    _check_upload_rate,
)

router = APIRouter()


@router.get("/expenses", response_model=List[ExpenseResponse])
def list_expenses(request: Request, db: Session = Depends(get_db)):
    owner_id, _, _ = deps._resolve_identity(request)
    expenses = (
        db.query(Expense)
        .filter(Expense.owner_id == owner_id)
        .order_by(Expense.id.asc())
        .all()
    )
    for expense in expenses:
        _attach_items(expense)
    return expenses


@router.post("/expenses", response_model=ExpenseResponse)
def create_expense(request: Request, expense: ExpenseBase, db: Session = Depends(get_db)):
    owner_id, _, _ = deps._resolve_identity(request)
    if expense.image_path:
        expense.image_path = _normalize_image_path(expense.image_path)
        _validate_image_path(expense.image_path)
        existing = db.query(Expense).filter(Expense.owner_id == owner_id, Expense.image_path == expense.image_path).first()
        if existing is not None:
            _attach_items(existing)
            return existing

    payload = expense.model_dump(exclude={"items"})
    payload["owner_id"] = owner_id
    db_expense = Expense(**payload)
    db_expense.items_json = json.dumps(expense.items or [])
    db.add(db_expense)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if expense.image_path:
            existing = db.query(Expense).filter(Expense.owner_id == owner_id, Expense.image_path == expense.image_path).first()
            if existing is not None:
                _attach_items(existing)
                return existing
        raise
    db.refresh(db_expense)
    _attach_items(db_expense)
    return db_expense


@router.put("/expenses/{expense_id}", response_model=ExpenseResponse)
def update_expense(expense_id: int, request: Request, expense: ExpenseUpdate, db: Session = Depends(get_db)):
    owner_id, _, _ = deps._resolve_identity(request)
    db_expense = db.query(Expense).filter(Expense.id == expense_id, Expense.owner_id == owner_id).first()
    if db_expense is None:
        raise HTTPException(status_code=404, detail="Expense not found")

    update_data = expense.model_dump(exclude_unset=True, exclude={"items"})
    if "image_path" in update_data and update_data["image_path"]:
        update_data["image_path"] = _normalize_image_path(update_data["image_path"])
        _validate_image_path(update_data["image_path"])
    for key, value in update_data.items():
        setattr(db_expense, key, value)

    if expense.items is not None:
        db_expense.items_json = json.dumps(expense.items)

    db.commit()
    db.refresh(db_expense)
    _attach_items(db_expense)
    return db_expense


@router.delete("/expenses/{expense_id}")
def delete_expense(expense_id: int, request: Request, db: Session = Depends(get_db)):
    owner_id, _, _ = deps._resolve_identity(request)
    db_expense = db.query(Expense).filter(Expense.id == expense_id, Expense.owner_id == owner_id).first()
    if db_expense is None:
        raise HTTPException(status_code=404, detail="Expense not found")
    image_path = db_expense.image_path
    if image_path:
        canonical = _normalize_image_path(image_path)
        if canonical and "/" in canonical:
            _delete_supabase_object(image_path)
        elif canonical:
            try:
                full_path = _safe_upload_path(canonical)
                if os.path.isfile(full_path):
                    os.remove(full_path)
            except HTTPException:
                pass
    db.delete(db_expense)
    db.commit()
    return {"id": expense_id, "deleted": True}


@router.post("/expenses/reconvert")
def reconvert_expenses(request: Request, db: Session = Depends(get_db)):
    """Reconvert the caller's expenses into their preferred currency.

    Scope is strictly the resolved owner. Each row whose stored `currency`
    already matches the preferred currency is skipped. For the rest we convert
    from the row's original source amount at the receipt date; on any FX failure
    the row is left untouched and only a warning is written, so a wrong amount is
    never persisted.
    """
    owner_id, _, _ = deps._resolve_identity(request)
    _check_upload_rate(owner_id)

    settings = db.query(AccountSettings).filter(AccountSettings.owner_id == owner_id).first()
    preferred = (settings.currency if settings and settings.currency else "INR").upper()

    expenses = db.query(Expense).filter(Expense.owner_id == owner_id).all()

    reconverted = 0
    failed = 0
    skipped = 0

    for expense in expenses:
        current_currency = (expense.currency or "INR").upper()
        if current_currency == preferred:
            skipped += 1
            continue

        # Determine the source amount + currency to convert FROM. If the row has
        # a raw_total_amount it was captured after a conversion, so raw_total in
        # source_currency is the ground truth. Otherwise the row was captured
        # natively in `currency`, so treat total_amount/currency as the source.
        if expense.raw_total_amount is not None:
            source_amount = float(expense.raw_total_amount)
            source_currency = (expense.source_currency or current_currency).upper()
        else:
            source_amount = float(expense.total_amount or 0.0)
            source_currency = current_currency

        # Only pass a value that is a valid YYYY-MM-DD. Undated receipts store
        # the literal "Unknown" in `date` (and NULL in receipt_date), which is
        # not parseable — passing that raw would crash get_historical_rate and
        # roll back the whole batch. Anything non-parseable → None, which makes
        # get_historical_rate return its "date missing" tuple so the row is
        # counted failed and the loop continues.
        raw_date = expense.receipt_date or expense.date
        try:
            clean_date = datetime.fromisoformat(raw_date).date().isoformat() if raw_date else None
        except (TypeError, ValueError):
            clean_date = None

        rate, query_date, warning = deps.ocr_engine.get_historical_rate(
            source_currency, preferred, clean_date
        )
        if rate is None or query_date is None:
            expense.currency_warning = (
                warning
                or f"Could not reconvert {source_currency} to {preferred} using the receipt date."
            )
            failed += 1
            continue

        expense.total_amount = round(source_amount * rate, 2)
        expense.currency = preferred
        expense.source_currency = source_currency
        expense.raw_total_amount = source_amount
        expense.fx_rate_date = query_date
        expense.currency_warning = None

        # Keep line items consistent with the new base. Per-item raw_amount (the
        # amount in source_currency) is the source of truth when present; fall
        # back to the item's stored amount otherwise.
        try:
            items = json.loads(expense.items_json or "[]")
        except Exception:
            items = []
        if items:
            for item in items:
                item_source = item.get("raw_amount")
                if item_source is None:
                    item_source = item.get("amount", 0.0)
                try:
                    item_source = float(item_source)
                except (TypeError, ValueError):
                    item_source = 0.0
                item["raw_amount"] = item_source
                item["amount"] = round(item_source * rate, 2)
                item["currency"] = preferred
                item["source_currency"] = source_currency
                item["fx_rate_date"] = query_date
            expense.items_json = json.dumps(items)

        reconverted += 1

    if reconverted or failed:
        db.commit()

    return {"reconverted": reconverted, "failed": failed, "skipped": skipped}
