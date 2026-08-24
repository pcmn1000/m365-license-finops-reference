# 人・部門・拠点・コストセンターの管理

## 推奨する責任分界

| データ | 正本 | Entraの役割 | Fabricの役割 | 手動補正 |
| --- | --- | --- | --- | --- |
| 人、雇用状態、社員番号 | HRIS | 現在値の配布 | 日次/変更履歴、分析結合 | 原則禁止 |
| 部門、事業部、会社 | HRIS/組織MDM | ユーザー現在値 | SCD2履歴、共通階層 | 承認済み例外のみ |
| 拠点、国、地域 | HRIS/拠点MDM | `officeLocation`等 | 標準化、地域階層 | 拠点コード対応表 |
| コストセンター | ERP/財務MDM | `employeeOrgData.costCenter`へ配布可能 | 配賦履歴、責任者結合 | 財務承認が必要 |
| 上司 | HRIS | manager関係 | 分析用責任階層 | 原則禁止 |
| ライセンスペルソナ | IAM/ライセンス運用 | グループ/拡張属性 | 推奨ルール | SharePoint List可 |
| 単価 | 調達/財務 | 保持しない | 有効期間履歴 | SPO Excel/List |

## Entraに保持する推奨属性

- `employeeId`: HRISの不変な従業員キー
- `department`: 表示用の現在部門
- `companyName`: 法人
- `officeLocation`: 拠点コードまたは標準名称
- `country`、`city`: 地域分析
- `employeeOrgData.division`: 事業部
- `employeeOrgData.costCenter`: コストセンター
- manager: 承認・責任階層

自由入力の表記揺れを避けるため、`officeLocation`と`department`にはコード体系を
決めます。表示名はFabricのディメンションで付与しても構いません。

## Fabricで履歴を持つ理由

Entraのユーザープロパティは基本的に現在値です。ユーザーが部門異動した後も過去の
ライセンスコストを当時の部門へ配賦するには、FabricでSCD Type 2を保持します。

`dim_user_history`の推奨キー:

- `user_id`
- `valid_from_utc` / `valid_to_utc`
- `is_current`
- `department_id`
- `location_id`
- `cost_center_id`
- `manager_id`
- `source_system`
- `source_updated_at_utc`

## HRISとEntraで値が異なる場合

優先順位を明示します。

1. HRIS/財務MDMの承認済み値
2. Entraの同期済み現在値
3. 承認済み補正マスタ
4. `Unassigned`。推測で埋めない

差分は`data_quality_issue`へ記録し、Power BIで未設定率、表記揺れ、同期遅延を表示します。

## SharePoint Listを使う場面

次のような小規模な業務補正には、ExcelよりSharePoint Listを推奨します。

- コストセンター責任者
- ライセンス例外ユーザー
- 一時的な部門配賦先
- 推奨判定から除外する法務/監査対象
- 拠点コードと表示名の対応

Listは列型、必須、選択肢、更新履歴を設定しやすく、Power Automateの承認にも向きます。

## 避ける構成

- Power BIのレポート内で部門や単価を手修正する
- LakehouseのGoldテーブルを直接編集して正本にする
- UPNだけを永続キーにする
- 現在の部門を過去の全コストへ遡及適用する
- 複数のExcelで同じコストセンター階層を持つ
