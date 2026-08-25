# 人・部門・拠点・コストセンターの管理

## 現在の構成

組織属性は **Microsoft Entra ID の値をそのまま使っています**。HRIS や ERP とは連携していません。

| 項目 | 現状 |
| --- | --- |
| 取得元 | `GET /users` のユーザー・組織属性 |
| 保持 | `dim_user` に当日値をスナップショット |
| 履歴 | `snapshot_date` ごとの行。SCD Type 2 なし |
| コストセンター | `employeeOrgData.costCenter` を取得して保持 |
| 未設定時 | `Unassigned` を格納。推測で埋めない |
| 手動補正 | なし |

現在の Power BI レポートでは部門と拠点を使っています。会社、国、市、事業部、
コストセンターも Lakehouse には保存されますが、レポートのビジュアルには出していません。

> [!NOTE]
> Entra の `/users` は会議室（`Conf Room ...`）やサービスアカウントも返します。
> ユーザー一覧にそのまま出すと不自然になるため、レポート側では
> ライセンス保有者以外が空白になるメジャーを使って除外しています。

## 使っている Entra の属性

`GET /users` の `$select` で次を取得し、`dim_user` へそのまま格納します。

| 属性 | 用途 |
| --- | --- |
| `department` | 部門別の割り当て・コスト集計 |
| `officeLocation` | 拠点別の集計、拠点スライサー |
| `jobTitle` | ユーザー一覧の役職 |
| `companyName` | 法人の識別 |
| `country` / `city` | 国・市 |
| `employeeId` | 社員番号 |
| `employeeOrgData.division` | 事業部 |
| `employeeOrgData.costCenter` | コストセンター |
| `accountEnabled` | 無効アカウントへの割り当て検出 |
| `userType` | Member / Guest の判別 |
| `assignedLicenses` | ライセンス割り当ての判定 |
| `licenseAssignmentStates` | 直接/グループ割り当て、状態、割当元、更新日時 |

`officeLocation` は `20/1101` のようなコード値がそのまま入ります。表示名へ
変換していないため、コード体系が決まっていない組織では表記が揺れます。

## 値が入っていない場合

Entra 側が空のときは `Unassigned` を格納します。推測で埋めません。

レポート上は `Unassigned` が1つの部門・拠点として表示されるため、
未設定がどれだけあるかがそのまま見えます。

## 避ける構成

- Power BIのレポート内で部門や単価を手修正する
- Lakehouseのテーブルを直接編集して正本にする
- UPNだけを永続キーにする
- 現在の部門を過去の全コストへ遡及適用する
