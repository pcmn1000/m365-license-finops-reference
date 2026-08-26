# Microsoft 365 License FinOps Reference Architecture

Microsoft 365 のライセンス在庫、ユーザー割り当て、サービス利用状況、契約単価を
Microsoft Fabric に統合し、Power BI から分析する構成です。

**動くものと、その作り方を丸ごと共有するためのリポジトリです。**
Notebook のソース、セマンティックモデルの TMDL、レポートの PBIR、Data Agent、
Pipeline の定義、環境固有IDを置換してFabricへ配置するスクリプトが入っています。
[構築手順](docs/setup.md) に沿えば、自分のテナントに同じものを作れます。

デモレポートは匿名で閲覧できます。
[M365 License FinOps Public Report](https://app.powerbi.com/view?r=eyJrIjoiN2M2NWFlYTMtYTNhNC00ODA0LTk2MTYtMTEwNTJjOWYxNThkIiwidCI6IjFhZDFjY2Y1LTU5YjgtNDc0ZS1iYjg5LWVlMDBjOTFlZGQ0OCJ9)

Fabric容量を停止していても操作できる固定データ版もあります。
[M365 License FinOps Interactive Demo](https://pcmn1000.github.io/m365-license-finops-reference/)
は4ページ、フィルター、グラフ選択、ユーザー詳細、
`E5機能 → サービスプラン品番 → ユーザー`の階層展開をブラウザーだけで実行します。

この構成は次の問いに答えます。

- 何を何ライセンス購入し、誰に割り当てているか
- ID保護、脅威対策、法務・監査など、E5の高度機能が誰に有効か
- Exchange、Teams、OneDrive、SharePoint、Copilot を利用しているか
- 部門、拠点別にいくら負担しているか
- 未利用、低利用のライセンスはどれくらいあるか

> [!IMPORTANT]
> Microsoft Graph のライセンス API は契約単価を返しません。また、Microsoft 365
> Usage Reports はリアルタイムの操作ログではありません。本構成では、データごとに
> 異なる更新特性を明示して、誤った「リアルタイム」表現を避けます。

## 現在の構成

実際に動いているのは次の構成です。Notebook 1本が Microsoft Graph を叩き、
Lakehouse へ最新マスタ5表と日次ファクト5表を書き、Direct Lake モデル経由で
Power BI と Data Agent が読みます。
中間レイヤーも外部システム連携もありません。

![Microsoft 365 ライセンス FinOps の現行アーキテクチャ。Microsoft GraphとSharePointからFabricへ取り込み、Lakehouse、セマンティックモデル、Power BI、Data Agent、Microsoft 365 Copilotへ接続する構成図。](docs/images/architecture-overview.png)

背景は Microsoft Foundry の `FLUX.2-pro` で生成し、製品アイコンはMicrosoft公式配布
アセットを合成しています。[図の生成元とアイコン出典](docs/images/README.md)も参照してください。
次のMermaidは同じ構成を更新しやすい形式で表したものです。

```mermaid
flowchart LR
    subgraph SRC["取得元"]
        GRAPH["Microsoft Graph<br/>users / subscribedSkus / Usage Reports"]
        SPO["SharePoint Online<br/>License-Price-Master.xlsx"]
    end

    subgraph FABRIC["Microsoft Fabric ワークスペース 1つ"]
        NB1["Notebook<br/>SyncM365LicenseUsage"]
        NB2["Notebook<br/>SyncM365PriceMaster"]
        CONN["Web connection<br/>Graph認証情報"]
        SC["OneLake Shortcut<br/>Files/reference"]
        LH[("Lakehouse<br/>Deltaテーブル 10本<br/>階層なし・フラット")]
        PIPE["Pipeline<br/>DailyM365LicenseSync<br/>毎日 02:00 JST"]
        MODEL["Direct Lake<br/>セマンティックモデル"]
    end

    subgraph USE["利用"]
        PBI["Power BI レポート<br/>4ページ"]
        AGENT["Fabric Data Agent<br/>自然言語Q&A"]
    end

    GRAPH --> NB1 --> LH
    CONN -.-> NB1
    SPO --> SC --> NB2 --> LH
    PIPE --> NB1
    LH --> MODEL --> PBI
    MODEL --> AGENT
```

### 作ったもの

| 種別 | 名前 | 役割 |
| --- | --- | --- |
| Lakehouse | `M365LicenseFinOps` | Deltaテーブル10本 |
| Notebook | `SyncM365LicenseUsage` | Graph取得と全テーブル書き込み |
| Notebook | `SyncM365PriceMaster` | SPOのExcelを検証して単価へ反映 |
| Pipeline | `DailyM365LicenseSync` | Notebookを日次実行 |
| Semantic model | `M365 License FinOps Model` | Direct Lake |
| Report | `M365 License FinOps Report` | 4ページ / 34ビジュアル |
| Public semantic model | `M365 License FinOps Public Model` | Web公開専用のImport複製 |
| Public report | `M365 License FinOps Public Report` | 匿名公開する4ページの複製 |
| Data Agent | `M365LicenseFinOpsAgent` | 在庫、割り当て、利用、コスト、E5機能を自然言語で照会 |

Fabric 容量は F8 (Japan East) です。Graph のアプリケーション権限は
`User.Read.All`、`LicenseAssignment.Read.All`、`Organization.Read.All`、
`Reports.Read.All` の4つです。

### Lakehouseのテーブル

Bronze/Silver/Gold のような層は作らず、10本のDeltaテーブルをフラットに並べています。

| テーブル | 内容 |
| --- | --- |
| `dim_user` | ユーザー、部門、拠点、役職、アカウント状態 |
| `dim_sku` | SKUコード、購入数、消費数 |
| `dim_sku_price` | SKU別の単価 |
| `dim_service_plan` | 内部プランと日本語の業務機能名・カテゴリ |
| `bridge_sku_service_plan` | SKUとサービスプランの対応 |
| `fact_license_assignment` | ユーザー×SKUの割り当て |
| `fact_service_entitlement` | ユーザー×サービスプランの有効/無効 |
| `fact_license_utilization` | 利用状態、最終利用日、非アクティブ日数 |
| `fact_m365_usage` | Exchange/OneDrive/SharePoint/Teamsの最終利用日 |
| `fact_copilot_usage` | Copilotの最終利用日、プロンプト数、利用日数 |

ユーザー、SKU、サービスプラン、対応表、単価は最新値で上書きします。
割り当て、機能設定、M365/Copilot利用実績、利用状態は `snapshot_date` ごとに保持し、
同じ日付の行を削除してから追記します。

## 最低限で始めるには

上記のうち、Notebook 1本と Lakehouse と Power BI だけあれば動きます。

1. Fabric ワークスペースと Lakehouse を作る
2. Entra ID にアプリ登録し、Graph のアプリケーション権限4つを付与する
3. `tools/deploy_fabric_items.ps1` を実行してGraph用Fabric Web接続と各アイテムを作る
4. 初回だけ、Graph用接続をNotebookの **Global permissions** から **Connect** する
5. **Current Notebook** の接続IDを `-GraphConnectionId` に指定して再実行する

単価が不要なら SharePoint と Shortcut と `SyncM365PriceMaster` は省略できます。
Notebook にはパブリック定価が定義済みで、Excel が無ければそのまま使われます。
Pipeline も後回しにして、まず手動実行で構いません。

## データの更新特性

| データ | 現在の取得方式 | 更新 | 実際の鮮度を決めるもの |
| --- | --- | --- | --- |
| ユーザー、部門、拠点、ライセンス割り当て | `/users` 全件取得 | 日次 | Graph の結果整合性、Entra 更新 |
| SKU購入数、消費数、サービスプラン | `/subscribedSkus` | 日次 | Microsoft 365 ライセンス処理 |
| M365サービス利用実績 | `getOffice365ActiveUserDetail` | 日次 | Microsoft側のレポート生成 |
| Copilot利用実績 | `getMicrosoft365CopilotUsageUserDetail` | 日次 | Microsoft側のレポート生成 |
| 契約単価 | SPO Excel + Shortcut + 検証Notebook | 承認後に手動実行 | ファイル承認、Notebook実行 |
| Power BI表示 | Direct Lake | Delta反映後、通常は数分以内 | モデルキャッシュ、容量状態 |

ライセンスと組織属性は日次、Usage ReportsはMicrosoft側の更新周期に従います。
`/users/delta` は使わず全件取得しています。数千ユーザー規模までは全件で十分です。

## ドキュメント

初めて読む場合は、次の順序で確認してください。

| 順序 | ドキュメント | 分かること |
| --- | --- | --- |
| 1 | [構築手順](docs/setup.md) | 必要な権限、作成順序、デプロイ、動作確認 |
| 2 | [詳細アーキテクチャ](docs/architecture.md) | データ経路、役割分担、保存方式、マッピング |
| 3 | [用語と役割](docs/glossary.md) | Microsoft 365、Fabric、Power BI、モデルの用語 |
| 4 | [Microsoft Graph / API取得範囲](docs/api-capabilities.md) | 実際に呼ぶAPI、取得項目、保存先 |
| 5 | [単価マスタとSPO Shortcut](docs/price-master.md) | 単価Excelの仕様と反映方法 |

- [構築手順](docs/setup.md) — 自分のテナントに同じものを作る手順
- [詳細アーキテクチャ](docs/architecture.md) — 取得API、書き込み方式、テーブル、単価とサービスプランのマッピング
- [用語と役割](docs/glossary.md) — Microsoft 365、Fabric、Power BI、データモデルの用語集
- [Microsoft Graph / API取得範囲](docs/api-capabilities.md)
- [単価マスタとSPO Shortcut](docs/price-master.md)
- [人・部門・拠点・コストセンターの管理](docs/master-data.md)
- [運用、監視、セキュリティ](docs/operations.md)
- [デモ環境への反映](docs/demo-implementation.md)

## リポジトリの構成

| パス | 内容 |
| --- | --- |
| `demo/SyncM365LicenseUsage.py` | Graph取得とLakehouse書き込みのNotebookソース |
| `demo/SyncM365PriceMaster.py` | SPOのExcelを検証して単価へ反映するNotebookソース |
| `demo/BuildM365LicenseFinOpsReport.py` | PBIRレポートを生成するスクリプト |
| `demo/M365LicenseFinOps.SemanticModel/` | Direct LakeモデルのTMDL一式 |
| `demo/M365LicenseFinOps.Report/` | レポートのPBIR一式 |
| `demo/M365LicenseFinOps.DataAgent/` | Data Agentの指示、データソース選択、few-shot |
| `demo/pipeline-content.json` | 日次Pipelineの定義 |
| `tools/deploy_fabric_items.ps1` | 環境IDを置換し、Fabricアイテムを作成・更新するスクリプト |
| `tools/deploy_public_report.ps1` | TMDLを実行時にImportへ変換し、Web公開専用モデルとレポートを配置 |
| `tools/export_static_demo_data.ps1` | 最新スナップショットをGitHub Pages用の固定データへ書き出すスクリプト |
| `docs/index.html` / `docs/static-demo/` | 容量非依存の対話型固定データレポート |
| `tools/create_price_master.py` | 単価マスタExcelの生成スクリプト |
| `sample-data/License-Price-Master.xlsx` | 単価マスタの記入例 |

## 設計上の結論

1. **Graphを価格マスタとして扱わない**: Graphは数量と権利を返しますが、契約単価は返しません。
2. **指標はテーブルではなくメジャーで持つ**: 集計テーブルを作らないぶん構成が減り、定義変更もモデル側だけで済みます。
3. **Usageをリアルタイムと呼ばない**: Usage Reportsの`reportRefreshDate`を鮮度指標として扱います。
4. **サービスの有効化と利用実績を分ける**: 機能が有効なことと、実際に使っていることは別の列で表示します。
5. **未設定を推測で埋めない**: 部門や拠点が空なら `Unassigned` として表示し、未整備の量が見えるようにします。

## 公式リファレンス

- [List subscribedSkus](https://learn.microsoft.com/graph/api/subscribedsku-list)
- [Microsoft 365 usage reports overview](https://learn.microsoft.com/graph/api/resources/report)
- [OneLake shortcuts](https://learn.microsoft.com/fabric/onelake/onelake-shortcuts)
- [Create a OneDrive or SharePoint shortcut](https://learn.microsoft.com/fabric/onelake/create-onedrive-sharepoint-shortcut)
- [Direct Lake overview](https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview)
