# デモ環境への反映

## デモの現行リソース

| リソース | 名前 |
| --- | --- |
| Fabric workspace | `M365 License FinOps` |
| Fabric capacity | `fcm365licensefinopsjpe001` (F8, Japan East) |
| Lakehouse | `M365LicenseFinOps` |
| Notebook | `SyncM365LicenseUsage` |
| Price notebook | `SyncM365PriceMaster` (`673f5bd4-1f3b-4f98-a547-b1109e37f32d`) |
| Pipeline | `DailyM365LicenseSync` |
| Semantic model | `M365 License FinOps Model` |
| Report | `M365 License FinOps Report`（4ページ） |
| Public semantic model | `M365 License FinOps Public Model` (`5e81798e-50e2-4ce5-a86f-c44b38051612`) |
| Public report | `M365 License FinOps Public Report` (`dd00c651-589f-45d4-aff2-73becb9c06c0`) |
| Public SQL connection | `M365 FinOps Lakehouse SQL Public` (`505a9e85-d037-480b-b967-a2a7fe2b3178`) |
| SPO site | `M365 License FinOps Data` |
| Fabric connection | `M365FinOpsSPO admin` (`673c247a-7b90-4865-b78b-a703191d7515`) |
| OneLake Shortcut | `Files/reference/sharepoint-license-prices` |
| Data Agent | `M365LicenseFinOpsAgent` |

Lakehouse の Delta テーブルは10本で、Bronze/Silver/Gold のような層は作っていません。

匿名公開URL:

[M365 License FinOps Public Report](https://app.powerbi.com/view?r=eyJrIjoiN2M2NWFlYTMtYTNhNC00ODA0LTk2MTYtMTEwNTJjOWYxNThkIiwidCI6IjFhZDFjY2Y1LTU5YjgtNDc0ZS1iYjg5LWVlMDBjOTFlZGQ0OCJ9)

```text
dim_user  dim_sku  dim_sku_price  dim_service_plan  bridge_sku_service_plan
fact_license_assignment  fact_service_entitlement  fact_license_utilization
fact_m365_usage  fact_copilot_usage
```

利用率、月額コスト、削減可能額は集計テーブルを作らず、
セマンティックモデルの DAX メジャーで計算しています。

## 今回の変更

1. `License-Price-Master.xlsx`を作成
2. private SPOサイト`M365 License FinOps Data`へアップロード
3. `Shared Documents/FinOps/LicensePrices`を管理フォルダーとして使用
4. Lakehouse `Files/reference/sharepoint-license-prices`にShortcutを作成
5. `SyncM365PriceMaster`でExcelだけを検証・反映
6. `SyncM365LicenseUsage`はライセンス/組織/Usageを日次同期
7. Direct Lakeモデルへ`Service Plan`と`Service Entitlement`を追加
8. Power BIへ`E5機能チェック`ページを追加

SPO管理フォルダー:

[SPO LicensePrices folder](https://m365cpi37573032.sharepoint.com/sites/M365LicenseFinOpsData/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FM365LicenseFinOpsData%2FShared%20Documents%2FFinOps%2FLicensePrices)

## デモ向け簡略化

`dim_sku_price` は有効期間を持たず、当日の単価だけを保持します。
過去の価格で再計算することはできません。

## 確認項目

- Shortcut配下からExcelが読み取れる
- ShortcutからダウンロードしたExcelに2シート、`LicensePrices`テーブル、4価格行がある
- `Approved`行だけが価格候補になる
- SKUコードがGraphの`skuPartNumber`と一致する
- 単価を変更して再実行するとPower BIの月額コストへ反映される
- 不正な行では本番価格が破壊されず、エラーが出る
- Fabric容量が`Active`である

## E5機能チェックページの読み方

Graphの`servicePlanName`は監査・トラブルシューティング用にモデルへ保持しますが、
レポートには直接表示しません。E5/E3判断に関係する内部プランだけを、
`高度なID保護・特権管理（Microsoft Entra ID P2）`、
`端末の脅威検知・対応（Microsoft Defender for Endpoint Plan 2）`など、
用途と一般的なMicrosoft製品名が同時に分かる業務機能へ集約します。

ページでは次を確認します。

- Microsoft 365 E5の対象ユーザー数
- E5/E3判断に使う業務機能数
- 全対象ユーザーで有効な機能数
- 一部または全対象ユーザーで無効な機能数
- 業務機能ごとの有効ユーザー数、無効ユーザー数、設定状況

ユーザー×内部プランの行数はKPIにしません。複数の内部プランが同じ業務機能を
構成する場合も、利用者には1つの業務機能として表示します。未登録の技術・付帯プランは
通常画面から除外します。

ここでの「有効」はライセンス設定を示し、実利用の証拠ではありません。全員有効でも、
Usage、Purview/Defenderポリシー、特権ロール、例外、契約条件を確認してから
E3/E5を判断します。

`FLOW_FREE`もGraphから検出されますが、無料SKUのため価格マスタには含めず、契約コストの
対象外として扱います。

## 更新頻度

- ライセンス在庫、割り当て、部門、拠点: 日次
- Microsoft 365/Copilot利用実績: 日次。ただしソース側レポート更新日に依存
- 単価: SPO承認後に`SyncM365PriceMaster`を手動実行
- 単価の定期照合: 日次Pipelineでも再確認

`DailyM365LicenseSync`は毎日02:00、`Tokyo Standard Time`で有効です。
公開用Importモデルは毎日03:00、`Tokyo Standard Time`で有効です。

## Usage Reportsの匿名化

このデモテナントでは Microsoft 365 管理センターで**匿名化を解除済み**です。
そのため UPN でユーザーと結合でき、ユーザー別の利用実績が見えます。

匿名化が有効なテナントでは Notebook は次の動作をします。

- ライセンス在庫、ユーザー、組織属性、サービスプラン、単価は通常どおり更新
- M365/Copilotのユーザー別Usage行は空として扱う
- 実行結果へ`m365_report_names_concealed`と
  `copilot_report_names_concealed`を出力
- Power BIではUsageの鮮度/利用不可を表示し、0件を「未利用」と断定しない

本番環境でユーザー別分析を行うなら、プライバシー責任者の承認、RLS、監査、
保持期間を合意したうえで匿名化設定を変更します。
