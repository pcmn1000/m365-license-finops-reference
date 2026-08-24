# Microsoft Graph / API取得範囲

## APIカタログ

| API | 取得できる主な情報 | 主な権限 | 鮮度/制約 |
| --- | --- | --- | --- |
| `GET /subscribedSkus` | SKU ID/コード、購入数、消費数、状態、含まれるサービスプラン | `Organization.Read.All` | 数量・権利。契約単価、請求額、割引率は取得不可 |
| `GET /users?$select=...` | UPN、表示名、部門、役職、会社、拠点、アカウント状態、割当SKU | `User.Read.All`、ライセンス詳細には`LicenseAssignment.Read.All` | 現在値。変更履歴は返さない |
| `GET /users/delta?$select=...` | 新規・更新・削除ユーザーの差分 | `User.Read.All` | 準リアルタイムのポーリング用。deltaLinkの保存が必要 |
| `GET /users/{id}/licenseDetails` | SKUごとのサービスプラン名、プロビジョニング状態 | `LicenseAssignment.Read.All` | ユーザー単位。全員へのN+1呼び出しは避ける |
| `licenseAssignmentStates` | 直接/グループ割り当て、状態、エラー、更新日時、割当元グループ | `LicenseAssignment.Read.All` | `/users`の`$select`で取得。ライセンス運用監査に有効 |
| `GET /groups` / `members` | グループベースライセンスの割当元とメンバー | `Group.Read.All` | 大規模グループは差分取得とページングを設計 |
| `getOffice365ActiveUserDetail` | Exchange、OneDrive、SharePoint、Teamsの最終利用日、割当製品 | `Reports.Read.All` | `D7/D30/D90/D180`。日次レポートでリアルタイムではない |
| `getM365AppUserDetail` | Word、Excel、PowerPoint、Outlook、OneNote、Teams等のアプリ利用とプラットフォーム | `Reports.Read.All` | Usage Reportsの更新周期に依存 |
| Teams user activity detail | チャット、会議、通話、投稿等のユーザー別集計 | `Reports.Read.All` | 集計レポート。メッセージ本文やリアルタイム操作ログではない |
| Exchange activity detail | 送信、受信、既読などのユーザー別集計 | `Reports.Read.All` | レポート定義と保持期間に従う |
| OneDrive usage account detail | 最終活動日、ファイル数、使用量 | `Reports.Read.All` | 個別ファイルの閲覧履歴ではない |
| SharePoint activity user detail | 最終活動日、閲覧/編集/同期等の集計 | `Reports.Read.All` | サイト監査ログとは目的が異なる |
| Copilot usage user detail | 最終利用日、アプリ別プロンプト、利用日数等 | `Reports.Read.All` | APIバージョンと提供項目が変わる可能性がある |
| Graph audit/sign-ins | サインイン、監査イベント | `AuditLog.Read.All`等 | ライセンス利用実績の代替にはしない |
| Azure Cost Management Exports | Azure利用料、予約、Marketplace、タグ、請求明細 | Azure RBAC | Microsoft 365 seat契約の単価/請求とは別 |

## `/subscribedSkus`で分かること

取得可能:

- `skuId`、`skuPartNumber`
- `prepaidUnits.enabled/suspended/warning`
- `consumedUnits`
- `capabilityStatus`
- `servicePlans[].servicePlanId/servicePlanName/provisioningStatus/appliesTo`

取得不可:

- 顧客契約単価、値引率、通貨
- 請求書金額、契約番号、更新日
- E3など未契約SKUの価格とサービス構成
- サービスプラン単位の金額

したがって、契約単価は財務/調達が管理する外部マスタが必要です。CSPの場合は
Partner Center APIを別途検討できますが、一般のGraphライセンスAPIとは分けます。

## 組織属性として選択するプロパティ

```http
GET /users/delta?$select=id,userPrincipalName,displayName,accountEnabled,
department,jobTitle,companyName,officeLocation,country,city,employeeId,
employeeOrgData,assignedLicenses,licenseAssignmentStates
```

`employeeOrgData`には`division`と`costCenter`を保持できます。managerはナビゲーション
プロパティのため、必要に応じて追加取得またはHRマスタと結合します。

## 取得方式の推奨

| 処理 | 推奨方式 |
| --- | --- |
| 初回 | `/users`全件 + `/subscribedSkus` + Usage Reports |
| 日次 | `/users`または`/users/delta`、`/subscribedSkus`、Usage Reports、Copilot Reports、品質チェック |
| 週次 | 全件照合でdelta取りこぼし、削除、属性差分を確認 |
| 詳細調査 | 変更ユーザーまたは候補ユーザーだけ`licenseDetails`を取得 |

すべてのGraph呼び出しでページング、429/503/504の指数バックオフ、request ID、
取得件数、最終deltaLinkを記録します。

## プライバシー設定

Usage ReportsはMicrosoft 365管理センターの設定によりユーザー名が匿名化される場合が
あります。匿名化された状態ではUPN結合ができないため、本番ではプライバシー要件と
分析要件を合意し、RLS、アクセス監査、保持期間とセットで決定します。

## 公式リファレンス

- [subscribedSku resource](https://learn.microsoft.com/graph/api/resources/subscribedsku)
- [List subscribedSkus](https://learn.microsoft.com/graph/api/subscribedsku-list)
- [user resource](https://learn.microsoft.com/graph/api/resources/user)
- [Get incremental changes for users](https://learn.microsoft.com/graph/delta-query-users)
- [licenseDetails](https://learn.microsoft.com/graph/api/user-list-licensedetails)
- [Reports resource](https://learn.microsoft.com/graph/api/resources/report)
- [Microsoft 365 Apps usage reports](https://learn.microsoft.com/microsoft-365/admin/activity-reports/microsoft365-apps-usage)
