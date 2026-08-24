# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse": "b0a7d28f-558b-4238-8b8e-268d6c886ac1",
# META       "default_lakehouse_name": "M365LicenseFinOps",
# META       "default_lakehouse_workspace_id": "51a0788c-dc9c-4988-b43d-590d3d91bf8b",
# META       "known_lakehouses": [
# META         {
# META           "id": "b0a7d28f-558b-4238-8b8e-268d6c886ac1"
# META         }
# META       ]
# META     }
# META   }
# META }

# MARKDOWN ********************

# # Microsoft 365 License Price Master Sync
#
# Validates the approved SharePoint price workbook exposed through a OneLake
# shortcut and updates the Delta price dimension without calling Microsoft Graph.

# CELL ********************

import json
import re
from datetime import date, datetime, timezone
from decimal import Decimal

import pandas as pd
from pyspark.sql.types import DateType, DecimalType, StringType, StructField, StructType


PRICE_MASTER_RELATIVE_PATH = (
    "Files/reference/sharepoint-license-prices/License-Price-Master.xlsx"
)
PRICE_MASTER_LOCAL_PATH = f"/lakehouse/default/{PRICE_MASTER_RELATIVE_PATH}"
SNAPSHOT_DATE = datetime.now(timezone.utc).date()
REQUIRED_COLUMNS = {
    "sku_part_number",
    "currency",
    "unit_price_monthly",
    "price_type",
    "effective_from",
    "effective_to",
    "source_document",
    "approved_by",
    "approved_at_utc",
    "status",
    "reference_only",
}


def normalize_column_name(value):
    return re.sub(r"[^0-9A-Za-z]+", "_", value.strip()).strip("_").lower()


def parse_date(value):
    if value in (None, "") or pd.isna(value):
        return None
    return date.fromisoformat(str(value)[:10])


def parse_boolean(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes", "y")


def load_approved_prices():
    if not notebookutils.fs.exists(PRICE_MASTER_RELATIVE_PATH):
        raise RuntimeError(f"Price master not found: {PRICE_MASTER_RELATIVE_PATH}")

    frame = pd.read_excel(
        PRICE_MASTER_LOCAL_PATH,
        sheet_name="LicensePrices",
        dtype={"sku_part_number": str, "currency": str, "status": str},
    )
    frame.columns = [normalize_column_name(str(column)) for column in frame.columns]
    missing_columns = sorted(REQUIRED_COLUMNS - set(frame.columns))
    if missing_columns:
        raise RuntimeError(f"Price master is missing required columns: {missing_columns}")

    candidates = []
    for index, raw in frame.iterrows():
        row_number = index + 2
        if str(raw.get("status") or "").strip().lower() != "approved":
            continue
        if parse_boolean(raw.get("reference_only")):
            continue

        sku_part_number = str(raw.get("sku_part_number") or "").strip().upper()
        currency = str(raw.get("currency") or "").strip().upper()
        effective_from = parse_date(raw.get("effective_from"))
        effective_to = parse_date(raw.get("effective_to"))
        try:
            unit_price = Decimal(str(raw.get("unit_price_monthly")))
        except Exception as error:
            raise RuntimeError(f"Invalid unit price at Excel row {row_number}.") from error

        if not sku_part_number or not currency or effective_from is None:
            raise RuntimeError(f"Missing price key at Excel row {row_number}.")
        if unit_price <= 0:
            raise RuntimeError(f"Approved price must be greater than zero at row {row_number}.")
        if effective_to is not None and effective_to < effective_from:
            raise RuntimeError(f"Invalid effective date range at row {row_number}.")
        if not str(raw.get("approved_by") or "").strip() or pd.isna(raw.get("approved_at_utc")):
            raise RuntimeError(f"Approval metadata is missing at Excel row {row_number}.")

        if effective_from <= SNAPSHOT_DATE and (
            effective_to is None or effective_to >= SNAPSHOT_DATE
        ):
            candidates.append(
                {
                    "sku_part_number": sku_part_number,
                    "currency": currency,
                    "unit_price_monthly": unit_price,
                    "price_source": "SharePoint price master: "
                    f"{str(raw.get('price_type') or '').strip()} / "
                    f"{str(raw.get('source_document') or '').strip()}",
                    "effective_from": effective_from,
                }
            )

    candidates.sort(key=lambda row: row["effective_from"], reverse=True)
    price_by_key = {}
    for row in candidates:
        key = (row["sku_part_number"], row["currency"])
        if key in price_by_key:
            raise RuntimeError(f"Multiple active approved prices exist for {key}.")
        price_by_key[key] = row
    return price_by_key


def synchronize_prices():
    if not spark.catalog.tableExists("dim_sku"):
        raise RuntimeError("dim_sku does not exist. Run the full license synchronization first.")

    approved_price_by_key = load_approved_prices()
    current_price_by_sku = {}
    if spark.catalog.tableExists("dim_sku_price"):
        for row in spark.table("dim_sku_price").collect():
            current_price_by_sku[row["sku_id"]] = {
                "sku_id": row["sku_id"],
                "unit_price_monthly": Decimal(str(row["unit_price_monthly"] or 0)),
                "currency": row["currency"],
                "price_source": row["price_source"],
                "effective_from": row["effective_from"],
            }

    output_rows = []
    matched_skus = []
    missing_skus = []
    active_sku_ids = set()
    for sku in spark.table("dim_sku").collect():
        sku_id = sku["sku_id"]
        sku_part_number = (sku["sku_part_number"] or "").upper()
        active_sku_ids.add(sku_id)
        external_price = approved_price_by_key.get((sku_part_number, "JPY"))
        if external_price is not None:
            output_rows.append(
                {
                    "sku_id": sku_id,
                    "unit_price_monthly": external_price["unit_price_monthly"],
                    "currency": external_price["currency"],
                    "price_source": external_price["price_source"],
                    "effective_from": external_price["effective_from"],
                }
            )
            matched_skus.append(sku_part_number)
        elif sku_id in current_price_by_sku:
            output_rows.append(current_price_by_sku[sku_id])
            missing_skus.append(sku_part_number)
        else:
            raise RuntimeError(f"No approved or existing price for active SKU: {sku_part_number}")

    output_rows.extend(
        row for sku_id, row in current_price_by_sku.items() if sku_id not in active_sku_ids
    )

    schema = StructType(
        [
            StructField("sku_id", StringType(), False),
            StructField("unit_price_monthly", DecimalType(18, 2), False),
            StructField("currency", StringType(), False),
            StructField("price_source", StringType(), False),
            StructField("effective_from", DateType(), False),
        ]
    )
    frame = spark.createDataFrame(output_rows, schema=schema)
    frame.write.mode("overwrite").format("delta").option(
        "overwriteSchema", "true"
    ).saveAsTable("dim_sku_price")

    return {
        "status": "Succeeded",
        "source": PRICE_MASTER_RELATIVE_PATH,
        "approved_prices": len(approved_price_by_key),
        "matched_skus": sorted(matched_skus),
        "preserved_existing_skus": sorted(missing_skus),
        "rows_written": len(output_rows),
        "completed_at_utc": datetime.now(timezone.utc).isoformat(),
    }


summary = synchronize_prices()
print(json.dumps(summary, ensure_ascii=True, sort_keys=True))
notebookutils.notebook.exit(json.dumps(summary, ensure_ascii=True, sort_keys=True))
