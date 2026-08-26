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
| 公開用Importモデル | 毎日03:00 JSTに更新。社内向けDirect Lakeとは別アイテム |

実行結果は Notebook の出力に件数とステータスが出ます。監視を強化する場合は、
まず Pipeline の失敗通知（メールまたは Teams）を追加するのが最も安いです。

## セキュリティ

- Graph権限はアプリケーション権限の最小セットに限定
- 資格情報をNotebookやGitHubへ保存しない
- AzureホストではManaged Identity/Workload Identityを優先
- GraphのClient SecretはFabric Web接続で暗号化して保管し、有効期限とローテーションを監視
- SPO単価マスタは更新者と承認者を分離し、バージョン履歴を有効化
- ユーザー名やUPNを含むテーブルは機密として扱い、必要な利用者だけに付与
- Power BIではRLS/OLSとBuild権限を設計
- `Web に公開`は匿名でモデル内の全データへアクセスできるため、公開可否を別途承認
- 公開停止時は管理ポータルの埋め込みコードを削除し、URLを無効化

ワークスペースは1つです。実行アカウントはテナント管理者で、
Graph へのアクセスはアプリ登録のアプリケーション権限で行っています。

## 現在の Graph アプリケーション権限

現行の Notebook が必要とするのは4つです。

| 権限 | 用途 |
| --- | --- |
| `User.Read.All` | ユーザー、組織属性、`assignedLicenses` |
| `LicenseAssignment.Read.All` | `licenseAssignmentStates`、直接/グループ割り当て |
| `Organization.Read.All` | `subscribedSkus` |
| `Reports.Read.All` | M365/Copilot Usage Reports |

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
- 停止中はPower BI Direct Lake、Notebook、Pipelineが利用不可
- 本番は容量停止より、Capacity MetricsでCU利用とスロットリングを監視
- Azure Cost Managementの情報はFabric運用費として別KPIにし、M365ライセンス費と混同しない

## 匿名公開版の運用

- `DailyM365LicenseSync` が02:00 JSTにLakehouseを更新する
- `M365 License FinOps Public Model` が03:00 JSTにImport更新する
- Power BIのWeb公開キャッシュは更新反映まで時間がかかる場合がある
- OAuth 2.0接続の所有者・有効性と、Import更新履歴を監視する
- 公開URLを定期的に匿名ブラウザーで開き、4ページの表示を確認する
- 公開データの範囲が変わった場合は、埋め込みコードを一度停止して再審査する
