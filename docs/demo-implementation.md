# デモ環境への反映

## デモの現行リソース

| リソース | 名前 |
| --- | --- |
| Fabric workspace | `M365 License FinOps` |
| Fabric capacity | `fcm365licensefinopsjpe001` (F2, Japan East) |
| Lakehouse | `M365LicenseFinOps` |
| Notebook | `SyncM365LicenseUsage` |
| Price notebook | `SyncM365PriceMaster` (`673f5bd4-1f3b-4f98-a547-b1109e37f32d`) |
| Pipeline | `DailyM365LicenseSync` |
| Semantic model | `M365 License FinOps Model` |
| Report | `M365 License FinOps Report` |
| SPO site | `M365 License FinOps Data` |
| Fabric connection | `M365FinOpsSPO admin` (`673c247a-7b90-4865-b78b-a703191d7515`) |
| OneLake Shortcut | `Files/reference/sharepoint-license-prices` |

## 今回の変更

1. `License-Price-Master.xlsx`を作成
2. private SPOサイト`M365 License FinOps Data`へアップロード
3. `Shared Documents/FinOps/LicensePrices`を管理フォルダーとして使用
4. Lakehouse `Files/reference/sharepoint-license-prices`にShortcutを作成
5. `SyncM365PriceMaster`でExcelだけを検証・反映
6. `SyncM365LicenseUsage`はライセンス/組織/Usageを日次同期

SPO管理フォルダー:

[SPO LicensePrices folder](https://m365cpi37573032.sharepoint.com/sites/M365LicenseFinOpsData/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FM365LicenseFinOpsData%2FShared%20Documents%2FFinOps%2FLicensePrices)

## デモ向け簡略化

デモでは現在の`dim_sku_price`スキーマを維持し、既存のDirect Lakeモデルを変更しません。
本番化時は`dim_license_price_history`へ拡張し、有効期間と承認情報を保持します。

## 確認項目

- Shortcut配下からExcelが読み取れる
- ShortcutからダウンロードしたExcelに2シート、`LicensePrices`テーブル、4価格行がある
- `Approved`行だけが価格候補になる
- SKUコードがGraphの`skuPartNumber`と一致する
- 単価を変更して再実行するとPower BIの月額コストへ反映される
- 不正な行では本番価格が破壊されず、エラーが出る
- Fabric容量が`Active`である

## 更新頻度

- ライセンス在庫、割り当て、部門、拠点: 日次
- Microsoft 365/Copilot利用実績: 日次。ただしソース側レポート更新日に依存
- 単価: SPO承認後に`SyncM365PriceMaster`を手動またはPower Automateから起動
- 単価の定期照合: 日次Pipelineでも再確認

`DailyM365LicenseSync`は毎日02:00、`Tokyo Standard Time`で有効です。

## Usage Reportsの匿名化

このデモテナントではMicrosoft 365 Usage Reportsのユーザー名が匿名化されています。
匿名化されたレポートはUPNでユーザーへ結合できないため、Notebookは次の動作をします。

- ライセンス在庫、ユーザー、組織属性、サービスプラン、単価は通常どおり更新
- M365/Copilotのユーザー別Usage行は空として扱う
- 実行結果へ`m365_report_names_concealed`と
  `copilot_report_names_concealed`を出力
- Power BIではUsageの鮮度/利用不可を表示し、0件を「未利用」と断定しない

ユーザー別利用分析が必要な本番環境では、プライバシー責任者の承認、RLS、監査、
保持期間を合意したうえでMicrosoft 365管理センターのレポート匿名化設定を変更します。
