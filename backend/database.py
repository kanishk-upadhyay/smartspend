import os

from sqlalchemy import Column, Float, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./smartspend.db")
# Use the psycopg (v3) driver explicitly — that's what requirements installs
# (psycopg[binary]). A bare postgresql:// URL would default to psycopg2, which
# isn't installed, so normalize the scheme to postgresql+psycopg://.
if SQLALCHEMY_DATABASE_URL.startswith("postgres://"):
    SQLALCHEMY_DATABASE_URL = SQLALCHEMY_DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif SQLALCHEMY_DATABASE_URL.startswith("postgresql://") and "+psycopg" not in SQLALCHEMY_DATABASE_URL.split("://", 1)[0]:
    SQLALCHEMY_DATABASE_URL = SQLALCHEMY_DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)

engine_kwargs: dict = {}
if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
    # Reconnect transparently when Supabase/Postgres drops idle SSL connections.
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_recycle"] = 300

engine = create_engine(SQLALCHEMY_DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class Expense(Base):
    __tablename__ = "expenses"

    id = Column(Integer, primary_key=True, index=True)
    vendor = Column(String)
    total_amount = Column(Float)
    date = Column(String)
    category = Column(String, default="General")
    currency = Column(String, default="INR")
    source_currency = Column(String, default="INR")
    raw_total_amount = Column(Float)
    receipt_date = Column(String)
    fx_rate_date = Column(String)
    currency_warning = Column(String)
    item_warning = Column(String)
    items_json = Column(String)
    image_path = Column(String)
    owner_id = Column(String, index=True)
    space_id = Column(Integer, index=True, nullable=True)
    payer_name = Column(String, nullable=True)
    split_type = Column(String, default="equal")
    split_data_json = Column(String, nullable=True)


class Space(Base):
    __tablename__ = "spaces"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    slug = Column(String, unique=True, index=True, nullable=False)
    join_code = Column(String, unique=True, index=True, nullable=False)
    base_currency = Column(String, default="INR")
    created_by = Column(String, index=True, nullable=False)
    created_at = Column(String)


class SpaceMember(Base):
    __tablename__ = "space_members"

    id = Column(Integer, primary_key=True, index=True)
    space_id = Column(Integer, index=True, nullable=False)
    member_id = Column(String, index=True, nullable=False)
    display_name = Column(String, nullable=False)
    role = Column(String, default="member")
    joined_at = Column(String)


class AccountSettings(Base):
    __tablename__ = "account_settings"

    id = Column(Integer, primary_key=True, index=True)
    owner_id = Column(String, unique=True, index=True)
    display_name = Column(String)
    email = Column(String)
    avatar_url = Column(String)
    currency = Column(String, default="INR")
    theme = Column(String, default="system")
    custom_categories_json = Column(String)

Base.metadata.create_all(bind=engine)

with engine.begin() as connection:
    # Keep only the earliest row per (owner_id, image_path) before enforcing
    # uniqueness. Dedup must be scoped per owner to match create_expense's
    # per-owner dedup — a global image_path index would 500 on cross-owner
    # collisions the per-owner recovery can't resolve.
    connection.exec_driver_sql(
        """
        DELETE FROM expenses
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (PARTITION BY owner_id, image_path ORDER BY id) AS rn
                FROM expenses
                WHERE image_path IS NOT NULL AND image_path != ''
            ) dedupe
            WHERE rn > 1
        )
        """
    )
    # Drop the old global index; CREATE ... IF NOT EXISTS won't upgrade an
    # existing global index to the per-owner one.
    connection.exec_driver_sql("DROP INDEX IF EXISTS ux_expenses_image_path")
    connection.exec_driver_sql(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_owner_image_path
        ON expenses (owner_id, image_path)
        WHERE image_path IS NOT NULL AND image_path != ''
        """
    )
    connection.exec_driver_sql(
        """
        DELETE FROM account_settings
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY id) AS rn
                FROM account_settings
                WHERE owner_id IS NOT NULL AND owner_id != ''
            ) dedupe
            WHERE rn > 1
        )
        """
    )
    connection.exec_driver_sql(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_account_settings_owner_id
        ON account_settings (owner_id)
        WHERE owner_id IS NOT NULL AND owner_id != ''
        """
    )

if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    with engine.begin() as connection:
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(expenses)").fetchall()}
        if "currency" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN currency VARCHAR DEFAULT 'INR'")
        if "source_currency" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN source_currency VARCHAR DEFAULT 'INR'")
        if "raw_total_amount" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN raw_total_amount FLOAT")
        if "receipt_date" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN receipt_date VARCHAR")
        if "fx_rate_date" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN fx_rate_date VARCHAR")
        if "currency_warning" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN currency_warning VARCHAR")
        if "item_warning" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN item_warning VARCHAR")
        if "items_json" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN items_json TEXT")
        if "image_path" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN image_path VARCHAR")
        if "owner_id" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN owner_id VARCHAR")
        if "space_id" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN space_id INTEGER")
        if "payer_name" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN payer_name VARCHAR")
        if "split_type" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN split_type VARCHAR DEFAULT 'equal'")
        if "split_data_json" not in columns:
            connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN split_data_json TEXT")
        account_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(account_settings)").fetchall()}
        if not account_columns:
            connection.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS account_settings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_id VARCHAR,
                    display_name VARCHAR,
                    email VARCHAR,
                    avatar_url VARCHAR,
                    currency VARCHAR DEFAULT 'INR',
                    theme VARCHAR DEFAULT 'system',
                    custom_categories_json TEXT
                )
                """
            )
        else:
            if "display_name" not in account_columns:
                connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN display_name VARCHAR")
            if "email" not in account_columns:
                connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN email VARCHAR")
            if "avatar_url" not in account_columns:
                connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN avatar_url VARCHAR")
            if "currency" not in account_columns:
                connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN currency VARCHAR DEFAULT 'INR'")
            if "theme" not in account_columns:
                connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN theme VARCHAR DEFAULT 'system'")
            if "custom_categories_json" not in account_columns:
                connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN custom_categories_json TEXT")
            if "owner_id" not in account_columns:
                connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN owner_id VARCHAR")
else:
    with engine.begin() as connection:
        connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS owner_id VARCHAR")
        connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS space_id INTEGER")
        connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payer_name VARCHAR")
        connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS split_type VARCHAR DEFAULT 'equal'")
        connection.exec_driver_sql("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS split_data_json TEXT")
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_expenses_space_id ON expenses (space_id)")
        connection.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_space_members_pair ON space_members (space_id, member_id)")
        connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS display_name VARCHAR")
        connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS email VARCHAR")
        connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS avatar_url VARCHAR")
        connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS currency VARCHAR DEFAULT 'INR'")
        connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS theme VARCHAR DEFAULT 'system'")
        connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS custom_categories_json TEXT")
        connection.exec_driver_sql("ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS owner_id VARCHAR")
