# Microsoft Graph / API取得範囲

`SyncM365LicenseUsage` Notebook が実際に呼ぶ API は4本です。
初回も日次も同じ API を全件取得します。

## 使用しているAPI

| API | 取得するもの | 権限 | 主な保存先 |
| --- | --- | --- | --- |
| `GET /users?$select=...` | ユーザー、組織属性、割り当て、無効化プラン | `User.Read.All`、`LicenseAssignment.Read.All` | `dim_user`、`fact_license_assignment`、`fact_service_entitlement` |
| `GET /subscribedSkus?$select=...` | SKU、購入/消費数、サービスプラン | `Organization.Read.All` | `dim_sku`、`dim_service_plan`、`bridge_sku_service_plan` |
| `getOffice365ActiveUserDetail(period='D180')` | M365サービス別の最終利用日 | `Reports.Read.All` | `fact_m365_usage`、`fact_license_utilization` |
| `getMicrosoft365CopilotUsageUserDetail(period='D180',version='v2')` | Copilot最終利用日、プロンプト数、利用日数 | `Reports.Read.All` | `fact_copilot_usage`、`fact_license_utilization` |

## `/users` から取得する項目

```http
GET /users?$select=id,userPrincipalName,displayName,department,jobTitle,
companyName,officeLocation,country,city,employeeId,employeeOrgData,
accountEnabled,userType,assignedLicenses,licenseAssignmentStates&$top=999
```

| Graph項目 | 保存・利用方法 |
| --- | --- |
| `id` | 全テーブルを結ぶ `user_id` |
| `userPrincipalName` / `displayName` | ユーザー識別とレポート表示 |
| `department` / `jobTitle` / `companyName` | 部門・役職・会社 |
| `officeLocation` / `country` / `city` | 拠点・地域 |
| `employeeId` | 社員番号 |
| `employeeOrgData.division` / `costCenter` | 事業部・コストセンター |
| `accountEnabled` / `userType` | 無効アカウント、Member/Guestの判別 |
| `assignedLicenses[].skuId` | ユーザー×SKUの割り当て |
| `assignedLicenses[].disabledPlans` | サービスプランの有効/無効判定 |
| `licenseAssignmentStates` | 直接/グループ割り当て、状態、割当元グループ、更新日時 |

値が空の部門・拠点・役職・会社・事業部・コストセンターは `Unassigned` として保存します。

## `/subscribedSkus` から取得する項目

```http
GET /subscribedSkus?$select=skuId,skuPartNumber,capabilityStatus,
consumedUnits,prepaidUnits,servicePlans
```

| Graph項目 | 保存・利用方法 |
| --- | --- |
| `skuId` / `skuPartNumber` | SKUの内部IDと単価表との結合キー |
| `prepaidUnits.enabled` | 購入数 |
| `consumedUnits` | 割り当て済み数 |
| `capabilityStatus` | SKUの状態 |
| `servicePlans[].servicePlanId` | サービスプランID |
| `servicePlans[].servicePlanName` | 管理センターで使われる品番 |
| `servicePlans[].provisioningStatus` | SKU内でのプロビジョニング状態 |
| `servicePlans[].appliesTo` | 適用対象 |

購入数から消費数を引いて空き数を作ります。SKU とサービスプランの多対多関係は
`bridge_sku_service_plan` に保存します。

## Usage Reports から取得する項目

### Microsoft 365

`getOffice365ActiveUserDetail` から次を取得します。

- レポート更新日
- UPN
- Exchange、OneDrive、SharePoint、Teams の最終利用日
- 割り当て製品
- レポート期間

4サービスのうち最も新しい日を `overall_last_activity_date` として保存します。

### Microsoft 365 Copilot

`getMicrosoft365CopilotUsageUserDetail` v2 から次を取得します。

- レポート更新日
- UPN
- Copilotの最終利用日
- 全アプリ、Work、Webのプロンプト数
- 利用日数
- レポート期間

API がテナントで利用できない場合は 400/403/404 を許容し、Copilot利用行を空にして
ライセンス在庫の同期を継続します。

## APIでは取得できないもの

Microsoft Graph のライセンス API は次を返しません。

- 顧客契約単価、値引率、通貨
- 請求書金額、契約番号、更新日
- 未契約SKUの価格
- サービスプラン単位の金額

単価は `skuPartNumber` をキーに SharePoint の Excel または Notebook 内の定価と結合します。
詳細は [単価マスタとSPO Shortcut](price-master.md) を参照してください。

## 取得方法とエラー処理

- `/users` と `/subscribedSkus` は `@odata.nextLink` をたどって全件取得
- 429/503/504 は `Retry-After` または指数バックオフで再試行
- `/users/delta` は使用しない
- Usage Reports は D180 を日次取得し、`reportRefreshDate` を保存
- 同じ `snapshot_date` の行を削除してから追記

## Usage Reportsの匿名化

Microsoft 365管理センターの設定でユーザー名が匿名化されていると、UPNで
`dim_user` と結合できません。Notebook は匿名化を検出すると Usage 行を空にし、
ライセンス在庫・割り当て・サービスプランの同期だけを継続します。

## 公式リファレンス

- [List users](https://learn.microsoft.com/graph/api/user-list)
- [List subscribedSkus](https://learn.microsoft.com/graph/api/subscribedsku-list)
- [Microsoft 365 usage reports overview](https://learn.microsoft.com/graph/api/resources/report)
- [Microsoft 365 Copilot usage reports](https://learn.microsoft.com/graph/api/reportroot-getmicrosoft365copilotusageuserdetail)
