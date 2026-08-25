# 運用、監視、セキュリティ

## 現在の運用

Pipeline は `DailyM365LicenseSync` の1本だけです。毎日 02:00
`Tokyo Standard Time` に `SyncM365LicenseUsage` Notebook を実行します。

| 項目 | 現状 |
| --- | --- |
| 実行単位 | Notebook 1本で取得から書き込みまで完結 |
| 冗等性 | 同じ `snapshot_date` の行を削除してから追記するため、何度実行しても同じ結果 |
| 失敗時 | 手動で再実行。自動リトライなし |
| 通知 | なし。Fabric のモニタリング画面で確認 |
| 実行履歴 | Fabric のジョブ履歴のみ。制御テーブルなし |
| 単価更新 | `SyncM365PriceMaster` を手動実行 |

実行結果は Notebook の出力に件数とステータスが出ます。監視を強化する場合は、
まず Pipeline の失敗通知（メールまたは Teams）を追加するのが最も安いです。

## セキュリティ

- Graph権限はアプリケーション権限の最小セットに限定
- 資格情報をNotebookやGitHubへ保存しない
- AzureホストではManaged Identity/Workload Identityを優先
- Client Secretが必要な場合はKey Vaultで保管し、有効期限とローテーションを監視
- SPO単価マスタは更新者と承認者を分離し、バージョン履歴を有効化
- ユーザー名やUPNを含むテーブルは機密として扱い、必要な利用者だけに付与
- Power BIではRLS/OLSとBuild権限を設計

ワークスペースは1つです。実行アカウントはテナント管理者で、
Graph へのアクセスはアプリ登録のアプリケーション権限で行っています。

## 現在の Graph アプリケーション権限

現行の Notebook が必要とするのは3つだけです。

| 権限 | 用途 |
| --- | --- |
| `User.Read.All` | ユーザー、組織属性、`assignedLicenses` |
| `Organization.Read.All` | `subscribedSkus` |
| `Reports.Read.All` | M365/Copilot Usage Reports |

次の2つは現行では使っていません。必要になった時点で追加します。

| 権限 | 追加が必要になる場面 |
| --- | --- |
| `LicenseAssignment.Read.All` | `licenseDetails` や割り当てエラーの詳細を見るとき |
| `Group.Read.All` | グループベース割り当ての割当元を追うとき |

`Directory.Read.All`を安易に付与せず、必要な個別権限で足りるかを先に評価します。

## 確認しておくとよいこと

自動チェックは入れていません。実行後に目視で見るなら次の順です。

- Graph取得件数が前日比で急減していない
- 価格未設定の割当SKUがない
- 部門/拠点の `Unassigned` が急に増えていない
- `reportRefreshDate`が想定範囲内

Usage Reports の匿名化が有効なテナントでは、UPN でユーザーと結合できません。
その場合でも Notebook は失敗せず、利用実績だけを空として
ライセンス在庫と契約単価の更新は継続します。

## コスト管理

- Fabric F SKUは利用時間に応じて課金されるため、PoCでは営業時間外停止も選択肢
- 停止中はPower BI Direct Lake、Notebook、Pipeline、Data Agentが利用不可
- 本番は容量停止より、Capacity MetricsでCU利用とスロットリングを監視
- Azure Cost Managementの情報はFabric運用費として別KPIにし、M365ライセンス費と混同しない
