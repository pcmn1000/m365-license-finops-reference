# 詳細アーキテクチャ

## 1. 設計原則

### 取得元と分析用データを分離する

Microsoft Graph、HRIS、SharePoint Onlineは業務上の正本です。Fabricはそれらを
置き換えるのではなく、取得時点の原本、変更履歴、分析しやすい共通モデルを保持します。

### データの速度を3レーンに分ける

#### Fast lane: 割り当て・組織属性

- `/users/delta`で変更ユーザーだけを15分ごとに取得
- `department`、`officeLocation`、`employeeOrgData`、`assignedLicenses`を選択
- `@odata.deltaLink`を制御テーブルに保存
- 夜間に全件スナップショットを取得し、削除や取りこぼしを照合

Graph deltaはポーリング量を減らす仕組みであり、厳密なイベントストリームではありません。
レポート上は「最終同期日時」を表示します。

#### Daily lane: 利用実績

- Microsoft 365 Usage ReportsとCopilot Usage Reportsを日次取得
- APIレスポンスの`reportRefreshDate`を保存
- 取得時刻ではなく、ソース側の更新日を鮮度判定に使用
- 180日を超える履歴はFabric側で日次スナップショットとして保持

#### Reference lane: 単価・組織補正

- 財務/ライセンス管理者がSPO上のExcelを更新
- OneLake Shortcutが同じファイルを参照し、コピーを作らない
- NotebookがExcelテーブル名、必須列、型、重複、有効期間を検証
- 合格した行だけをDeltaへMERGEし、変更前の価格は履歴として残す
- 不合格時は本番価格テーブルを更新せず、Teamsへ通知

## 2. Lakehouseのレイヤー

### Bronze: 原本と監査

| テーブル/ファイル | 内容 |
| --- | --- |
| `bronze_graph_users` | Graph userレスポンス。取得日時とrequest IDを付与 |
| `bronze_graph_skus` | subscribedSkusの原本 |
| `bronze_m365_usage` | Usage Reports CSV原本 |
| `bronze_copilot_usage` | Copilot Usage Reports原本 |
| `Files/reference/license-prices/` | SPO Shortcut配下のExcel |
| `control_ingestion_run` | run ID、開始/終了、件数、エラー、ソース更新日 |
| `control_graph_delta_token` | リソース別deltaLink。機密ではないが書込権限を制限 |

Bronzeは再処理と監査のために保持し、Power BIから直接参照しません。

### Silver: 共通マスタと履歴

| テーブル | 粒度・目的 |
| --- | --- |
| `dim_user_current` | ユーザーの最新状態 |
| `dim_user_history` | 部門・拠点・会社・コストセンターのSCD Type 2履歴 |
| `dim_organization` | 部門、事業部、会社、コストセンター階層 |
| `dim_location` | 拠点、国、地域、タイムゾーン |
| `dim_sku` | SKUと購入/割当可能数 |
| `dim_service_plan` | SKUに含まれるサービスプラン |
| `bridge_sku_service_plan` | SKUとサービスプランの多対多関係 |
| `fact_license_assignment` | 日次または変更時点のユーザー×SKU |
| `fact_service_entitlement` | ユーザー×サービスプランの有効/無効・プロビジョニング状態 |
| `dim_license_price_history` | SKU×通貨×有効期間の契約単価履歴 |

### Gold: FinOps指標

| テーブル | 主な指標 |
| --- | --- |
| `fact_license_utilization` | Active/LowUsage/Dormant/NeverUsed、非アクティブ日数 |
| `fact_license_cost` | 月額コスト、部門/拠点/コストセンター配賦 |
| `fact_license_overlap` | 複数SKUが同じサービスプランを提供する重複 |
| `fact_rightsizing_candidate` | E5→E3、E3→E5、回収候補と根拠 |
| `fact_data_freshness` | ソース別の最終更新、遅延、SLA違反 |

## 3. E3/E5右サイジング

推奨判定は単純な最終利用日だけで行いません。

### E5→E3候補

- E5固有の能動サービス利用が一定期間ない
- E5固有サービスプランが無効、またはプロビジョニング対象外
- Teams Phone、Power BI Pro、PIM、Defender、Purview等の必要性が確認されていない
- 例外リスト、法務・監査ポリシー、特権ロール対象外
- E3との差額と変更影響を算出できる

### E3→E5候補

- E5相当のアドオンを複数個別購入している
- 特権ユーザーだがPIM/高度なID保護が必要
- Purview/Defenderポリシーの対象だが必要な権利が不足
- Teams Phoneや高度な分析など、明確な業務要件がある

### 表示ルール

- 「自動解約」ではなく「要確認候補」と表示
- `recommendation_reason`、`evidence_date`、`excluded_by_policy`を保持
- 推定削減額と、判断に使えなかった情報を併記

## 4. Power BIとData Agent

- Direct LakeモデルはGoldテーブルを参照
- モデルに`Data as of`、`Usage report refresh date`、`Price effective from`を用意
- RLSが必要なら、部門責任者とコストセンター責任者のブリッジを別管理
- Data Agentには右サイジングを断定しない指示と、コストが推定か契約単価かを明示する指示を設定
