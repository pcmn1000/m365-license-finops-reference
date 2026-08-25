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

## 本番化する場合の SLA

| 対象 | 目標 | 監視条件 |
| --- | --- | --- |
| 割り当て/組織属性 | 日次 | 最終成功が36時間超で警告 |
| SKU在庫 | 日次 | 最終成功が36時間超で警告 |
| Usage Reports | 日次 | `reportRefreshDate`が2日以上古い場合に警告 |
| 単価マスタ | 承認から15分以内 | SPO更新とDelta有効日が不一致 |
| Power BI | Delta更新後数分 | Direct Lakeクエリエラー、容量Paused |

## 本番化する場合の Pipeline 分割

現行の1本を、役割ごとに分けると障害時の切り分けが楽になります。

1. `SyncDirectoryDelta`: users delta、SKU、グループ割り当て
2. `SyncUsageDaily`: M365/Copilot Usage Reports
3. `SyncReferenceData`: SPO単価、組織/拠点補正
4. `BuildFinOpsGold`: 利用率、配賦、重複、右サイジング候補
5. `ValidateAndNotify`: 件数、鮮度、価格未設定、異常増減、Teams通知

各処理は冪等にし、`run_id`と対象日で同じ処理を再実行できるようにします。

## セキュリティ

- Graph権限はアプリケーション権限の最小セットに限定
- 資格情報をNotebookやGitHubへ保存しない
- AzureホストではManaged Identity/Workload Identityを優先
- Client Secretが必要な場合はKey Vaultで保管し、有効期限とローテーションを監視
- SPO単価マスタは更新者と承認者を分離し、バージョン履歴を有効化
- ユーザー名やUPNを含むテーブルは機密として扱い、必要な利用者だけに付与
- Power BIではRLS/OLSとBuild権限を設計

現行は単一ワークスペースです。本番化時は開発/テスト/本番を分離し、
Purviewで所有者、分類、リネージ、保持期間を登録します。

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

## データ品質チェック

現行は自動チェックを入れていません。下記は本番化時に追加する項目です。

- Graph取得件数が前日比で急減していない
- ライセンス割り当てのユーザーID/SKU IDがディメンションに存在する
- 価格未設定の割当SKUがない
- Approved価格の有効期間が重複しない
- 部門/拠点の未設定率が閾値以内
- `reportRefreshDate`が想定範囲内
- E5→E3候補にポリシー除外対象が混入していない

また Usage Reports の匿名化が有効なテナントでは、UPN でユーザーと結合できません。
その場合は Pipeline 全体を失敗させず、利用実績だけを保留して
ライセンス在庫と契約単価の更新は継続します。

## コスト管理

- Fabric F SKUは利用時間に応じて課金されるため、PoCでは営業時間外停止も選択肢
- 停止中はPower BI Direct Lake、Notebook、Pipeline、Data Agentが利用不可
- 本番は容量停止より、Capacity MetricsでCU利用とスロットリングを監視
- Azure Cost Managementの情報はFabric運用費として別KPIにし、M365ライセンス費と混同しない
