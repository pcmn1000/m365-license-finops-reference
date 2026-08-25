# 用語と役割

このリポジトリで使う Microsoft 365、Microsoft Fabric、Power BI、データモデルの用語を、
**一般的な意味**と**この構成での役割**に分けて説明します。

## 全体を構成するサービス

| 用語 | 一般的な意味 | この構成での役割 |
| --- | --- | --- |
| Microsoft Entra ID | ユーザー、アプリ、認証、組織属性を管理するID基盤 | ユーザー、部門、拠点、役職、アカウント状態、ライセンス割り当ての取得元 |
| Microsoft Graph | Microsoft 365やEntraのデータへアクセスするREST API | ユーザー、SKU、サービスプラン、Usage ReportsをNotebookから取得 |
| Azure Key Vault | シークレットや証明書を保管するAzureサービス | GraphアプリのクライアントシークレットをNotebookへ安全に渡す |
| Microsoft Fabric | データ取り込み、保存、分析、AIをまとめたSaaS分析基盤 | Notebook、Lakehouse、Pipeline、セマンティックモデル、レポート、Data Agentを配置 |
| Power BI | データモデルとレポートを作成・共有するBIサービス | 4ページのライセンスFinOpsレポートを表示 |
| SharePoint Online | ファイルやリストを共同管理するMicrosoft 365サービス | 契約単価Excelの保管場所。単価管理が不要なら省略可能 |

## Microsoft 365ライセンスの用語

| 用語 | 意味 | この構成での扱い |
| --- | --- | --- |
| SKU | 購入・割り当ての単位となるライセンス製品 | Microsoft 365 E5、Copilot、Teams Premiumなど |
| `skuId` | SKUを一意に識別するGUID | `dim_sku`、割り当て、単価を結ぶ内部キー |
| `skuPartNumber` | Graphや管理センターで使われるSKUコード | Excel単価表との突合キー。例: `MICROSOFT_365_COPILOT` |
| License Name | 利用者向けの製品表示名 | レポートとData Agentで通常使う名称 |
| Purchased Seats | 購入済みのライセンス数 | `prepaidUnits.enabled` から取得 |
| Assigned Seats | ユーザーへ割り当てられたライセンス数 | `consumedUnits` またはユーザー×SKU行から計算 |
| Available Seats | 現在割り当て可能な残数 | 購入数 − 割り当て数 |
| サービスプラン | SKUに含まれる個別機能・権利 | E5内のPIM、Defender、Purview、Teams Phoneなど |
| `servicePlanId` | サービスプランを一意に識別するGUID | SKU、機能、ユーザー設定を結ぶ内部キー |
| `servicePlanName` | Graphや管理センターで使われる内部品番 | `サービスプラン品番` として必要時に表示 |
| 機能名 | 複数の内部品番を利用者向けにまとめた名称 | `用途（一般製品名）` の形式で25の業務機能として表示 |
| `assignedLicenses` | ユーザーに割り当てられたSKUの一覧 | ユーザー×SKUとユーザー×サービスプランを作成 |
| `disabledPlans` | 割り当て済みSKU内で無効化されたサービスプランID | 機能の有効・無効判定に使用 |
| `licenseAssignmentStates` | 直接/グループ割り当て、状態、割当元など | `fact_license_assignment` に保存 |

## 利用実績の用語

| 用語 | 意味 | この構成での扱い |
| --- | --- | --- |
| Usage Reports | Microsoft 365が生成する利用状況の集計レポート | D180を日次取得。リアルタイムの操作ログではない |
| `reportRefreshDate` | Microsoft側でUsage Reportが更新された日 | データの実際の鮮度を示す日付 |
| Last Activity Date | 対象サービスで最後に活動した日 | SKUごとの利用状態分類に使用 |
| Active | 最終利用から30日以内 | `utilization_status` の分類値 |
| LowUsage | 最終利用から31〜89日 | `utilization_status` の分類値 |
| Dormant | 最終利用から90日以上 | `utilization_status` の分類値 |
| NeverUsed | 対応する利用実績がない | 利用していないと断定せず、Usage Report上の記録なしとして扱う |
| DisabledAccount | Entraアカウントが無効 | サインインできないユーザーの割り当てとして分類 |
| Copilot Prompts | Copilotへ送信したプロンプト数 | Copilot Usage Reportから取得。0は欠損ではなく実測値 |
| レポート匿名化 | Usage Reportsでユーザー名を隠す設定 | 有効だとUPNでユーザーに結合できず、ユーザー別利用分析は空になる |

## Fabricの用語

| 用語 | 一般的な意味 | この構成での役割 |
| --- | --- | --- |
| Fabric Capacity | Fabric処理に計算資源を提供する容量 | F8を使用。Paused中はNotebook、Direct Lake、Data Agentが動かない |
| F SKU | Fabric Capacityの課金・性能レベル | 現在はF8。Active中は課金対象 |
| Workspace | Fabricアイテムをまとめ、権限を管理する単位 | 全アイテムを `M365 License FinOps` ワークスペースに配置 |
| Lakehouse | ファイルとDeltaテーブルを保持するFabricデータストア | 最新マスタ5本、日次ファクト5本、単価ExcelへのShortcutを保持 |
| OneLake | Fabric全体で共通の論理データレイク | Direct LakeがLakehouseのDeltaデータを参照 |
| Delta Lake / Deltaテーブル | Parquetにトランザクション管理を加えた表形式 | 日次スナップショットの保存形式 |
| Notebook | Python/PySparkなどを実行するFabricアイテム | Graph取得、整形、分類、Delta書き込みを担当 |
| Pipeline | データ処理を順序・スケジュールで実行するアイテム | 同期Notebookを毎日02:00 JSTに実行 |
| OneLake Shortcut | 外部や別OneLakeのデータをコピーせず参照する仕組み | SharePoint上の単価ExcelをLakehouse Files配下に表示 |
| Data Agent | Fabricデータを自然言語で照会するAIアイテム | セマンティックモデルにDAXを生成し、在庫・利用・E5機能へ回答 |
| Agent Store | Microsoft 365 Copilotでエージェントを発見・利用する場所 | Data Agentを追加公開するとTeams/Copilotから利用可能 |

## Power BIとモデルの用語

| 用語 | 一般的な意味 | この構成での役割 |
| --- | --- | --- |
| セマンティックモデル | テーブル、関係、指標、表示名を定義する分析モデル | Lakehouseデータを業務用語とDAX指標で公開 |
| Direct Lake | OneLake上のDeltaデータを直接参照するPower BIモード | インポート更新をせずLakehouseの最新データを参照 |
| DAX | Power BIモデルの計算式言語 | 割当数、利用率、月額コスト、E5機能の設定状況を計算 |
| メジャー | フィルター条件に応じて動的に計算されるDAX指標 | `Monthly Cost`、`# Active Seats`、`有効ユーザー数`など |
| リレーションシップ | テーブル同士をキーで関連付けるモデル定義 | User、SKU、Price、Service Planをファクトへ接続 |
| TMDL | セマンティックモデルをテキストで表す定義形式 | `demo/M365LicenseFinOps.SemanticModel` に保存 |
| PBIR | Power BIレポートをJSONファイル群で表す定義形式 | `demo/M365LicenseFinOps.Report` に保存 |
| Visual | Power BIレポート上の表、グラフ、カード、スライサー | Pythonスクリプトで34個を生成 |
| Slicer | レポートを選択値で絞り込むUI | ライセンスや拠点の選択に使用 |
| Drilldown | 階層を展開して詳細レベルへ移る操作 | 機能名から複数のサービスプラン品番を展開 |

## データモデルの用語

| 用語 | 意味 | この構成での例 |
| --- | --- | --- |
| ディメンション (`dim_`) | 分析対象の名称や属性を持つマスタ系テーブル | `dim_user`、`dim_sku`、`dim_service_plan` |
| ファクト (`fact_`) | 日付やユーザーなどの粒度で発生事実を持つテーブル | `fact_license_assignment`、`fact_license_utilization` |
| ブリッジ (`bridge_`) | 多対多関係を結ぶ中間テーブル | `bridge_sku_service_plan` |
| 粒度 | 1行が何を表すか | ユーザー×SKU、ユーザー×サービスプランなど |
| スナップショット | ある日時点の状態を保存したもの | 5本のファクトテーブルにある `snapshot_date` |
| 冪等 | 同じ処理を繰り返しても結果が重複しない性質 | 同日行を削除してから追記する書き込み方式 |
| 内部キー | 表示には使わない、結合用の識別子 | `user_id`、`sku_id`、`service_plan_id` |
| 表示名 | 人が理解できるように付けた名称 | License Name、機能名、日本語列名 |

## 単価の用語

| 用語 | 意味 | この構成での扱い |
| --- | --- | --- |
| Monthly Unit Price | 1ユーザー・1か月あたりの単価 | `dim_sku_price.unit_price_monthly` |
| Public List Price | Microsoft公開定価 | 契約単価がない場合のフォールバック。推定値として表示 |
| Contract Price | 顧客契約に基づく単価 | SharePoint ExcelのApproved行から取得 |
| Price Source | 単価がどこから来たか | 公開定価かSharePoint単価表かを保持 |
| Effective From | 単価の適用開始日 | 現行の単価行に保存 |
| Monthly Cost | 割り当て済みライセンスの推定月額 | 割り当て行ごとに関連単価を合計するDAXメジャー |

## 認証と権限の用語

| 用語 | 意味 | この構成での役割 |
| --- | --- | --- |
| アプリ登録 | Entra IDでアプリのIDと権限を定義すること | NotebookがGraphへアプリケーション認証するために作成 |
| Application Permission | ユーザーではなくアプリ自身に与えるGraph権限 | `User.Read.All`など4権限を使用 |
| Admin Consent | 管理者がテナント全体で権限利用を承認すること | Graph API実行前に必要 |
| Client ID | アプリ登録を識別するGUID | OAuthトークン取得時に使用 |
| Client Secret | アプリが自身を証明する秘密値 | Key Vaultに保存し、GitやNotebookへ直書きしない |
| RBAC | ロールによるアクセス制御 | Key VaultやFabricワークスペースへの権限付与 |
| SSO | サインイン中ユーザーのIDでデータへアクセスする方式 | Direct Lakeの閲覧時に利用者のデータ権限を確認 |
| RLS / OLS | 行単位 / オブジェクト単位のPower BIセキュリティ | モデルに設定した場合、Power BIとData Agentの回答にも適用 |

## リポジトリ内の定義形式

| パス | 役割 |
| --- | --- |
| `demo/SyncM365LicenseUsage.py` | Graph取得とLakehouse同期のNotebookソース |
| `demo/SyncM365PriceMaster.py` | SharePoint単価Excelの検証・反映 |
| `demo/M365LicenseFinOps.SemanticModel/` | TMDL形式のセマンティックモデル |
| `demo/M365LicenseFinOps.Report/` | PBIR形式のPower BIレポート |
| `demo/M365LicenseFinOps.DataAgent/` | Data Agentの指示、選択項目、few-shot |
| `demo/pipeline-content.json` | 日次Pipeline定義 |
| `tools/deploy_fabric_items.ps1` | 環境IDを置換しFabricアイテムを配置 |
| `tools/create_price_master.py` | 単価マスタExcelを生成 |
