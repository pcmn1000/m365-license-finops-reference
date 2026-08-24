# 運用、監視、セキュリティ

## 推奨SLA

| 対象 | 目標 | 監視条件 |
| --- | --- | --- |
| 割り当て/組織属性 | 日次 | 最終成功が36時間超で警告 |
| SKU在庫 | 日次 | 最終成功が36時間超で警告 |
| Usage Reports | 日次 | `reportRefreshDate`が2日以上古い場合に警告 |
| 単価マスタ | 承認から15分以内 | SPO更新とDelta有効日が不一致 |
| Power BI | Gold更新後数分 | Direct Lakeクエリエラー、容量Paused |

## Pipeline構成

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
- Fabricワークスペースは開発/テスト/本番を分離
- SPO単価マスタは更新者と承認者を分離し、バージョン履歴を有効化
- BronzeのUPN等は機密として扱い、必要な利用者だけに付与
- Power BIではRLS/OLSとBuild権限を設計
- Purviewで所有者、分類、リネージ、保持期間を登録

## 最小Graphアプリケーション権限

| 権限 | 用途 |
| --- | --- |
| `User.Read.All` | ユーザーと組織属性 |
| `Organization.Read.All` | subscribedSkus |
| `LicenseAssignment.Read.All` | 割り当て状態とlicenseDetails |
| `Reports.Read.All` | M365/Copilot Usage Reports |
| `Group.Read.All` | グループベース割り当てを詳細化する場合のみ |

`Directory.Read.All`を安易に付与せず、必要な個別権限で足りるかを先に評価します。

## データ品質チェック

- Graph取得件数が前日比で急減していない
- ライセンス割り当てのユーザーID/SKU IDがディメンションに存在する
- 価格未設定の割当SKUがない
- Approved価格の有効期間が重複しない
- UPN匿名化により利用実績が結合不能になっていない
- 部門/拠点/コストセンターの未設定率が閾値以内
- `reportRefreshDate`が想定範囲内
- E5→E3候補にポリシー除外対象が混入していない

匿名化が有効な場合、Pipeline全体を失敗させず、Usage系Goldテーブルと右サイジング
判定を保留にします。ライセンス在庫と契約単価の更新は継続します。

## コスト管理

- Fabric F SKUは利用時間に応じて課金されるため、PoCでは営業時間外停止も選択肢
- 停止中はPower BI Direct Lake、Notebook、Pipeline、Data Agentが利用不可
- 本番は容量停止より、Capacity MetricsでCU利用とスロットリングを監視
- Azure Cost Managementの情報はFabric運用費として別KPIにし、M365ライセンス費と混同しない
