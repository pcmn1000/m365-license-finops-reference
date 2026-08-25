# 人・部門・拠点・コストセンターの管理

## 現在の構成

組織属性は **Microsoft Entra ID の値をそのまま使っています**。HRIS や ERP とは連携していません。

| 項目 | 現状 |
| --- | --- |
| 取得元 | `GET /users` の `department` / `officeLocation` / `jobTitle` / `companyName` |
| 保持 | `dim_user` に当日値をスナップショット |
| 履歴 | `snapshot_date` ごとの行。SCD Type 2 なし |
| コストセンター | 未対応 |
| 未設定時 | `Unassigned` を格納。推測で埋めない |
| 手動補正 | なし |

部門別・拠点別の集計はこれだけで成立します。過去のコストを異動前の部門へ
配賦し直す、コストセンター単位で見る、といった要件が出てきた時点で
以降の構成を検討します。

> [!NOTE]
> Entra の `/users` は会議室（`Conf Room ...`）やサービスアカウントも返します。
> ユーザー一覧にそのまま出すと不自然になるため、レポート側では
> ライセンス保有者以外が空白になるメジャーを使って除外しています。

## 本番化する場合の責任分界

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

Entraのユーザープロパティは基本的に現在値です。現行の `dim_user` は
日次スナップショットなので、「その日の部門」は引けますが、
異動の前後関係や有効期間を厳密に追うことはできません。

過去のライセンスコストを当時の部門へ正確に配賦するなら、SCD Type 2 を追加します。

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
