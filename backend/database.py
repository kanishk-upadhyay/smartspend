import os

from sqlalchemy import create_engine, Column, Integer, String, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./smartspend.db")
if SQLALCHEMY_DATABASE_URL.startswith("postgres://"):
    SQLALCHEMY_DATABASE_URL = SQLALCHEMY_DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine_kwargs = {}
if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}

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

Base.metadata.create_all(bind=engine)

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
