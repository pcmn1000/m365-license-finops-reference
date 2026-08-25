# 詳細アーキテクチャ

現在動いている構成を説明します。Notebook 1本で取得から書き込みまで完結します。

## 1. 現行構成

### 全体の流れ

`SyncM365LicenseUsage` Notebook が毎日 02:00 (JST) に実行され、次を順に行います。

1. Microsoft Graph から4種類のデータを取得する
2. Python 側で結合・分類してテーブルごとの行を組み立てる
3. Lakehouse の Delta テーブルへスナップショットとして書く

中間ファイルも制御テーブルも作らず、1回の実行で取得から書き込みまで完結します。

### 取得している Graph API

| 呼び出し | 用途 |
| --- | --- |
| `GET /users?$select=...` | ユーザー、部門、拠点、役職、アカウント状態、割当SKU |
| `GET /subscribedSkus?$select=...` | SKU、購入数、消費数、含まれるサービスプラン |
| `GET /reports/getOffice365ActiveUserDetail(period='D30')` | Exchange/OneDrive/SharePoint/Teams の最終利用日 |
| `GET /copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D30',version='v2')` | Copilot の最終利用日、プロンプト数、利用日数 |

`/users/delta` は使っていません。全件取得のほうが状態管理が不要で、
数千ユーザー規模なら実行時間も問題になりません。

### 書き込み方式

全テーブルが `snapshot_date` 列を持ちます。書き込みは「同じ日付の行を消してから追記」です。

```python
DELETE FROM `{table}` WHERE snapshot_date = DATE '{today}'
frame.write.mode("append").format("delta").saveAsTable(table)
```

同日中に何度実行しても結果が変わらず、過去日のスナップショットは残ります。
SCD Type 2 のような有効期間管理は行っていません。「その日どうだったか」を
日付で引く方式です。

### テーブル一覧

階層は作らず、10本をフラットに並べています。

| テーブル | 種別 | 内容 |
| --- | --- | --- |
| `dim_user` | ディメンション | ユーザーの当日値 |
| `dim_sku` | ディメンション | SKUコード、購入数、消費数 |
| `dim_sku_price` | ディメンション | SKU別の単価と出典 |
| `dim_service_plan` | ディメンション | 内部プランと日本語の業務機能名・カテゴリ・E5判断区分 |
| `bridge_sku_service_plan` | ブリッジ | SKUとサービスプランの多対多 |
| `fact_license_assignment` | ファクト | ユーザー×SKU |
| `fact_service_entitlement` | ファクト | ユーザー×サービスプランの有効/無効 |
| `fact_license_utilization` | ファクト | 利用状態、最終利用日、非アクティブ日数 |
| `fact_m365_usage` | ファクト | サービス別の最終利用日 |
| `fact_copilot_usage` | ファクト | Copilotの利用実績 |

### 計算をどこで行っているか

利用率、月額コスト、削減可能額、E5機能の有効/無効判定は
**Delta テーブルではなくセマンティックモデルの DAX メジャー**で計算しています。
集計済みテーブルを作らないぶん構成が減り、指標の定義変更もモデル側だけで済みます。

Notebook 側で行っているのは、テーブルに保存しないと再現できない次の2つだけです。

- 利用状態の分類（`Active` / `LowUsage` / `Dormant` / `NeverUsed` / `DisabledAccount`）
- 内部サービスプランから日本語の業務機能への集約

### 利用状態の判定

`fact_license_utilization` の `utilization_status` は、SKUの種類に応じて
参照する最終利用日を切り替えてから、経過日数で分類します。

| SKU | 参照する最終利用日 |
| --- | --- |
| Copilot を含む | Copilot Usage Reports |
| Teams 単体（`NO_TEAMS` を含まない） | Teams の最終利用日 |
| その他 | Exchange/OneDrive/SharePoint/Teams のうち最も新しい日 |

分類は経過日数で `30日以内 = Active`、`89日以内 = LowUsage`、それ以上 = `Dormant`、
利用日なし = `NeverUsed`、無効アカウント = `DisabledAccount` です。

> [!NOTE]
> SKU名の部分一致には注意が必要です。`Microsoft_365_E5_(no_Teams)` は
> Teams が含まれない SKU にもかかわらず文字列に `TEAMS` を含むため、
> 単純な部分一致だと Teams の利用実績を参照して値が空になります。

### 単価の扱い

`dim_sku_price` は次の優先順で決まります。

1. SharePoint 上の `License-Price-Master.xlsx` の `Approved` 行
2. Notebook に定義されたパブリック定価（JP、年間契約、税抜）

Shortcut が無い、または Excel が読めない場合は 2 が使われるため、
**SharePoint を用意しなくても構成は動きます**。契約単価が必要になった時点で
Excel を置けば、そちらが優先されます。

## 2. 現行構成の制約

単純にしたぶん、次のことはできません。前提として押さえておく項目です。

| 項目 | 現状 | できないこと |
| --- | --- | --- |
| レイヤー | フラット10テーブル | 取得原本へ戻っての再処理 |
| 履歴 | 日次スナップショット | 異動の前後関係を有効期間で厳密に追うこと |
| 取得 | `/users` 全件 | ユーザー数が数万規模になったときの実行時間短縮 |
| 実行制御 | なし | 件数・エラーの履歴を残すこと |
| 集計 | DAXメジャー | 大規模データでの計算負荷の分散 |
| 組織マスタ | Entra の値のみ | コストセンター単位の配賦 |
| 通知 | なし | 異常の自動検知 |
| 単価承認 | 手動実行 | 承認と同時の自動反映 |

数千ユーザー規模で、部門別・拠点別のコスト把握と E5 の使われ方の確認が目的なら、
これらは無くても成立します。

## 3. E3/E5右サイジング

判定は単純な最終利用日だけでは行いません。レポートでは
「要確認候補」までを示し、解約判断は人が行う前提にしています。

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
- Graphの内部プラン名は監査用に保持し、通常画面では日本語の業務機能へ集約
- 技術・付帯プランはE5/E3判断画面から除外
- サービスプランの有効化は設定シグナルであり、利用実績として扱わない
- 推定削減額と、判断に使えなかった情報を併記

## 4. Power BIとData Agent

- Direct LakeモデルはLakehouseのテーブルを直接参照
- 指標は DAX メジャーで定義し、テーブルには持たせない
- Data Agentには右サイジングを断定しない指示と、コストが推定か契約単価かを明示する指示を設定
