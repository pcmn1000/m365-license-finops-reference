import argparse
import json
import shutil
from pathlib import Path


REPORT_ROOT = Path(__file__).with_name("M365LicenseFinOps.Report")
REPORT_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.1.0/schema.json"
VERSION_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json"
PAGES_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json"
PAGE_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.0.0/schema.json"
VISUAL_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.0.0/schema.json"
PBIR_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json"

COLORS = {
    "ink": "#17181C",
    "muted": "#666A73",
    "canvas": "#FFFFFF",
    "surface": "#F7F7FA",
    "section": "#EAF1FF",
    "line": "#E4E6EC",
    "brand": "#1026B8",
    "brand_light": "#CBD5F4",
    "white": "#FFFFFF",
}


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def literal(value):
    return {"expr": {"Literal": {"Value": value}}}


def solid_color(value):
    return {"solid": {"color": literal(f"'{value}'")}}


def title_objects(title):
    return {
        "title": [
            {
                "properties": {
                    "show": literal("true"),
                    "text": literal(f"'{title}'"),
                    "fontSize": literal("11D"),
                    "fontFamily": literal("'Segoe UI Semibold'"),
                    "fontColor": solid_color(COLORS["ink"]),
                    "bold": literal("true"),
                }
            }
        ],
        "background": [
            {
                "properties": {
                    "show": literal("true"),
                    "color": solid_color(COLORS["surface"]),
                    "transparency": literal("0D"),
                }
            }
        ],
        "border": [
            {
                "properties": {
                    "show": literal("true"),
                    "color": solid_color(COLORS["line"]),
                    "radius": literal("12D"),
                }
            }
        ],
        "dropShadow": [{"properties": {"show": literal("false")}}],
    }


def field(entity, property_name, field_type, active=None, display_name=None):
    projection = {
        "field": {
            field_type: {
                "Expression": {"SourceRef": {"Entity": entity}},
                "Property": property_name,
            }
        },
        "queryRef": f"{entity}.{property_name}",
    }
    if active is not None:
        projection["active"] = active
    if display_name:
        projection["nativeQueryRef"] = display_name
    return projection


def measure(entity, property_name, display_name=None):
    return field(entity, property_name, "Measure", display_name=display_name)


def column(entity, property_name, active=None, display_name=None):
    return field(entity, property_name, "Column", active, display_name)


def visual_container(
    name,
    visual_type,
    x,
    y,
    width,
    height,
    title,
    query_state=None,
    sort=None,
    objects=None,
    container_objects=None,
):
    visual = {
        "visualType": visual_type,
        "visualContainerObjects": container_objects or title_objects(title),
        "drillFilterOtherVisuals": True,
    }
    if objects:
        visual["objects"] = objects
    if query_state:
        visual["query"] = {"queryState": query_state}
        if sort:
            visual["query"]["sortDefinition"] = {
                "sort": [{"field": sort["field"], "direction": sort["direction"]}]
            }
    return {
        "$schema": VISUAL_SCHEMA,
        "name": name,
        "position": {
            "x": x,
            "y": y,
            "z": 1000,
            "height": height,
            "width": width,
            "tabOrder": 1000,
        },
        "visual": visual,
    }


def textbox(name, x, y, width, height, text, font_size=20, background=None, color=None):
    background = background or COLORS["canvas"]
    color = color or COLORS["ink"]
    container_objects = {
        "background": [
            {
                "properties": {
                    "show": literal("true"),
                    "color": solid_color(background),
                    "transparency": literal("0D"),
                }
            }
        ],
        "border": [
            {
                "properties": {
                    "show": literal("true"),
                    "color": solid_color(background),
                    "radius": literal("12D"),
                }
            }
        ],
        "dropShadow": [{"properties": {"show": literal("false")}}],
        "visualHeader": [{"properties": {"show": literal("false")}}],
        "padding": [
            {
                "properties": {
                    "top": literal("0D"),
                    "bottom": literal("0D"),
                    "left": literal("0D"),
                    "right": literal("0D"),
                }
            }
        ],
    }
    objects = {
        "general": [
            {
                "properties": {
                    "paragraphs": [
                        {
                            "textRuns": [
                                {
                                    "value": text,
                                    "textStyle": {
                                        "fontFamily": "Segoe UI Semibold",
                                        "fontSize": f"{font_size}px",
                                        "color": color,
                                    },
                                }
                            ],
                            "horizontalTextAlignment": "left",
                        }
                    ]
                }
            }
        ]
    }
    return visual_container(
        name,
        "textbox",
        x,
        y,
        width,
        height,
        "",
        objects=objects,
        container_objects=container_objects,
    )


def page_header(name, title, subtitle):
    return textbox(name, 24, 14, 1232, 48, f"{title} | {subtitle}", 22)


def section_header(name, x, width, title):
    return textbox(name, x, 72, width, 48, title, 17, COLORS["section"], COLORS["brand"])


def card(name, x, y, width, title, entity, measure_name, height=148):
    objects = {
        "layout": [
            {
                "properties": {
                    "style": literal("'Cards'"),
                    "alignment": literal("'top'"),
                    "rowCount": literal("1L"),
                    "columnCount": literal("1L"),
                    "cellPadding": literal("0L"),
                }
            }
        ],
        "value": [
            {
                "properties": {
                    "fontSize": literal("22D"),
                    "fontFamily": literal("'Segoe UI'"),
                    "horizontalAlignment": literal("'left'"),
                    "fontColor": solid_color(COLORS["ink"]),
                },
                "selector": {"id": "default"},
            }
        ],
        "label": [
            {
                "properties": {"show": literal("false")},
                "selector": {"id": "default"},
            }
        ],
        "shapeCustomRectangle": [
            {
                "properties": {
                    "tileShape": literal("'rectangleRounded'"),
                    "rectangleRoundedCurve": literal("12L"),
                },
                "selector": {"id": "default"},
            }
        ],
        "fillCustom": [
            {
                "properties": {"show": literal("true")},
            },
            {
                "properties": {"fillColor": solid_color(COLORS["surface"])},
                "selector": {"id": "default"},
            }
        ],
        "outline": [
            {
                "properties": {"show": literal("false")},
                "selector": {"id": "default"},
            }
        ],
        "shadowCustom": [
            {
                "properties": {"show": literal("false")},
                "selector": {"id": "default"},
            }
        ],
        "padding": [
            {
                "properties": {
                    "paddingSelection": literal("'Custom'"),
                    "topMargin": literal("18L"),
                    "leftMargin": literal("18L"),
                    "rightMargin": literal("18L"),
                    "bottomMargin": literal("14L"),
                },
                "selector": {"id": "default"},
            }
        ],
    }
    return visual_container(
        name,
        "cardVisual",
        x,
        y,
        width,
        height,
        title,
        {"Data": {"projections": [measure(entity, measure_name)]}},
        objects=objects,
    )


def slicer(name, x, y, width, title, selection):
    objects = {
        "data": [{"properties": {"mode": literal("'Dropdown'")}}],
        "items": [
            {
                "properties": {
                    "fontFamily": literal("'Segoe UI'"),
                    "textSize": literal("13D"),
                    "fontColor": solid_color(COLORS["ink"]),
                    "background": solid_color(COLORS["surface"]),
                }
            }
        ],
        "visualHeader": [{"properties": {"show": literal("false")}}],
    }
    return visual_container(
        name,
        "slicer",
        x,
        y,
        width,
        148,
        title,
        {"Values": {"projections": [selection]}},
        objects=objects,
    )


def bar_chart(name, x, y, width, height, title, category, values, sort_measure=None):
    query_state = {
        "Category": {"projections": [category]},
        "Y": {"projections": values},
    }
    sort = None
    if sort_measure:
        sort = {"field": sort_measure["field"], "direction": "Descending"}
    objects = {
        "categoryAxis": [
            {
                "properties": {
                    "showAxisTitle": literal("false"),
                    "fontFamily": literal("'Segoe UI'"),
                    "fontSize": literal("9D"),
                    "labelColor": solid_color(COLORS["muted"]),
                }
            }
        ],
        "valueAxis": [
            {
                "properties": {
                    "showAxisTitle": literal("false"),
                    "fontFamily": literal("'Segoe UI'"),
                    "fontSize": literal("9D"),
                    "labelColor": solid_color(COLORS["muted"]),
                    "gridlineColor": solid_color(COLORS["line"]),
                }
            }
        ],
        "dataPoint": [{"properties": {"fill": solid_color(COLORS["brand"])}}],
        "labels": [
            {
                "properties": {
                    "show": literal("true"),
                    "fontFamily": literal("'Segoe UI Semibold'"),
                    "fontSize": literal("9D"),
                    "color": solid_color(COLORS["ink"]),
                }
            }
        ],
    }
    return visual_container(
        name,
        "barChart",
        x,
        y,
        width,
        height,
        title,
        query_state,
        sort,
        objects,
    )


def table(name, x, y, width, height, title, values, sort_measure=None):
    sort = None
    if sort_measure:
        sort = {"field": sort_measure["field"], "direction": "Descending"}
    objects = {
        "columnHeaders": [
            {
                "properties": {
                    "fontFamily": literal("'Segoe UI Semibold'"),
                    "fontSize": literal("10D"),
                    "fontColor": solid_color(COLORS["ink"]),
                    "backColor": solid_color(COLORS["section"]),
                }
            }
        ],
        "grid": [
            {
                "properties": {
                    "rowPadding": literal("7D"),
                    "textSize": literal("10D"),
                    "gridVertical": literal("false"),
                    "gridHorizontal": literal("true"),
                    "outlineColor": solid_color(COLORS["line"]),
                }
            }
        ],
        "values": [
            {
                "properties": {
                    "fontFamily": literal("'Segoe UI'"),
                    "fontSize": literal("10D"),
                    "fontColorPrimary": solid_color(COLORS["ink"]),
                    "backColorPrimary": solid_color(COLORS["surface"]),
                }
            }
        ],
        "total": [{"properties": {"totals": literal("false")}}],
        "visualHeader": [{"properties": {"show": literal("false")}}],
    }
    return visual_container(
        name,
        "tableEx",
        x,
        y,
        width,
        height,
        title,
        {"Values": {"projections": values}},
        sort,
        objects,
    )


def build_pages():
    assigned = measure("License Utilization", "# Assigned Seats")
    active = measure("License Utilization", "# Active Seats")
    active_rate = measure("License Utilization", "Active Rate")
    monthly_cost = measure("License Utilization", "Monthly Cost")
    recoverable_cost = measure("License Utilization", "Recoverable Cost")
    included_plans = measure("Service Entitlement", "# Included Service Plans")
    enabled_entitlements = measure("Service Entitlement", "# Enabled Entitlements")
    disabled_entitlements = measure("Service Entitlement", "# Disabled Entitlements")

    return [
        {
            "name": "ExecutiveSummary",
            "displayName": "エグゼクティブ サマリー",
            "visuals": [
                page_header("ExecutiveHeader", "M365 License FinOps", "ライセンス運用サマリー"),
                section_header("LicenseFilterHeader", 24, 290, "対象ライセンス"),
                section_header("LocationFilterHeader", 328, 290, "対象拠点"),
                section_header("UsersHeader", 632, 290, "割当ユーザー"),
                section_header("CostHeader", 936, 320, "月額コスト"),
                slicer(
                    "LicenseSkuSlicer",
                    24,
                    130,
                    290,
                    "ライセンスを選択",
                    column("License SKU", "License Name", True, "ライセンス名"),
                ),
                slicer(
                    "OfficeLocationSlicer",
                    328,
                    130,
                    290,
                    "拠点を選択",
                    column("User", "Office Location", True, "拠点"),
                ),
                card(
                    "LicensedUsers",
                    632,
                    130,
                    290,
                    "ライセンス保有ユーザー",
                    "License Utilization",
                    "# Licensed Users",
                ),
                card(
                    "MonthlyCost",
                    936,
                    130,
                    320,
                    "推定月額コスト",
                    "License Utilization",
                    "Monthly Cost",
                ),
                bar_chart(
                    "DepartmentAssignments",
                    24,
                    296,
                    430,
                    404,
                    "部門別 割当ユーザー",
                    column("User", "Department", True),
                    [measure("License Utilization", "# Licensed Users")],
                    measure("License Utilization", "# Licensed Users"),
                ),
                table(
                    "AssignedUserDirectory",
                    468,
                    296,
                    788,
                    404,
                    "割当ユーザー一覧",
                    [
                        column("User", "Display Name", display_name="氏名"),
                        column("User", "Department", display_name="部門"),
                        column("User", "Job Title", display_name="役職"),
                        measure("License Utilization", "# Assigned Seats", "割当数"),
                    ],
                    assigned,
                ),
            ],
            "visualInteractions": [
                {
                    "source": "DepartmentAssignments",
                    "target": "AssignedUserDirectory",
                    "type": "DataFilter",
                }
            ],
        },
        {
            "name": "DepartmentComparison",
            "displayName": "部門比較",
            "visuals": [
                page_header("DepartmentHeader", "M365 License FinOps", "部門別の利用効率"),
                section_header("DepartmentUsersHeader", 24, 290, "ライセンス"),
                section_header("DepartmentActiveHeader", 328, 290, "利用状況"),
                section_header("DepartmentEfficiencyHeader", 632, 290, "利用効率"),
                section_header("DepartmentOptimizationHeader", 936, 320, "最適化"),
                card(
                    "DepartmentLicensedUsers",
                    24,
                    130,
                    290,
                    "ライセンス保有ユーザー",
                    "License Utilization",
                    "# Licensed Users",
                ),
                card(
                    "ActiveUsers",
                    328,
                    130,
                    290,
                    "Activeユーザー",
                    "License Utilization",
                    "# Active Users",
                ),
                card(
                    "CostPerActiveUser",
                    632,
                    130,
                    290,
                    "Activeユーザー単価",
                    "License Utilization",
                    "Cost per Active User",
                ),
                card(
                    "RecoverableRate",
                    936,
                    130,
                    320,
                    "削減可能率",
                    "License Utilization",
                    "Recoverable Cost Rate",
                ),
                bar_chart(
                    "DepartmentSeats",
                    24,
                    296,
                    610,
                    404,
                    "部門別 Active / 割り当て",
                    column("User", "Department", True),
                    [
                        measure("License Utilization", "# Assigned Seats", "割当"),
                        measure("License Utilization", "# Active Seats", "Active"),
                    ],
                    assigned,
                ),
                bar_chart(
                    "DepartmentOptimization",
                    646,
                    296,
                    610,
                    404,
                    "部門別 削減可能額",
                    column("User", "Department", True),
                    [recoverable_cost],
                    recoverable_cost,
                ),
            ],
        },
        {
            "name": "ServicePlanAnalysis",
            "displayName": "サービスプラン",
            "visuals": [
                page_header(
                    "ServicePlanHeader",
                    "M365 License FinOps",
                    "ライセンスに含まれるサービスの有効・無効",
                ),
                section_header("ServiceLicenseHeader", 24, 290, "対象ライセンス"),
                section_header("IncludedPlansHeader", 328, 290, "含まれるサービス"),
                section_header("EnabledPlansHeader", 632, 290, "有効な権利"),
                section_header("DisabledPlansHeader", 936, 320, "無効な権利"),
                slicer(
                    "ServiceLicenseSlicer",
                    24,
                    130,
                    290,
                    "ライセンスを選択",
                    column("License SKU", "License Name", True, "ライセンス名"),
                ),
                card(
                    "IncludedServicePlans",
                    328,
                    130,
                    290,
                    "サービスプラン数",
                    "Service Entitlement",
                    "# Included Service Plans",
                ),
                card(
                    "EnabledEntitlements",
                    632,
                    130,
                    290,
                    "有効なユーザー権利",
                    "Service Entitlement",
                    "# Enabled Entitlements",
                ),
                card(
                    "DisabledEntitlements",
                    936,
                    130,
                    320,
                    "無効なユーザー権利",
                    "Service Entitlement",
                    "# Disabled Entitlements",
                ),
                bar_chart(
                    "ServiceEnabledUsers",
                    24,
                    296,
                    430,
                    404,
                    "サービス別 有効ユーザー権利",
                    column("Service Plan", "Service Plan Name", True),
                    [enabled_entitlements],
                    enabled_entitlements,
                ),
                table(
                    "ServicePlanDetails",
                    468,
                    296,
                    788,
                    404,
                    "サービスプラン詳細",
                    [
                        column(
                            "Service Plan",
                            "Service Plan Name",
                            display_name="サービスプラン",
                        ),
                        enabled_entitlements,
                        disabled_entitlements,
                    ],
                    disabled_entitlements,
                ),
            ],
        },
        {
            "name": "UserAndCopilot",
            "displayName": "ユーザー・Copilot詳細",
            "visuals": [
                page_header("CopilotHeader", "M365 License FinOps", "ユーザー・Copilot利用状況"),
                section_header("CopilotUsersHeader", 24, 290, "Copilot利用者"),
                section_header("CopilotPromptsHeader", 328, 290, "プロンプト"),
                section_header("CopilotDensityHeader", 632, 290, "利用密度"),
                section_header("M365UsersHeader", 936, 320, "M365利用"),
                card(
                    "CopilotUsers",
                    24,
                    130,
                    290,
                    "Copilot Activeユーザー",
                    "Copilot Usage",
                    "# Copilot Active Users",
                ),
                card(
                    "CopilotPrompts",
                    328,
                    130,
                    290,
                    "Copilot プロンプト",
                    "Copilot Usage",
                    "# Copilot Prompts",
                ),
                card(
                    "PromptsPerUser",
                    632,
                    130,
                    290,
                    "ユーザー当たりプロンプト",
                    "Copilot Usage",
                    "Prompts per Active Copilot User",
                ),
                card(
                    "M365ActiveUsers",
                    936,
                    130,
                    320,
                    "M365利用ユーザー",
                    "M365 Usage",
                    "# M365 Users with Activity",
                ),
                bar_chart(
                    "DepartmentCopilot",
                    24,
                    296,
                    430,
                    404,
                    "部門別 Copilotプロンプト",
                    column("User", "Department", True),
                    [measure("Copilot Usage", "# Copilot Prompts", "プロンプト数")],
                    measure("Copilot Usage", "# Copilot Prompts"),
                ),
                table(
                    "UserDetails",
                    468,
                    296,
                    788,
                    404,
                    "ユーザー利用詳細",
                    [
                        column("User", "Display Name", display_name="氏名"),
                        column("User", "Department", display_name="部門"),
                        column("Copilot Usage", "Last Activity Date", display_name="最終利用日"),
                        column("Copilot Usage", "Active Usage Days", display_name="利用日数"),
                        measure("Copilot Usage", "# Copilot Prompts", "プロンプト数"),
                    ],
                    measure("Copilot Usage", "# Copilot Prompts"),
                ),
            ],
        },
    ]


def build_report(semantic_model_id):
    if REPORT_ROOT.exists():
        shutil.rmtree(REPORT_ROOT)

    pages = build_pages()
    write_json(
        REPORT_ROOT / "definition.pbir",
        {
            "$schema": PBIR_SCHEMA,
            "version": "4.0",
            "datasetReference": {
                "byConnection": {
                    "connectionString": f"semanticmodelid={semantic_model_id}"
                }
            },
        },
    )
    write_json(
        REPORT_ROOT / "definition" / "version.json",
        {"$schema": VERSION_SCHEMA, "version": "2.0.0"},
    )
    write_json(
        REPORT_ROOT / "definition" / "report.json",
        {
            "$schema": REPORT_SCHEMA,
            "themeCollection": {
                "baseTheme": {
                    "name": "CY25SU12",
                    "reportVersionAtImport": {
                        "visual": "2.5.0",
                        "report": "3.1.0",
                        "page": "2.3.0",
                    },
                    "type": "SharedResources",
                }
            },
            "settings": {
                "useStylableVisualContainerHeader": True,
                "defaultFilterActionIsDataFilter": True,
                "defaultDrillFilterOtherVisuals": True,
                "allowChangeFilterTypes": True,
                "allowInlineExploration": True,
                "useEnhancedTooltips": True,
            },
            "annotations": [
                {"name": "defaultPage", "value": pages[0]["name"]},
                {"name": "solution", "value": "M365 License FinOps"},
            ],
        },
    )
    write_json(
        REPORT_ROOT / "definition" / "pages" / "pages.json",
        {
            "$schema": PAGES_SCHEMA,
            "pageOrder": [page["name"] for page in pages],
            "activePageName": pages[0]["name"],
        },
    )

    visual_names = set()
    for page in pages:
        page_root = REPORT_ROOT / "definition" / "pages" / page["name"]
        write_json(
            page_root / "page.json",
            {
                "$schema": PAGE_SCHEMA,
                "name": page["name"],
                "displayName": page["displayName"],
                "displayOption": "FitToPage",
                "height": 720,
                "width": 1280,
            },
        )
        for visual_index, visual in enumerate(page["visuals"], start=1):
            visual_name = visual["name"]
            if visual_name in visual_names:
                raise ValueError(f"Duplicate visual name: {visual_name}")
            visual_names.add(visual_name)
            position = visual["position"]
            position["z"] = visual_index * 1000
            position["tabOrder"] = visual_index * 1000
            if position["x"] + position["width"] > 1280 or position["y"] + position["height"] > 720:
                raise ValueError(f"Visual is outside page bounds: {visual_name}")
            write_json(page_root / "visuals" / visual_name / "visual.json", visual)

    return pages, visual_names


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("semantic_model_id")
    args = parser.parse_args()
    pages, visuals = build_report(args.semantic_model_id)
    print(
        json.dumps(
            {
                "report_root": str(REPORT_ROOT),
                "pages": len(pages),
                "visuals": len(visuals),
                "semantic_model_id": args.semantic_model_id,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()