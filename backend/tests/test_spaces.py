import os
import sys
import tempfile
import uuid
from unittest.mock import MagicMock

import pytest

# ── PATH & ENV SETUP ──────────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
_test_db_file = os.path.join(tempfile.gettempdir(), f"smartspend_spaces_test_{uuid.uuid4().hex}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_test_db_file}"
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key")
os.environ.setdefault("ZAI_API_KEY", "test-zai-key")
os.environ.pop("SUPABASE_URL", None)
os.environ.pop("SUPABASE_KEY", None)

from fastapi.testclient import TestClient

import deps  # noqa: F401
from database import Base, SessionLocal, Space, SpaceMember, engine
from main import app

USER_A = {"x-smartspend-guest-id": "guest-user-a"}
USER_B = {"x-smartspend-guest-id": "guest-user-b"}
USER_C = {"x-smartspend-guest-id": "guest-user-c"}


@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=engine)
    yield
    try:
        os.remove(_test_db_file)
    except OSError:
        pass


@pytest.fixture
def client():
    return TestClient(app)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Space Creation Tests
# ─────────────────────────────────────────────────────────────────────────────

class TestSpaceCreation:
    def test_create_space_unauthenticated_fails(self, client):
        r = client.post("/spaces", json={"name": "Trip to Goa"})
        assert r.status_code == 401

    def test_create_space_empty_name_fails(self, client):
        r = client.post("/spaces", headers=USER_A, json={"name": "   "})
        assert r.status_code == 400
        assert "cannot be empty" in r.json()["detail"]

    def test_create_space_success(self, client):
        r = client.post("/spaces", headers=USER_A, json={"name": "Apartment 402"})
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "Apartment 402"
        assert len(data["join_code"]) == 6
        assert data["slug"].startswith("spc_")
        assert data["base_currency"] == "INR"
        assert data["member_count"] == 1
        assert data["created_by"] == "guest-user-a"

        # Verify creator is in member list with creator role
        assert len(data["members"]) == 1
        assert data["members"][0]["member_id"] == "guest-user-a"
        assert data["members"][0]["role"] == "creator"

    def test_create_space_custom_currency(self, client):
        r = client.post("/spaces", headers=USER_A, json={"name": "Euro Trip", "base_currency": "EUR"})
        assert r.status_code == 200
        assert r.json()["base_currency"] == "EUR"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Space Listing Tests
# ─────────────────────────────────────────────────────────────────────────────

class TestSpaceListing:
    def test_list_spaces_returns_only_joined_spaces(self, client):
        # User A creates Space A
        r_a = client.post("/spaces", headers=USER_A, json={"name": "Space Alpha"})
        space_a_id = r_a.json()["id"]

        # User B creates Space B
        r_b = client.post("/spaces", headers=USER_B, json={"name": "Space Beta"})
        space_b_id = r_b.json()["id"]

        # User A should see Space A only
        list_a = client.get("/spaces", headers=USER_A).json()
        ids_a = [s["id"] for s in list_a]
        assert space_a_id in ids_a
        assert space_b_id not in ids_a

        # User B should see Space B only
        list_b = client.get("/spaces", headers=USER_B).json()
        ids_b = [s["id"] for s in list_b]
        assert space_b_id in ids_b
        assert space_a_id not in ids_b


# ─────────────────────────────────────────────────────────────────────────────
# 3. Space Joining Tests
# ─────────────────────────────────────────────────────────────────────────────

class TestSpaceJoining:
    def test_join_space_by_code(self, client):
        # User A creates a space
        create_res = client.post("/spaces", headers=USER_A, json={"name": "Dinner Club"}).json()
        join_code = create_res["join_code"]
        space_id = create_res["id"]

        # User B joins via code
        join_res = client.post(
            "/spaces/join",
            headers=USER_B,
            json={"code_or_slug": join_code, "display_name": "Bob (Guest)"},
        )
        assert join_res.status_code == 200
        data = join_res.json()
        assert data["id"] == space_id
        assert data["member_count"] == 2
        member_ids = [m["member_id"] for m in data["members"]]
        assert "guest-user-a" in member_ids
        assert "guest-user-b" in member_ids

    def test_join_space_by_slug(self, client):
        create_res = client.post("/spaces", headers=USER_A, json={"name": "Hackathon Team"}).json()
        slug = create_res["slug"]

        join_res = client.post("/spaces/join", headers=USER_B, json={"code_or_slug": slug})
        assert join_res.status_code == 200
        assert join_res.json()["member_count"] == 2

    def test_join_space_case_insensitive_code(self, client):
        create_res = client.post("/spaces", headers=USER_A, json={"name": "Case Test"}).json()
        join_code_lower = create_res["join_code"].lower()

        join_res = client.post("/spaces/join", headers=USER_B, json={"code_or_slug": join_code_lower})
        assert join_res.status_code == 200

    def test_join_space_invalid_code_returns_404(self, client):
        r = client.post("/spaces/join", headers=USER_B, json={"code_or_slug": "NONEXISTENT"})
        assert r.status_code == 404
        assert "not found" in r.json()["detail"].lower()

    def test_join_space_idempotent(self, client):
        create_res = client.post("/spaces", headers=USER_A, json={"name": "Idempotent Space"}).json()
        code = create_res["join_code"]

        # Join once
        r1 = client.post("/spaces/join", headers=USER_B, json={"code_or_slug": code})
        assert r1.status_code == 200
        assert r1.json()["member_count"] == 2

        # Join again: should return space without error or duplicate members
        r2 = client.post("/spaces/join", headers=USER_B, json={"code_or_slug": code})
        assert r2.status_code == 200
        assert r2.json()["member_count"] == 2


# ─────────────────────────────────────────────────────────────────────────────
# 4. Space Expenses & Balance Calculations
# ─────────────────────────────────────────────────────────────────────────────

class TestSpaceExpensesAndSplits:
    def test_add_expense_to_space(self, client):
        # Create space with User A and User B
        space = client.post("/spaces", headers=USER_A, json={"name": "Flat 101"}).json()
        client.post("/spaces/join", headers=USER_B, json={"code_or_slug": space["join_code"]})

        # User A adds a grocery expense
        exp_res = client.post(
            f"/spaces/{space['id']}/expenses",
            headers=USER_A,
            json={
                "vendor": "Supermarket",
                "total_amount": 1000.0,
                "date": "2026-11-15",
                "category": "Groceries",
                "currency": "INR",
            },
        )
        assert exp_res.status_code == 200
        exp_data = exp_res.json()
        assert exp_data["space_id"] == space["id"]
        assert exp_data["vendor"] == "Supermarket"
        assert exp_data["total_amount"] == 1000.0

    def test_non_member_cannot_add_or_view_space_expenses(self, client):
        space = client.post("/spaces", headers=USER_A, json={"name": "Private Space"}).json()

        # User C is not a member
        r_add = client.post(
            f"/spaces/{space['id']}/expenses",
            headers=USER_C,
            json={"vendor": "Sneak", "total_amount": 500.0, "date": "2026-11-15"},
        )
        assert r_add.status_code == 403

        r_get = client.get(f"/spaces/{space['id']}/expenses", headers=USER_C)
        assert r_get.status_code == 403

    def test_equal_split_balance_calculation(self, client):
        # Space with User A and User B (2 members)
        space = client.post("/spaces", headers=USER_A, json={"name": "Dinner Split"}).json()
        client.post("/spaces/join", headers=USER_B, json={"code_or_slug": space["join_code"]})

        # User A pays ₹1,200
        client.post(
            f"/spaces/{space['id']}/expenses",
            headers=USER_A,
            json={"vendor": "Bistro", "total_amount": 1200.0, "date": "2026-11-15"},
        )

        # Get space expenses & balances
        ledger = client.get(f"/spaces/{space['id']}/expenses", headers=USER_B).json()
        assert len(ledger["expenses"]) == 1
        assert ledger["space"]["total_spend"] == 1200.0

        # Fair share = 1200 / 2 = 600
        # User A paid 1200 -> net balance = +600 (is owed 600)
        # User B paid 0 -> net balance = -600 (owes 600)
        balances = {b["member_id"]: b for b in ledger["balances"]}
        assert balances["guest-user-a"]["paid_amount"] == 1200.0
        assert balances["guest-user-a"]["net_balance"] == 600.0
        assert balances["guest-user-b"]["paid_amount"] == 0.0
        assert balances["guest-user-b"]["net_balance"] == -600.0

    def test_three_members_multiple_payers_balance(self, client):
        space = client.post("/spaces", headers=USER_A, json={"name": "Goa Trip"}).json()
        client.post("/spaces/join", headers=USER_B, json={"code_or_slug": space["join_code"]})
        client.post("/spaces/join", headers=USER_C, json={"code_or_slug": space["join_code"]})

        # User A pays ₹3,000 for villa
        client.post(f"/spaces/{space['id']}/expenses", headers=USER_A, json={"vendor": "Villa", "total_amount": 3000.0, "date": "2026-11-15"})
        # User B pays ₹1,500 for drinks
        client.post(f"/spaces/{space['id']}/expenses", headers=USER_B, json={"vendor": "Drinks", "total_amount": 1500.0, "date": "2026-11-15"})
        # User C pays ₹0

        # Total = 4,500. Fair share per person (3 members) = 1,500
        # User A: paid 3000 -> net = +1500
        # User B: paid 1500 -> net = 0
        # User C: paid 0 -> net = -1500
        ledger = client.get(f"/spaces/{space['id']}/expenses", headers=USER_A).json()
        balances = {b["member_id"]: b for b in ledger["balances"]}
        assert balances["guest-user-a"]["net_balance"] == 1500.0
        assert balances["guest-user-b"]["net_balance"] == 0.0
        assert balances["guest-user-c"]["net_balance"] == -1500.0


# ─────────────────────────────────────────────────────────────────────────────
# 5. Safe Deletion & Reference Counting (Pitfall 3)
# ─────────────────────────────────────────────────────────────────────────────

class TestSafeDeletionAndReferenceCounting:
    def test_deleting_expense_does_not_delete_s3_if_another_references_it(self, client, monkeypatch):
        """When two expense rows point to the same image, deleting one must NOT delete the S3 object."""
        mock_delete_s3 = MagicMock()
        monkeypatch.setattr("deps._delete_storage_object", mock_delete_s3)
        monkeypatch.setattr("routers.expenses._delete_supabase_object", mock_delete_s3)

        image_key = "receipts/shared_bill_abc.png"

        # User A has an expense with image_key
        exp_a = client.post(
            "/expenses",
            headers=USER_A,
            json={"vendor": "Restaurant A", "total_amount": 500.0, "date": "2026-11-15", "image_path": image_key},
        ).json()

        # User B also references the same image_key (e.g. split bill)
        exp_b = client.post(
            "/expenses",
            headers=USER_B,
            json={"vendor": "Restaurant B", "total_amount": 500.0, "date": "2026-11-15", "image_path": image_key},
        ).json()

        # User A deletes their expense
        del_res = client.delete(f"/expenses/{exp_a['id']}", headers=USER_A)
        assert del_res.status_code == 200

        # S3 delete MUST NOT have been called because exp_b still references it!
        assert not mock_delete_s3.called

        # Now User B deletes their expense (the last reference)
        del_b = client.delete(f"/expenses/{exp_b['id']}", headers=USER_B)
        assert del_b.status_code == 200

        # Now S3 delete MUST have been called!
        assert mock_delete_s3.called

    def test_delete_space_detaches_expenses_without_data_loss(self, client):
        space = client.post("/spaces", headers=USER_A, json={"name": "Temporary Space"}).json()
        exp = client.post(
            f"/spaces/{space['id']}/expenses",
            headers=USER_A,
            json={"vendor": "Hotel", "total_amount": 5000.0, "date": "2026-11-15"},
        ).json()

        # Delete the space
        del_res = client.delete(f"/spaces/{space['id']}", headers=USER_A)
        assert del_res.status_code == 200

        # Expense still exists in User A's ledger, with space_id set to None
        exp_check = client.get("/expenses", headers=USER_A).json()
        matching = [e for e in exp_check if e["id"] == exp["id"]]
        assert len(matching) == 1
        assert matching[0]["space_id"] is None

    def test_non_creator_cannot_delete_space(self, client):
        space = client.post("/spaces", headers=USER_A, json={"name": "Creator Only"}).json()
        client.post("/spaces/join", headers=USER_B, json={"code_or_slug": space["join_code"]})

        # User B tries to delete space
        r = client.delete(f"/spaces/{space['id']}", headers=USER_B)
        assert r.status_code == 403
        assert "creator" in r.json()["detail"].lower()


# ─────────────────────────────────────────────────────────────────────────────
# 6. Guest Migration for Spaces (Pitfall 1)
# ─────────────────────────────────────────────────────────────────────────────

class TestGuestMigrationSpaces:
    def test_guest_migration_transfers_spaces_and_memberships(self, client, monkeypatch):
        guest_headers = {"x-smartspend-guest-id": "guest-migrating-user"}
        auth_headers = {
            "Authorization": "Bearer fake-auth-token-123",
            "x-smartspend-guest-id": "guest-migrating-user",
        }

        # Mock auth identity resolution
        def fake_resolve(request):
            auth = request.headers.get("authorization")
            guest = request.headers.get("x-smartspend-guest-id")
            if auth:
                return "auth-user-permanence-999", "auth", {"email": "migrated@example.com"}
            return guest, "guest", None

        monkeypatch.setattr("deps._resolve_identity", fake_resolve)

        # Guest creates a space and joins another space
        space1 = client.post("/spaces", headers=guest_headers, json={"name": "Guest Created Space"}).json()

        other_space = client.post("/spaces", headers=USER_A, json={"name": "Other Space"}).json()
        client.post("/spaces/join", headers=guest_headers, json={"code_or_slug": other_space["join_code"]})

        # Guest has an expense in space1
        client.post(
            f"/spaces/{space1['id']}/expenses",
            headers=guest_headers,
            json={"vendor": "Market", "total_amount": 450.0, "date": "2026-11-15"},
        )

        # Migrate guest account to authenticated user
        mig_res = client.post("/account-migrate-guest", headers=auth_headers)
        assert mig_res.status_code == 200

        # Verify Space ownership was transferred to auth-user-permanence-999
        db = SessionLocal()
        try:
            sp = db.query(Space).filter(Space.id == space1["id"]).first()
            assert sp.created_by == "auth-user-permanence-999"

            # Verify memberships were transferred
            memberships = db.query(SpaceMember).filter(SpaceMember.member_id == "auth-user-permanence-999").all()
            assert len(memberships) == 2
        finally:
            db.close()


# ─────────────────────────────────────────────────────────────────────────────
# 7. Analytics Scope Separation (Pitfall 4)
# ─────────────────────────────────────────────────────────────────────────────

class TestAnalyticsScope:
    def test_personal_scope_excludes_space_expenses(self, client):
        user_headers = {"x-smartspend-guest-id": "guest-analytics-tester"}

        # Add 1 personal expense
        client.post(
            "/expenses",
            headers=user_headers,
            json={"vendor": "Personal Coffee", "total_amount": 250.0, "date": "2026-11-15"},
        )

        # Create space and add 1 shared expense
        space = client.post("/spaces", headers=user_headers, json={"name": "Office Project"}).json()
        client.post(
            f"/spaces/{space['id']}/expenses",
            headers=user_headers,
            json={"vendor": "Shared Server Hardware", "total_amount": 50000.0, "date": "2026-11-15"},
        )

        # Default /expenses returns all owned expenses
        all_exp = client.get("/expenses", headers=user_headers).json()
        assert len(all_exp) == 2

        # ?scope=personal returns only personal expenses (excluding the ₹50,000 shared space expense)
        personal_exp = client.get("/expenses?scope=personal", headers=user_headers).json()
        assert len(personal_exp) == 1
        assert personal_exp[0]["vendor"] == "Personal Coffee"
