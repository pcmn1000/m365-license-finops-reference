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

# # Microsoft 365 License FinOps Sync
#
# Loads Microsoft 365 users, subscriptions, license assignments, Microsoft 365 activity,
# and Copilot activity into Delta tables for departmental cost and dormancy reporting.

# CELL ********************

import csv
import io
import json
import re
import time
from datetime import date, datetime, timezone
from decimal import Decimal

import pandas as pd
import requests
from pyspark.sql import functions as F
from pyspark.sql.types import (
    BooleanType,
    DateType,
    DecimalType,
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

TENANT_ID = "1ad1ccf5-59b8-474e-bb89-ee00c91edd48"
CLIENT_ID = "ec28fec2-ef0b-41b6-9433-beb52e0c23dd"
KEY_VAULT_URL = "https://kvm365finops37573032.vault.azure.net/"
GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"
REPORT_PERIOD = "D180"
SNAPSHOT_DATE = datetime.now(timezone.utc).date()
PUBLIC_LIST_PRICE_AS_OF = date(2026, 8, 3)
PUBLIC_LIST_PRICE_SOURCE = "Microsoft public list price JP (annual, tax excl.)"
PRICE_MASTER_RELATIVE_PATH = (
    "Files/reference/sharepoint-license-prices/License-Price-Master.xlsx"
)
PRICE_MASTER_LOCAL_PATH = f"/lakehouse/default/{PRICE_MASTER_RELATIVE_PATH}"
PRICE_MASTER_REQUIRED_COLUMNS = {
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
PUBLIC_LIST_PRICES_JPY = {
    "M365_TEAMS_PREMIUM": Decimal("1499.00"),
    "MICROSOFT_365_E5_(NO_TEAMS)": Decimal("7713.00"),
    "MICROSOFT_365_COPILOT": Decimal("4497.00"),
    "MICROSOFT_TEAMS_ENTERPRISE_NEW": Decimal("1281.00"),
}


def acquire_graph_token():
    client_secret = notebookutils.credentials.getSecret(KEY_VAULT_URL, "graph-client-secret")
    try:
        response = requests.post(
            f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token",
            data={
                "client_id": CLIENT_ID,
                "client_secret": client_secret,
                "scope": "https://graph.microsoft.com/.default",
                "grant_type": "client_credentials",
            },
            timeout=60,
        )
        response.raise_for_status()
        token = response.json().get("access_token")
        if not token:
            raise RuntimeError("Microsoft Entra ID did not return an access token.")
        return token
    finally:
        client_secret = None


GRAPH_TOKEN = acquire_graph_token()
GRAPH_HEADERS = {"Authorization": f"Bearer {GRAPH_TOKEN}"}


def graph_request(url, allow_redirects=False):
    for attempt in range(5):
        response = requests.get(
            url,
            headers=GRAPH_HEADERS,
            allow_redirects=allow_redirects,
            timeout=120,
        )
        if response.status_code not in (429, 503, 504):
            response.raise_for_status()
            return response
        if attempt == 4:
            response.raise_for_status()
        time.sleep(int(response.headers.get("Retry-After", "5")))
    raise RuntimeError(f"Microsoft Graph request did not complete: {url}")


def graph_collection(path):
    rows = []
    url = f"{GRAPH_BASE_URL}{path}"
    while url:
        payload = graph_request(url, allow_redirects=True).json()
        rows.extend(payload.get("value", []))
        url = payload.get("@odata.nextLink")
    return rows


def normalize_column_name(value):
    normalized = re.sub(r"[^0-9A-Za-z]+", "_", value.strip()).strip("_")
    return normalized.lower()


def graph_csv_report(path):
    response = graph_request(f"{GRAPH_BASE_URL}{path}", allow_redirects=False)
    if response.status_code in (301, 302, 303, 307, 308):
        location = response.headers.get("Location")
        if not location:
            raise RuntimeError("Microsoft Graph report redirect did not include a Location header.")
        response = requests.get(location, timeout=120)
        response.raise_for_status()
    content = response.content.decode("utf-8-sig")
    return [
        {normalize_column_name(key): value for key, value in row.items()}
        for row in csv.DictReader(io.StringIO(content))
    ]


def pick(row, *keys):
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return None


def parse_date(value):
    if value in (None, ""):
        return None
    return date.fromisoformat(str(value)[:10])


def parse_timestamp(value):
    if value in (None, ""):
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)


def parse_integer(value):
    if value in (None, ""):
        return None
    return int(value)


def parse_boolean(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes", "y")


def load_external_price_master():
    if not notebookutils.fs.exists(PRICE_MASTER_RELATIVE_PATH):
        return {}, {"status": "NotFound", "rows": 0, "path": PRICE_MASTER_RELATIVE_PATH}

    try:
        frame = pd.read_excel(
            PRICE_MASTER_LOCAL_PATH,
            sheet_name="LicensePrices",
            dtype={"sku_part_number": str, "currency": str, "status": str},
        )
    except Exception as error:
        raise RuntimeError(f"Could not read the SharePoint price master: {error}") from error

    frame.columns = [normalize_column_name(str(column)) for column in frame.columns]
    missing_columns = sorted(PRICE_MASTER_REQUIRED_COLUMNS - set(frame.columns))
    if missing_columns:
        raise RuntimeError(f"Price master is missing required columns: {missing_columns}")

    approved_rows = []
    for index, raw in frame.iterrows():
        row_number = index + 2
        status = str(raw.get("status") or "").strip()
        if status.lower() != "approved" or parse_boolean(raw.get("reference_only")):
            continue

        sku_part_number = str(raw.get("sku_part_number") or "").strip().upper()
        currency = str(raw.get("currency") or "").strip().upper()
        effective_from = parse_date(raw.get("effective_from"))
        effective_to = None if pd.isna(raw.get("effective_to")) else parse_date(raw.get("effective_to"))
        try:
            unit_price = Decimal(str(raw.get("unit_price_monthly")))
        except Exception as error:
            raise RuntimeError(f"Invalid unit price at Excel row {row_number}.") from error

        if not sku_part_number or not currency or effective_from is None:
            raise RuntimeError(f"Missing price key at Excel row {row_number}.")
        if unit_price <= 0:
            raise RuntimeError(f"Approved unit price must be greater than zero at row {row_number}.")
        if effective_to is not None and effective_to < effective_from:
            raise RuntimeError(f"effective_to precedes effective_from at row {row_number}.")
        if not str(raw.get("approved_by") or "").strip() or pd.isna(raw.get("approved_at_utc")):
            raise RuntimeError(f"Approval metadata is missing at Excel row {row_number}.")

        if effective_from <= SNAPSHOT_DATE and (
            effective_to is None or effective_to >= SNAPSHOT_DATE
        ):
            approved_rows.append(
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

    approved_rows.sort(key=lambda row: row["effective_from"], reverse=True)
    price_by_sku = {}
    for row in approved_rows:
        key = (row["sku_part_number"], row["currency"])
        if key in price_by_sku:
            raise RuntimeError(f"Multiple active approved prices exist for {key}.")
        price_by_sku[key] = row

    return price_by_sku, {
        "status": "Loaded",
        "rows": len(price_by_sku),
        "path": PRICE_MASTER_RELATIVE_PATH,
    }


def overwrite_table(rows, schema, table_name):
    frame = spark.createDataFrame(rows, schema=schema)
    frame.write.mode("overwrite").format("delta").option("overwriteSchema", "true").saveAsTable(table_name)


def write_snapshot_table(rows, schema, table_name):
    frame = spark.createDataFrame(rows, schema=schema)
    if spark.catalog.tableExists(table_name):
        spark.sql(
            f"DELETE FROM `{table_name}` WHERE snapshot_date = DATE '{SNAPSHOT_DATE.isoformat()}'"
        )
        frame.write.mode("append").format("delta").option("mergeSchema", "true").saveAsTable(
            table_name
        )
    else:
        frame.write.mode("overwrite").format("delta").saveAsTable(table_name)


def classify_utilization(last_activity_date, account_enabled):
    if not account_enabled:
        return "DisabledAccount", None
    if last_activity_date is None:
        return "NeverUsed", None
    inactive_days = max((SNAPSHOT_DATE - last_activity_date).days, 0)
    if inactive_days <= 30:
        return "Active", inactive_days
    if inactive_days <= 89:
        return "LowUsage", inactive_days
    return "Dormant", inactive_days

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

users = graph_collection(
    "/users?$select=id,userPrincipalName,displayName,department,jobTitle,companyName,"
    "officeLocation,country,city,employeeId,employeeOrgData,accountEnabled,userType,"
    "assignedLicenses,licenseAssignmentStates&$top=999"
)
subscribed_skus = graph_collection(
    "/subscribedSkus?$select=skuId,skuPartNumber,capabilityStatus,consumedUnits,"
    "prepaidUnits,servicePlans"
)

dim_user_rows = []
license_assignment_rows = []
service_entitlement_rows = []
subscribed_sku_by_id = {
    str(sku.get("skuId", "")).lower(): sku for sku in subscribed_skus
}
for user in users:
    user_id = user["id"]
    employee_org_data = user.get("employeeOrgData") or {}
    dim_user_rows.append(
        {
            "user_id": user_id,
            "user_principal_name": user.get("userPrincipalName"),
            "display_name": user.get("displayName"),
            "department": user.get("department") or "Unassigned",
            "job_title": user.get("jobTitle") or "Unassigned",
            "company_name": user.get("companyName") or "Unassigned",
            "office_location": user.get("officeLocation") or "Unassigned",
            "country": user.get("country") or "Unassigned",
            "city": user.get("city") or "Unassigned",
            "employee_id": user.get("employeeId"),
            "division": employee_org_data.get("division") or "Unassigned",
            "cost_center": employee_org_data.get("costCenter") or "Unassigned",
            "account_enabled": bool(user.get("accountEnabled")),
            "user_type": user.get("userType") or "Unknown",
            "snapshot_date": SNAPSHOT_DATE,
        }
    )
    states_by_sku = {
        str(state.get("skuId", "")).lower(): state
        for state in user.get("licenseAssignmentStates") or []
    }
    for assignment in user.get("assignedLicenses") or []:
        sku_id = str(assignment.get("skuId", "")).lower()
        disabled_plan_ids = {
            str(plan_id).lower() for plan_id in assignment.get("disabledPlans") or []
        }
        state = states_by_sku.get(sku_id, {})
        assigned_by_group = state.get("assignedByGroup")
        license_assignment_rows.append(
            {
                "snapshot_date": SNAPSHOT_DATE,
                "user_id": user_id,
                "sku_id": sku_id,
                "assignment_state": state.get("state") or "Active",
                "assignment_source": "Group" if assigned_by_group else "Direct",
                "assigned_by_group": assigned_by_group,
                "last_updated_datetime": parse_timestamp(state.get("lastUpdatedDateTime")),
            }
        )
        for plan in subscribed_sku_by_id.get(sku_id, {}).get("servicePlans") or []:
            service_plan_id = str(plan.get("servicePlanId", "")).lower()
            service_entitlement_rows.append(
                {
                    "snapshot_date": SNAPSHOT_DATE,
                    "user_id": user_id,
                    "sku_id": sku_id,
                    "service_plan_id": service_plan_id,
                    "is_enabled": service_plan_id not in disabled_plan_ids,
                    "sku_provisioning_status": plan.get("provisioningStatus") or "Unknown",
                }
            )

dim_sku_rows = []
service_plan_by_id = {}
sku_service_plan_rows = []
for sku in subscribed_skus:
    sku_id = str(sku.get("skuId", "")).lower()
    prepaid_units = sku.get("prepaidUnits") or {}
    purchased_units = int(prepaid_units.get("enabled") or 0)
    assigned_units = int(sku.get("consumedUnits") or 0)
    dim_sku_rows.append(
        {
            "sku_id": sku_id,
            "sku_part_number": sku.get("skuPartNumber"),
            "capability_status": sku.get("capabilityStatus"),
            "purchased_units": purchased_units,
            "assigned_units": assigned_units,
            "available_units": purchased_units - assigned_units,
            "snapshot_date": SNAPSHOT_DATE,
        }
    )
    for plan in sku.get("servicePlans") or []:
        service_plan_id = str(plan.get("servicePlanId", "")).lower()
        service_plan_by_id.setdefault(
            service_plan_id,
            {
                "service_plan_id": service_plan_id,
                "service_plan_name": plan.get("servicePlanName"),
                "applies_to": plan.get("appliesTo"),
            },
        )
        sku_service_plan_rows.append(
            {
                "sku_id": sku_id,
                "service_plan_id": service_plan_id,
                "provisioning_status": plan.get("provisioningStatus") or "Unknown",
            }
        )

dim_service_plan_rows = list(service_plan_by_id.values())

user_id_by_upn = {
    row["user_principal_name"].lower(): row["user_id"]
    for row in dim_user_rows
    if row["user_principal_name"]
}

try:
    m365_report_rows = graph_csv_report(
        f"/reports/getOffice365ActiveUserDetail(period='{REPORT_PERIOD}')"
    )
except requests.HTTPError as error:
    if error.response is None or error.response.status_code not in (400, 403, 404):
        raise
    m365_report_rows = []

if m365_report_rows and not any(
    "@" in (row.get("user_principal_name") or "") for row in m365_report_rows
):
    raise RuntimeError(
        "Microsoft 365 usage report names are concealed. Disable concealed names in "
        "Microsoft 365 admin center > Settings > Org settings > Services > Reports."
    )

m365_usage_rows = []
for row in m365_report_rows:
    service_dates = {
        "exchange_last_activity_date": parse_date(row.get("exchange_last_activity_date")),
        "onedrive_last_activity_date": parse_date(row.get("onedrive_last_activity_date")),
        "sharepoint_last_activity_date": parse_date(row.get("sharepoint_last_activity_date")),
        "teams_last_activity_date": parse_date(row.get("teams_last_activity_date")),
    }
    populated_dates = [value for value in service_dates.values() if value is not None]
    m365_usage_rows.append(
        {
            "snapshot_date": SNAPSHOT_DATE,
            "report_refresh_date": parse_date(row.get("report_refresh_date")),
            "user_id": user_id_by_upn.get((row.get("user_principal_name") or "").lower()),
            "user_principal_name": row.get("user_principal_name"),
            "overall_last_activity_date": max(populated_dates) if populated_dates else None,
            **service_dates,
            "assigned_products": row.get("assigned_products"),
            "report_period": parse_integer(row.get("report_period")),
        }
    )

try:
    copilot_report_rows = graph_csv_report(
        f"/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='{REPORT_PERIOD}',version='v2')"
    )
except requests.HTTPError as error:
    if error.response is None or error.response.status_code not in (400, 403, 404):
        raise
    copilot_report_rows = []

if copilot_report_rows and not any(
    "@" in (row.get("user_principal_name") or "") for row in copilot_report_rows
):
    raise RuntimeError(
        "Copilot usage report names are concealed. Disable concealed names in "
        "Microsoft 365 admin center > Settings > Org settings > Services > Reports."
    )

copilot_usage_rows = []
for row in copilot_report_rows:
    copilot_usage_rows.append(
        {
            "snapshot_date": SNAPSHOT_DATE,
            "report_refresh_date": parse_date(row.get("report_refresh_date")),
            "user_id": user_id_by_upn.get((row.get("user_principal_name") or "").lower()),
            "user_principal_name": row.get("user_principal_name"),
            "last_activity_date": parse_date(
                pick(row, "microsoft_365_copilot_last_activity_date", "last_activity_date")
            ),
            "prompts_any_app": parse_integer(
                pick(row, "prompts_submitted_any_app", "prompts_submitted_for_all_apps")
            ),
            "prompts_work": parse_integer(
                pick(row, "copilot_chat_work_prompts_submitted", "prompts_submitted_for_copilot_chat_work")
            ),
            "prompts_web": parse_integer(
                pick(row, "copilot_chat_web_prompts_submitted", "prompts_submitted_for_copilot_chat_web")
            ),
            "active_usage_days": parse_integer(
                pick(row, "active_usage_days_for_all_apps", "active_usage_days", "active_days")
            ),
            "report_period": parse_integer(row.get("report_period")),
        }
    )

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

dim_user_schema = StructType(
    [
        StructField("user_id", StringType(), False),
        StructField("user_principal_name", StringType(), True),
        StructField("display_name", StringType(), True),
        StructField("department", StringType(), False),
        StructField("job_title", StringType(), False),
        StructField("company_name", StringType(), False),
        StructField("office_location", StringType(), False),
        StructField("country", StringType(), False),
        StructField("city", StringType(), False),
        StructField("employee_id", StringType(), True),
        StructField("division", StringType(), False),
        StructField("cost_center", StringType(), False),
        StructField("account_enabled", BooleanType(), False),
        StructField("user_type", StringType(), False),
        StructField("snapshot_date", DateType(), False),
    ]
)

dim_sku_schema = StructType(
    [
        StructField("sku_id", StringType(), False),
        StructField("sku_part_number", StringType(), True),
        StructField("capability_status", StringType(), True),
        StructField("purchased_units", IntegerType(), False),
        StructField("assigned_units", IntegerType(), False),
        StructField("available_units", IntegerType(), False),
        StructField("snapshot_date", DateType(), False),
    ]
)

dim_service_plan_schema = StructType(
    [
        StructField("service_plan_id", StringType(), False),
        StructField("service_plan_name", StringType(), True),
        StructField("applies_to", StringType(), True),
    ]
)

sku_service_plan_schema = StructType(
    [
        StructField("sku_id", StringType(), False),
        StructField("service_plan_id", StringType(), False),
        StructField("provisioning_status", StringType(), False),
    ]
)

license_assignment_schema = StructType(
    [
        StructField("snapshot_date", DateType(), False),
        StructField("user_id", StringType(), False),
        StructField("sku_id", StringType(), False),
        StructField("assignment_state", StringType(), False),
        StructField("assignment_source", StringType(), False),
        StructField("assigned_by_group", StringType(), True),
        StructField("last_updated_datetime", TimestampType(), True),
    ]
)

service_entitlement_schema = StructType(
    [
        StructField("snapshot_date", DateType(), False),
        StructField("user_id", StringType(), False),
        StructField("sku_id", StringType(), False),
        StructField("service_plan_id", StringType(), False),
        StructField("is_enabled", BooleanType(), False),
        StructField("sku_provisioning_status", StringType(), False),
    ]
)

m365_usage_schema = StructType(
    [
        StructField("snapshot_date", DateType(), False),
        StructField("report_refresh_date", DateType(), True),
        StructField("user_id", StringType(), True),
        StructField("user_principal_name", StringType(), True),
        StructField("overall_last_activity_date", DateType(), True),
        StructField("exchange_last_activity_date", DateType(), True),
        StructField("onedrive_last_activity_date", DateType(), True),
        StructField("sharepoint_last_activity_date", DateType(), True),
        StructField("teams_last_activity_date", DateType(), True),
        StructField("assigned_products", StringType(), True),
        StructField("report_period", IntegerType(), True),
    ]
)

copilot_usage_schema = StructType(
    [
        StructField("snapshot_date", DateType(), False),
        StructField("report_refresh_date", DateType(), True),
        StructField("user_id", StringType(), True),
        StructField("user_principal_name", StringType(), True),
        StructField("last_activity_date", DateType(), True),
        StructField("prompts_any_app", IntegerType(), True),
        StructField("prompts_work", IntegerType(), True),
        StructField("prompts_web", IntegerType(), True),
        StructField("active_usage_days", IntegerType(), True),
        StructField("report_period", IntegerType(), True),
    ]
)

price_schema = StructType(
    [
        StructField("sku_id", StringType(), False),
        StructField("unit_price_monthly", DecimalType(18, 2), False),
        StructField("currency", StringType(), False),
        StructField("price_source", StringType(), False),
        StructField("effective_from", DateType(), False),
    ]
)

utilization_schema = StructType(
    [
        StructField("snapshot_date", DateType(), False),
        StructField("user_id", StringType(), False),
        StructField("sku_id", StringType(), False),
        StructField("last_activity_date", DateType(), True),
        StructField("inactive_days", IntegerType(), True),
        StructField("utilization_status", StringType(), False),
    ]
)

external_price_by_sku, price_master_summary = load_external_price_master()

overwrite_table(dim_user_rows, dim_user_schema, "dim_user")
overwrite_table(dim_sku_rows, dim_sku_schema, "dim_sku")
overwrite_table(dim_service_plan_rows, dim_service_plan_schema, "dim_service_plan")
overwrite_table(sku_service_plan_rows, sku_service_plan_schema, "bridge_sku_service_plan")
write_snapshot_table(
    license_assignment_rows,
    license_assignment_schema,
    "fact_license_assignment",
)
write_snapshot_table(
    service_entitlement_rows,
    service_entitlement_schema,
    "fact_service_entitlement",
)
write_snapshot_table(m365_usage_rows, m365_usage_schema, "fact_m365_usage")
write_snapshot_table(copilot_usage_rows, copilot_usage_schema, "fact_copilot_usage")

existing_price_by_sku = {}
if spark.catalog.tableExists("dim_sku_price"):
    for row in spark.table("dim_sku_price").collect():
        existing_price_by_sku[row["sku_id"]] = {
            "sku_id": row["sku_id"],
            "unit_price_monthly": Decimal(str(row["unit_price_monthly"] or 0)),
            "currency": row["currency"],
            "price_source": row["price_source"],
            "effective_from": row["effective_from"],
        }

price_rows = []
current_sku_ids = {row["sku_id"] for row in dim_sku_rows}
for sku in dim_sku_rows:
    existing_price = existing_price_by_sku.get(sku["sku_id"])
    sku_part_number = (sku["sku_part_number"] or "").upper()
    external_price = external_price_by_sku.get((sku_part_number, "JPY"))
    public_list_price = PUBLIC_LIST_PRICES_JPY.get(sku_part_number)
    if external_price is not None:
        price_rows.append(
            {
                "sku_id": sku["sku_id"],
                "unit_price_monthly": external_price["unit_price_monthly"],
                "currency": external_price["currency"],
                "price_source": external_price["price_source"],
                "effective_from": external_price["effective_from"],
            }
        )
        continue
    replace_with_public_price = public_list_price is not None and (
        existing_price is None
        or existing_price["price_source"] == "Contract price required"
        or existing_price["unit_price_monthly"] == 0
    )
    if replace_with_public_price:
        price_rows.append(
            {
                "sku_id": sku["sku_id"],
                "unit_price_monthly": public_list_price,
                "currency": "JPY",
                "price_source": PUBLIC_LIST_PRICE_SOURCE,
                "effective_from": PUBLIC_LIST_PRICE_AS_OF,
            }
        )
    elif existing_price is not None:
        price_rows.append(existing_price)
    else:
        price_rows.append(
            {
                "sku_id": sku["sku_id"],
                "unit_price_monthly": Decimal("0.00"),
                "currency": "JPY",
                "price_source": "Contract price required",
                "effective_from": SNAPSHOT_DATE,
            }
        )

price_rows.extend(
    row for sku_id, row in existing_price_by_sku.items() if sku_id not in current_sku_ids
)
overwrite_table(price_rows, price_schema, "dim_sku_price")

users_by_id = {row["user_id"]: row for row in dim_user_rows}
skus_by_id = {row["sku_id"]: row for row in dim_sku_rows}
m365_usage_by_upn = {
    row["user_principal_name"].lower(): row
    for row in m365_usage_rows
    if row["user_principal_name"]
}
copilot_usage_by_upn = {
    row["user_principal_name"].lower(): row
    for row in copilot_usage_rows
    if row["user_principal_name"]
}

utilization_rows = []
for assignment in license_assignment_rows:
    user = users_by_id[assignment["user_id"]]
    sku = skus_by_id.get(assignment["sku_id"], {})
    upn = (user.get("user_principal_name") or "").lower()
    sku_part_number = (sku.get("sku_part_number") or "").upper()
    m365_usage = m365_usage_by_upn.get(upn, {})
    if "COPILOT" in sku_part_number:
        last_activity_date = copilot_usage_by_upn.get(upn, {}).get("last_activity_date")
    elif "TEAMS" in sku_part_number:
        last_activity_date = m365_usage.get("teams_last_activity_date")
    else:
        last_activity_date = m365_usage.get("overall_last_activity_date")
    utilization_status, inactive_days = classify_utilization(
        last_activity_date,
        user["account_enabled"],
    )
    utilization_rows.append(
        {
            "snapshot_date": SNAPSHOT_DATE,
            "user_id": assignment["user_id"],
            "sku_id": assignment["sku_id"],
            "last_activity_date": last_activity_date,
            "inactive_days": inactive_days,
            "utilization_status": utilization_status,
        }
    )

write_snapshot_table(
    utilization_rows,
    utilization_schema,
    "fact_license_utilization",
)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

current_utilization = spark.table("fact_license_utilization").filter(
    F.col("snapshot_date") == F.lit(SNAPSHOT_DATE)
)
status_counts = {
    row["utilization_status"]: row["count"]
    for row in current_utilization.groupBy("utilization_status").count().collect()
}
summary = {
    "snapshot_date": SNAPSHOT_DATE.isoformat(),
    "users": len(dim_user_rows),
    "subscribed_skus": len(dim_sku_rows),
    "license_assignments": len(license_assignment_rows),
    "m365_usage_rows": len(m365_usage_rows),
    "copilot_usage_rows": len(copilot_usage_rows),
    "service_plan_rows": len(dim_service_plan_rows),
    "service_entitlement_rows": len(service_entitlement_rows),
    "price_master": price_master_summary,
    "utilization_status_counts": status_counts,
    "prices_requiring_configuration": spark.table("dim_sku_price")
    .filter(F.col("unit_price_monthly") == 0)
    .count(),
}
print(json.dumps(summary, ensure_ascii=True, sort_keys=True))
GRAPH_TOKEN = None
GRAPH_HEADERS = None
notebookutils.notebook.exit(json.dumps(summary, ensure_ascii=True, sort_keys=True))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
