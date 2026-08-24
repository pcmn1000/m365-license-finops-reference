# デモ環境への反映

## デモの現行リソース

| リソース | 名前 |
| --- | --- |
| Fabric workspace | `M365 License FinOps` |
| Fabric capacity | `fcm365licensefinopsjpe001` (F2, Japan East) |
| Lakehouse | `M365LicenseFinOps` |
| Notebook | `SyncM365LicenseUsage` |
| Pipeline | `DailyM365LicenseSync` |
| Semantic model | `M365 License FinOps Model` |
| Report | `M365 License FinOps Report` |

## 今回の変更

1. `License-Price-Master.xlsx`を作成
2. SPO/OneDriveの管理フォルダーへアップロード
3. Lakehouse `Files/reference/license-prices`にShortcutを作成
4. Notebookを外部価格マスタ優先に変更
5. Excel検証に失敗した場合は、既存価格またはデモ用公開価格へフォールバック
6. Pipeline実行後、`dim_sku_price`とPower BIの月額コストを確認

## デモ向け簡略化

デモでは現在の`dim_sku_price`スキーマを維持し、既存のDirect Lakeモデルを変更しません。
本番化時は`dim_license_price_history`へ拡張し、有効期間と承認情報を保持します。

## 確認項目

- Shortcut配下からExcelが読み取れる
- `Approved`行だけが価格候補になる
- SKUコードがGraphの`skuPartNumber`と一致する
- 単価を変更して再実行するとPower BIの月額コストへ反映される
- 不正な行では本番価格が破壊されず、エラーが出る
- Fabric容量が`Active`である
