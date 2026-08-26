(() => {
  "use strict";

  const data = window.STATIC_DEMO_DATA;
  const reportCanvas = document.getElementById("reportCanvas");
  const licenseFilter = document.getElementById("licenseFilter");
  const locationFilter = document.getElementById("locationFilter");
  const userSearch = document.getElementById("userSearch");
  const pageTitle = document.getElementById("pageTitle");
  const pageEyebrow = document.getElementById("pageEyebrow");
  const filterSummary = document.getElementById("filterSummary");
  const drawer = document.getElementById("detailDrawer");
  const drawerOverlay = document.getElementById("drawerOverlay");
  const drawerTitle = document.getElementById("drawerTitle");
  const drawerKicker = document.getElementById("drawerKicker");
  const drawerContent = document.getElementById("drawerContent");
  const toast = document.getElementById("toast");

  if (!data) {
    reportCanvas.innerHTML = '<div class="error-state">固定データを読み込めませんでした。</div>';
    return;
  }

  const state = {
    page: "summary",
    skuId: "all",
    location: "all",
    search: "",
    expandedFeatures: new Set(),
    expandedPlans: new Set()
  };
  const charts = [];
  let toastTimer;

  const usersById = new Map(data.users.map((row) => [row.userId, row]));
  const skusById = new Map(data.skus.map((row) => [row.skuId, row]));
  const pricesBySku = new Map(data.prices.map((row) => [row.skuId, Number(row.monthlyUnitPrice) || 0]));
  const utilizationByUser = groupBy(data.utilization, "userId");
  const assignmentsByUser = groupBy(data.assignments, "userId");
  const entitlementsByUser = groupBy(data.entitlements, "userId");
  const m365ByUser = new Map(data.m365Usage.map((row) => [row.userId, row]));
  const copilotByUser = new Map(data.copilotUsage.map((row) => [row.userId, row]));
  const plansById = new Map(data.servicePlans.map((row) => [row.servicePlanId, row]));
  const e5Sku = data.skus.find((row) => /\bE5\b/i.test(row.licenseName));

  const pageMeta = {
    summary: { title: "ライセンス運用サマリー", eyebrow: "M365 License FinOps" },
    department: { title: "部門比較", eyebrow: "コストと利用状況" },
    features: { title: "E5機能チェック", eyebrow: "機能・品番・ユーザー" },
    users: { title: "ユーザー・Copilot詳細", eyebrow: "利用状況" }
  };
  const statusPriority = ["Active", "LowUsage", "Dormant", "DisabledAccount", "NeverUsed"];
  const statusLabels = {
    Active: "Active",
    LowUsage: "低利用",
    Dormant: "休眠",
    DisabledAccount: "無効アカウント",
    NeverUsed: "未利用"
  };

  function groupBy(rows, key) {
    const result = new Map();
    rows.forEach((row) => {
      const value = row[key];
      if (!result.has(value)) result.set(value, []);
      result.get(value).push(row);
    });
    return result;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function asText(value, fallback = "Unassigned") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function asNumber(value) {
    return Number(value) || 0;
  }

  function unique(values) {
    return [...new Set(values)];
  }

  function formatNumber(value, digits = 0) {
    return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits }).format(asNumber(value));
  }

  function formatYen(value) {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency: "JPY",
      maximumFractionDigits: 0
    }).format(asNumber(value));
  }

  function formatPercent(value) {
    return new Intl.NumberFormat("ja-JP", {
      style: "percent",
      maximumFractionDigits: 1
    }).format(Number.isFinite(value) ? value : 0);
  }

  function formatDate(value) {
    if (!value) return "—";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value).slice(0, 10);
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(parsed);
  }

  function getCssColors() {
    const styles = getComputedStyle(document.documentElement);
    const get = (name) => styles.getPropertyValue(name).trim();
    return {
      bg: get("--cp-bg"),
      surface: get("--cp-surface"),
      surfaceSoft: get("--cp-surface-soft"),
      border: get("--cp-border"),
      text: get("--cp-text"),
      muted: get("--cp-text-muted"),
      accent: get("--cp-accent"),
      accentSoft: get("--cp-accent-soft"),
      success: get("--cp-success"),
      danger: get("--cp-danger"),
      warning: get("--cp-warning"),
      link: get("--cp-link")
    };
  }

  function getUserStatus(userId, rows = utilizationByUser.get(userId) || []) {
    const statuses = new Set(rows.map((row) => row.utilizationStatus));
    return statusPriority.find((status) => statuses.has(status)) || "NeverUsed";
  }

  function statusBadge(status) {
    const cssClass = {
      Active: "is-active",
      LowUsage: "is-low",
      Dormant: "is-dormant",
      DisabledAccount: "is-disabled",
      NeverUsed: "is-never"
    }[status] || "";
    return `<span class="status-badge ${cssClass}">${escapeHtml(statusLabels[status] || status)}</span>`;
  }

  function enabledBadge(enabled, partial = false) {
    if (partial) return '<span class="status-badge is-partial">一部無効</span>';
    return enabled
      ? '<span class="status-badge is-enabled">有効</span>'
      : '<span class="status-badge is-disabled">無効</span>';
  }

  function userMatches(user) {
    if (state.location !== "all" && asText(user.officeLocation) !== state.location) return false;
    const query = state.search.trim().toLocaleLowerCase("ja-JP");
    if (!query) return true;
    return [user.displayName, user.userPrincipalName, user.department, user.jobTitle, user.officeLocation]
      .map((value) => String(value ?? "").toLocaleLowerCase("ja-JP"))
      .some((value) => value.includes(query));
  }

  function getFilteredUtilization() {
    return data.utilization.filter((row) => {
      const user = usersById.get(row.userId);
      if (!user || !userMatches(user)) return false;
      return state.skuId === "all" || row.skuId === state.skuId;
    });
  }

  function getVisibleUsers() {
    const ids = unique(getFilteredUtilization().map((row) => row.userId));
    return ids.map((id) => usersById.get(id)).filter(Boolean);
  }

  function getFilteredE5Users() {
    if (!e5Sku) return [];
    const ids = unique(data.utilization.filter((row) => row.skuId === e5Sku.skuId).map((row) => row.userId));
    return ids.map((id) => usersById.get(id)).filter((user) => user && userMatches(user));
  }

  function sumCost(rows) {
    return rows.reduce((sum, row) => sum + (pricesBySku.get(row.skuId) || 0), 0);
  }

  function userLastActivity(userId, rows = utilizationByUser.get(userId) || []) {
    const values = rows.map((row) => row.lastActivityDate).filter(Boolean).sort();
    return values.at(-1) || null;
  }

  function departmentName(user) {
    return asText(user?.department);
  }

  function departmentMetrics() {
    const rows = getFilteredUtilization();
    const byDepartment = new Map();
    rows.forEach((row) => {
      const user = usersById.get(row.userId);
      if (!user) return;
      const name = departmentName(user);
      if (!byDepartment.has(name)) {
        byDepartment.set(name, { name, userIds: new Set(), activeIds: new Set(), cost: 0, recoverableCost: 0 });
      }
      const metric = byDepartment.get(name);
      metric.userIds.add(row.userId);
      if (row.utilizationStatus === "Active") metric.activeIds.add(row.userId);
      const price = pricesBySku.get(row.skuId) || 0;
      metric.cost += price;
      if (["Dormant", "NeverUsed", "DisabledAccount"].includes(row.utilizationStatus)) {
        metric.recoverableCost += price;
      }
    });
    return [...byDepartment.values()]
      .map((metric) => ({
        ...metric,
        users: metric.userIds.size,
        activeUsers: metric.activeIds.size,
        activeRate: metric.userIds.size ? metric.activeIds.size / metric.userIds.size : 0
      }))
      .sort((a, b) => b.users - a.users || a.name.localeCompare(b.name, "ja"));
  }

  function kpiCard(icon, label, value, meta) {
    return `
      <article class="kpi-card">
        <div class="kpi-topline">
          <span class="kpi-label">${escapeHtml(label)}</span>
          <span class="kpi-icon" aria-hidden="true"><i data-lucide="${icon}"></i></span>
        </div>
        <div class="kpi-value">${escapeHtml(value)}</div>
        <div class="kpi-meta">${escapeHtml(meta)}</div>
      </article>`;
  }

  function panel(title, subtitle, content, count = "") {
    return `
      <section class="visual-panel">
        <div class="panel-heading">
          <div><h2>${escapeHtml(title)}</h2><div class="panel-subtitle">${escapeHtml(subtitle)}</div></div>
          ${count ? `<span class="panel-count">${escapeHtml(count)}</span>` : ""}
        </div>
        ${content}
      </section>`;
  }

  function renderSummary() {
    const rows = getFilteredUtilization();
    const users = getVisibleUsers();
    const departments = departmentMetrics();
    const totalCost = sumCost(rows);
    const paidSeats = rows.filter((row) => (pricesBySku.get(row.skuId) || 0) > 0).length;
    const userRows = users
      .map((user) => {
        const userRowsForFilter = rows.filter((row) => row.userId === user.userId);
        return {
          user,
          assignmentCount: userRowsForFilter.length,
          licenses: userRowsForFilter.map((row) => skusById.get(row.skuId)?.licenseName).filter(Boolean),
          status: getUserStatus(user.userId, userRowsForFilter)
        };
      })
      .sort((a, b) => b.assignmentCount - a.assignmentCount || a.user.displayName.localeCompare(b.user.displayName, "ja"));

    const table = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>氏名</th><th>部門</th><th>拠点</th><th>役職</th><th>利用状態</th><th class="numeric">割当数</th></tr></thead>
          <tbody>${userRows.map(({ user, assignmentCount, status }) => `
            <tr data-user-id="${escapeHtml(user.userId)}">
              <td><div class="cell-primary">${escapeHtml(user.displayName)}</div><div class="cell-secondary">${escapeHtml(user.userPrincipalName)}</div></td>
              <td>${escapeHtml(departmentName(user))}</td>
              <td>${escapeHtml(asText(user.officeLocation))}</td>
              <td>${escapeHtml(asText(user.jobTitle))}</td>
              <td>${statusBadge(status)}</td>
              <td class="numeric">${formatNumber(assignmentCount)}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>`;

    return `
      <div class="kpi-grid">
        ${kpiCard("users", "ライセンス保有ユーザー", formatNumber(users.length), `${formatNumber(paidSeats)} 有償割当`)}
        ${kpiCard("japanese-yen", "推定月額コスト", formatYen(totalCost), "固定単価による月額換算")}
        ${kpiCard("package-check", "購入済みライセンス", formatNumber(data.skus.reduce((sum, sku) => sum + asNumber(sku.purchasedUnits), 0)), `${formatNumber(data.skus.length)} SKU`)}
        ${kpiCard("building-2", "対象部門", formatNumber(departments.length), "未設定を含む")}
      </div>
      <div class="visual-grid summary-split">
        ${panel("部門別 割当ユーザー", "棒を選択すると部門からユーザーへドリルダウン", '<div id="summaryDepartmentChart" class="chart" role="img" aria-label="部門別ライセンス保有ユーザー数"></div>', `${departments.length} 部門`)}
        ${panel("割当ユーザー一覧", "行を選択するとユーザーのライセンスと利用状況を表示", table, `${userRows.length} ユーザー`)}
      </div>`;
  }

  function renderDepartment() {
    const rows = getFilteredUtilization();
    const users = getVisibleUsers();
    const departments = departmentMetrics();
    const activeUsers = unique(rows.filter((row) => row.utilizationStatus === "Active").map((row) => row.userId)).length;
    const totalCost = sumCost(rows);
    const recoverableCost = rows
      .filter((row) => ["Dormant", "NeverUsed", "DisabledAccount"].includes(row.utilizationStatus))
      .reduce((sum, row) => sum + (pricesBySku.get(row.skuId) || 0), 0);
    const departmentTable = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>部門</th><th class="numeric">ユーザー</th><th class="numeric">Active</th><th class="numeric">Active率</th><th class="numeric">月額コスト</th><th class="numeric">削減候補</th></tr></thead>
          <tbody>${departments.map((metric) => `
            <tr data-department="${escapeHtml(metric.name)}">
              <td class="cell-primary">${escapeHtml(metric.name)}</td>
              <td class="numeric">${formatNumber(metric.users)}</td>
              <td class="numeric">${formatNumber(metric.activeUsers)}</td>
              <td class="numeric">${formatPercent(metric.activeRate)}</td>
              <td class="numeric">${formatYen(metric.cost)}</td>
              <td class="numeric">${formatYen(metric.recoverableCost)}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>`;
    return `
      <div class="kpi-grid">
        ${kpiCard("users", "ライセンス保有ユーザー", formatNumber(users.length), `${formatNumber(rows.length)} 割当`)}
        ${kpiCard("activity", "Activeユーザー", formatNumber(activeUsers), formatPercent(users.length ? activeUsers / users.length : 0))}
        ${kpiCard("badge-japanese-yen", "Activeユーザー単価", formatYen(activeUsers ? totalCost / activeUsers : 0), "月額コスト ÷ Activeユーザー")}
        ${kpiCard("piggy-bank", "削減可能率", formatPercent(totalCost ? recoverableCost / totalCost : 0), formatYen(recoverableCost))}
      </div>
      <div class="visual-grid equal">
        ${panel("部門別 Active / 割り当て", "棒を選択して部門のユーザーを表示", '<div id="departmentActivityChart" class="chart" role="img" aria-label="部門別Activeユーザーと割当ユーザー"></div>')}
        ${panel("部門別 削減可能額", "未利用・休眠・無効アカウントの月額単価", '<div id="departmentSavingsChart" class="chart" role="img" aria-label="部門別削減可能額"></div>')}
      </div>
      ${panel("部門一覧", "行を選択してユーザー単位へドリルダウン", departmentTable, `${departments.length} 部門`)}`;
  }

  function buildFeatureMetrics() {
    const e5Users = getFilteredE5Users();
    const e5UserIds = new Set(e5Users.map((user) => user.userId));
    const reportablePlans = data.servicePlans.filter((plan) => Boolean(plan.isReportable));
    const featureGroups = groupBy(reportablePlans, "featureName");
    const entitlementLookup = new Map();
    data.entitlements
      .filter((row) => row.skuId === e5Sku?.skuId && e5UserIds.has(row.userId))
      .forEach((row) => entitlementLookup.set(`${row.userId}|${row.servicePlanId}`, Boolean(row.isEnabled)));

    const features = [...featureGroups.entries()].map(([featureName, plans]) => {
      const userStates = e5Users.map((user) => {
        const planStates = plans.map((plan) => ({
          plan,
          enabled: entitlementLookup.get(`${user.userId}|${plan.servicePlanId}`) === true
        }));
        return { user, planStates, enabled: planStates.every((entry) => entry.enabled) };
      });
      const enabledCount = userStates.filter((entry) => entry.enabled).length;
      return {
        featureName,
        category: asText(plans[0]?.category, "その他"),
        decisionNote: asText(plans[0]?.decisionNote, "確認事項なし"),
        plans,
        userStates,
        enabledCount,
        disabledCount: e5Users.length - enabledCount,
        allEnabled: e5Users.length > 0 && enabledCount === e5Users.length
      };
    }).sort((a, b) => a.category.localeCompare(b.category, "ja") || a.featureName.localeCompare(b.featureName, "ja"));
    return { e5Users, features, entitlementLookup };
  }

  function renderFeatureMatrix(metrics) {
    const { features, e5Users, entitlementLookup } = metrics;
    const rows = [];
    features.forEach((feature) => {
      const featureKey = feature.featureName;
      const featureExpanded = state.expandedFeatures.has(featureKey);
      rows.push(`
        <tr class="matrix-row-feature" data-feature="${escapeHtml(featureKey)}">
          <td><div class="matrix-label"><button class="expander" type="button" data-action="toggle-feature" data-key="${escapeHtml(featureKey)}" aria-expanded="${featureExpanded}" title="品番を${featureExpanded ? "折りたたむ" : "展開する"}"><i data-lucide="${featureExpanded ? "chevron-down" : "chevron-right"}"></i></button><span>${escapeHtml(feature.featureName)}</span></div></td>
          <td>${escapeHtml(feature.category)}</td>
          <td class="numeric">${formatNumber(feature.enabledCount)}</td>
          <td class="numeric">${formatNumber(feature.disabledCount)}</td>
          <td>${enabledBadge(feature.allEnabled, !feature.allEnabled && feature.enabledCount > 0)}</td>
        </tr>`);
      if (!featureExpanded) return;
      feature.plans.forEach((plan) => {
        const planKey = `${featureKey}|${plan.servicePlanId}`;
        const planExpanded = state.expandedPlans.has(planKey);
        const enabledCount = e5Users.filter((user) => entitlementLookup.get(`${user.userId}|${plan.servicePlanId}`) === true).length;
        rows.push(`
          <tr class="matrix-row-plan" data-plan="${escapeHtml(planKey)}">
            <td><div class="matrix-label"><button class="expander" type="button" data-action="toggle-plan" data-key="${escapeHtml(planKey)}" aria-expanded="${planExpanded}" title="ユーザーを${planExpanded ? "折りたたむ" : "展開する"}"><i data-lucide="${planExpanded ? "chevron-down" : "chevron-right"}"></i></button><span><span class="cell-primary">${escapeHtml(plan.servicePlanName)}</span><span class="cell-secondary">内部サービスプラン品番</span></span></div></td>
            <td>${escapeHtml(feature.category)}</td>
            <td class="numeric">${formatNumber(enabledCount)}</td>
            <td class="numeric">${formatNumber(e5Users.length - enabledCount)}</td>
            <td>${enabledBadge(enabledCount === e5Users.length, enabledCount > 0 && enabledCount < e5Users.length)}</td>
          </tr>`);
        if (!planExpanded) return;
        e5Users.forEach((user) => {
          const enabled = entitlementLookup.get(`${user.userId}|${plan.servicePlanId}`) === true;
          rows.push(`
            <tr class="matrix-row-user" data-user-id="${escapeHtml(user.userId)}">
              <td><div class="cell-primary">${escapeHtml(user.displayName)}</div><div class="cell-secondary">${escapeHtml(user.userPrincipalName)}</div></td>
              <td>${escapeHtml(departmentName(user))}</td>
              <td colspan="2">${escapeHtml(asText(user.officeLocation))}</td>
              <td>${enabledBadge(enabled)}</td>
            </tr>`);
        });
      });
    });
    return `
      <div class="matrix-wrap">
        <table>
          <thead><tr><th>機能名 / 品番 / ユーザー</th><th>カテゴリ / 部門</th><th class="numeric">有効</th><th class="numeric">無効</th><th>設定状況</th></tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>`;
  }

  function renderFeatures() {
    const metrics = buildFeatureMetrics();
    const allEnabled = metrics.features.filter((feature) => feature.allEnabled).length;
    const partial = metrics.features.length - allEnabled;
    const categories = unique(metrics.features.map((feature) => feature.category));
    const matrix = renderFeatureMatrix(metrics);
    return `
      <div class="kpi-grid">
        ${kpiCard("users", "Microsoft 365 E5 ユーザー", formatNumber(metrics.e5Users.length), e5Sku?.licenseName || "E5")}
        ${kpiCard("shield", "確認する高度機能", formatNumber(metrics.features.length), `${formatNumber(categories.length)} カテゴリ`)}
        ${kpiCard("badge-check", "全対象ユーザーで有効", formatNumber(allEnabled), "機能単位")}
        ${kpiCard("triangle-alert", "一部または全員で無効", formatNumber(partial), "設定確認が必要")}
      </div>
      <div class="visual-grid equal">
        ${panel("機能カテゴリ別の確認対象数", "棒を選択すると対象機能を展開", '<div id="featureCategoryChart" class="chart compact" role="img" aria-label="機能カテゴリ別の確認対象数"></div>')}
        ${panel("部門別のE5利用割合", "区分を選択すると部門からユーザーへドリルダウン", '<div id="e5DepartmentChart" class="chart compact" role="img" aria-label="部門別E5ユーザー割合"></div>')}
      </div>
      ${panel("E5の高度機能", "＋で機能名 → サービスプラン品番 → ユーザーを展開", matrix, `${metrics.features.length} 機能`)}`;
  }

  function renderUsers() {
    const visibleUsers = getVisibleUsers();
    const visibleIds = new Set(visibleUsers.map((user) => user.userId));
    const copilotRows = data.copilotUsage.filter((row) => visibleIds.has(row.userId));
    const activeCopilot = copilotRows.filter((row) => row.lastActivityDate);
    const promptCount = copilotRows.reduce((sum, row) => sum + asNumber(row.promptsAnyApp), 0);
    const m365Rows = data.m365Usage.filter((row) => visibleIds.has(row.userId));
    const activeM365 = m365Rows.filter((row) => row.overallLastActivityDate).length;
    const departmentPrompts = [...groupBy(copilotRows, "userId").entries()].reduce((map, [userId, rows]) => {
      const user = usersById.get(userId);
      const department = departmentName(user);
      map.set(department, (map.get(department) || 0) + rows.reduce((sum, row) => sum + asNumber(row.promptsAnyApp), 0));
      return map;
    }, new Map());
    const table = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>氏名</th><th>部門</th><th>利用状態</th><th>最終利用日</th><th class="numeric">Copilotプロンプト</th><th>Copilot最終利用日</th><th>M365最終利用日</th></tr></thead>
          <tbody>${visibleUsers.map((user) => {
            const copilot = copilotByUser.get(user.userId);
            const m365 = m365ByUser.get(user.userId);
            return `
              <tr data-user-id="${escapeHtml(user.userId)}">
                <td><div class="cell-primary">${escapeHtml(user.displayName)}</div><div class="cell-secondary">${escapeHtml(asText(user.jobTitle))}</div></td>
                <td>${escapeHtml(departmentName(user))}</td>
                <td>${statusBadge(getUserStatus(user.userId))}</td>
                <td>${escapeHtml(formatDate(userLastActivity(user.userId)))}</td>
                <td class="numeric">${formatNumber(copilot?.promptsAnyApp)}</td>
                <td>${escapeHtml(formatDate(copilot?.lastActivityDate))}</td>
                <td>${escapeHtml(formatDate(m365?.overallLastActivityDate))}</td>
              </tr>`;
          }).join("")}</tbody>
        </table>
      </div>`;
    return `
      <div class="kpi-grid">
        ${kpiCard("sparkles", "Copilot Activeユーザー", formatNumber(activeCopilot.length), `${formatNumber(visibleUsers.length)} 対象ユーザー`)}
        ${kpiCard("message-square-text", "Copilot プロンプト", formatNumber(promptCount), "サポート対象アプリ合計")}
        ${kpiCard("messages-square", "ユーザー当たりプロンプト", formatNumber(activeCopilot.length ? promptCount / activeCopilot.length : 0, 1), "Active Copilotユーザー基準")}
        ${kpiCard("app-window", "M365利用ユーザー", formatNumber(activeM365), "最終利用日あり")}
      </div>
      ${panel("部門別 Copilotプロンプト", "棒を選択して部門のユーザー利用詳細を表示", '<div id="copilotDepartmentChart" class="chart compact" role="img" aria-label="部門別Copilotプロンプト数"></div>', `${departmentPrompts.size} 部門`)}
      ${panel("ユーザー利用詳細", "行を選択するとアプリ別利用日とライセンスを表示", table, `${visibleUsers.length} ユーザー`)}`;
  }

  function disposeCharts() {
    while (charts.length) charts.pop().dispose();
  }

  function fallbackBars(container, items) {
    const maximum = Math.max(...items.map((item) => asNumber(item.value)), 1);
    container.innerHTML = `<div class="fallback-bars">${items.map((item) => `
      <button class="fallback-bar" type="button" data-department="${escapeHtml(item.name)}">
        <span>${escapeHtml(item.name)}</span>
        <span class="fallback-track"><span class="fallback-fill" style="width:${Math.max(2, asNumber(item.value) / maximum * 100)}%"></span></span>
        <strong>${formatNumber(item.value)}</strong>
      </button>`).join("")}</div>`;
  }

  function barChart(id, items, config = {}) {
    const container = document.getElementById(id);
    if (!container) return;
    if (!window.echarts) {
      fallbackBars(container, items);
      return;
    }
    const colors = getCssColors();
    const chart = window.echarts.init(container);
    charts.push(chart);
    const hasSecondary = items.some((item) => item.secondary !== undefined);
    chart.setOption({
      animationDuration: 450,
      color: [colors.accent, colors.link],
      textStyle: { fontFamily: '"Segoe UI", Aptos, Calibri, sans-serif', color: colors.text },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: colors.surface, borderColor: colors.border, textStyle: { color: colors.text } },
      legend: hasSecondary ? { top: 4, textStyle: { color: colors.muted }, data: [config.primaryName || "値", config.secondaryName || "比較"] } : undefined,
      grid: { left: 18, right: 30, top: hasSecondary ? 44 : 20, bottom: 18, containLabel: true },
      xAxis: { type: "value", axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border } } },
      yAxis: { type: "category", inverse: true, data: items.map((item) => item.name), axisLabel: { color: colors.muted, width: 150, overflow: "truncate" }, axisLine: { lineStyle: { color: colors.border } }, axisTick: { show: false } },
      series: [
        { name: config.primaryName || "値", type: "bar", data: items.map((item) => item.value), barMaxWidth: 22, itemStyle: { borderRadius: [0, 3, 3, 0] }, label: { show: true, position: "right", color: colors.text, formatter: config.formatter || "{c}" } },
        ...(hasSecondary ? [{ name: config.secondaryName || "比較", type: "bar", data: items.map((item) => item.secondary), barMaxWidth: 22, itemStyle: { borderRadius: [0, 3, 3, 0] }, label: { show: true, position: "right", color: colors.text, formatter: config.secondaryFormatter || config.formatter || "{c}" } }] : [])
      ]
    });
    chart.on("click", (params) => {
      if (config.onClick) config.onClick(params.name, params);
    });
  }

  function donutChart(id, items, onClick) {
    const container = document.getElementById(id);
    if (!container || !window.echarts) {
      if (container) fallbackBars(container, items);
      return;
    }
    const colors = getCssColors();
    const palette = [colors.accent, colors.link, colors.success, colors.warning, colors.danger, colors.muted, colors.border];
    const chart = window.echarts.init(container);
    charts.push(chart);
    chart.setOption({
      animationDuration: 450,
      color: palette,
      textStyle: { fontFamily: '"Segoe UI", Aptos, Calibri, sans-serif', color: colors.text },
      tooltip: { trigger: "item", backgroundColor: colors.surface, borderColor: colors.border, textStyle: { color: colors.text } },
      legend: { type: "scroll", orient: "vertical", right: 6, top: "middle", textStyle: { color: colors.muted }, width: "45%" },
      series: [{ type: "pie", radius: ["46%", "72%"], center: ["32%", "52%"], avoidLabelOverlap: true, label: { show: false }, data: items.map((item) => ({ name: item.name, value: item.value })) }]
    });
    chart.on("click", (params) => onClick?.(params.name, params));
  }

  function renderCharts() {
    const departments = departmentMetrics();
    if (state.page === "summary") {
      barChart("summaryDepartmentChart", departments.slice(0, 14).map((metric) => ({ name: metric.name, value: metric.users })), { primaryName: "割当ユーザー", onClick: openDepartment });
    }
    if (state.page === "department") {
      barChart("departmentActivityChart", departments.slice(0, 14).map((metric) => ({ name: metric.name, value: metric.users, secondary: metric.activeUsers })), { primaryName: "割当ユーザー", secondaryName: "Activeユーザー", onClick: openDepartment });
      barChart("departmentSavingsChart", departments.filter((metric) => metric.recoverableCost > 0).slice(0, 14).map((metric) => ({ name: metric.name, value: metric.recoverableCost })), { primaryName: "削減可能額", formatter: (params) => formatYen(params.value), onClick: openDepartment });
    }
    if (state.page === "features") {
      const metrics = buildFeatureMetrics();
      const categories = [...groupBy(metrics.features, "category").entries()]
        .map(([name, rows]) => ({ name, value: rows.length }))
        .sort((a, b) => b.value - a.value);
      barChart("featureCategoryChart", categories, {
        primaryName: "確認対象機能",
        onClick: (category) => {
          metrics.features.filter((feature) => feature.category === category).forEach((feature) => state.expandedFeatures.add(feature.featureName));
          render();
          showToast(`${category} の機能を展開しました`);
        }
      });
      const e5Departments = [...groupBy(metrics.e5Users, "department").entries()]
        .map(([rawName, rows]) => ({ name: asText(rawName), value: rows.length }))
        .sort((a, b) => b.value - a.value);
      donutChart("e5DepartmentChart", e5Departments, openDepartment);
    }
    if (state.page === "users") {
      const visibleIds = new Set(getVisibleUsers().map((user) => user.userId));
      const prompts = new Map();
      data.copilotUsage.filter((row) => visibleIds.has(row.userId)).forEach((row) => {
        const name = departmentName(usersById.get(row.userId));
        prompts.set(name, (prompts.get(name) || 0) + asNumber(row.promptsAnyApp));
      });
      const items = [...prompts.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
      barChart("copilotDepartmentChart", items, { primaryName: "プロンプト", onClick: openDepartment });
    }
  }

  function updateFilters() {
    if (state.page === "features" && e5Sku) {
      licenseFilter.value = e5Sku.skuId;
      licenseFilter.disabled = true;
      licenseFilter.title = "E5機能チェックでは Microsoft 365 E5 に固定されます";
    } else {
      licenseFilter.disabled = false;
      licenseFilter.title = "";
      licenseFilter.value = state.skuId;
    }
    locationFilter.value = state.location;
    userSearch.value = state.search;
  }

  function updateFilterSummary() {
    const sku = state.page === "features" ? e5Sku : skusById.get(state.skuId);
    const chips = [];
    chips.push(`<span class="chip">${escapeHtml(sku?.licenseName || "すべてのライセンス")}</span>`);
    if (state.location !== "all") chips.push(`<span class="chip">${escapeHtml(state.location)}</span>`);
    if (state.search) chips.push(`<span class="chip">検索: ${escapeHtml(state.search)}</span>`);
    filterSummary.innerHTML = chips.join("");
  }

  function render() {
    disposeCharts();
    document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.page === state.page));
    pageTitle.textContent = pageMeta[state.page].title;
    pageEyebrow.textContent = pageMeta[state.page].eyebrow;
    updateFilters();
    updateFilterSummary();
    reportCanvas.innerHTML = {
      summary: renderSummary,
      department: renderDepartment,
      features: renderFeatures,
      users: renderUsers
    }[state.page]();
    if (window.lucide) window.lucide.createIcons();
    requestAnimationFrame(renderCharts);
  }

  function openDrawer(kicker, title, content) {
    drawerKicker.textContent = kicker;
    drawerTitle.textContent = title;
    drawerContent.innerHTML = content;
    drawer.classList.add("is-open");
    drawer.setAttribute("aria-hidden", "false");
    drawerOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    if (window.lucide) window.lucide.createIcons();
  }

  function closeDrawer() {
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    drawerOverlay.hidden = true;
    document.body.style.overflow = "";
  }

  function openUser(userId) {
    const user = usersById.get(userId);
    if (!user) return;
    const utilization = utilizationByUser.get(userId) || [];
    const assignments = assignmentsByUser.get(userId) || [];
    const copilot = copilotByUser.get(userId);
    const m365 = m365ByUser.get(userId);
    const enabledEntitlements = (entitlementsByUser.get(userId) || []).filter((row) => row.isEnabled).length;
    const licenses = unique(assignments.map((row) => skusById.get(row.skuId)?.licenseName).filter(Boolean));
    openDrawer("ユーザー詳細", user.displayName, `
      <section class="drawer-section">
        <div class="drawer-metric"><span>UPN</span><strong>${escapeHtml(user.userPrincipalName)}</strong></div>
        <div class="drawer-metric"><span>部門</span><strong>${escapeHtml(departmentName(user))}</strong></div>
        <div class="drawer-metric"><span>役職</span><strong>${escapeHtml(asText(user.jobTitle))}</strong></div>
        <div class="drawer-metric"><span>拠点</span><strong>${escapeHtml(asText(user.officeLocation))}</strong></div>
        <div class="drawer-metric"><span>利用状態</span><strong>${statusBadge(getUserStatus(userId))}</strong></div>
      </section>
      <section class="drawer-section"><h3>割当ライセンス</h3><div class="chip-list">${licenses.map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join("")}</div></section>
      <section class="drawer-section">
        <h3>利用状況</h3>
        <div class="drawer-metric"><span>最終利用日</span><strong>${escapeHtml(formatDate(userLastActivity(userId)))}</strong></div>
        <div class="drawer-metric"><span>Copilotプロンプト</span><strong>${formatNumber(copilot?.promptsAnyApp)}</strong></div>
        <div class="drawer-metric"><span>Copilot最終利用日</span><strong>${escapeHtml(formatDate(copilot?.lastActivityDate))}</strong></div>
        <div class="drawer-metric"><span>M365最終利用日</span><strong>${escapeHtml(formatDate(m365?.overallLastActivityDate))}</strong></div>
        <div class="drawer-metric"><span>有効なサービスプラン</span><strong>${formatNumber(enabledEntitlements)}</strong></div>
      </section>
      <section class="drawer-section"><h3>SKU別状態</h3>${utilization.map((row) => `<div class="drawer-metric"><span>${escapeHtml(skusById.get(row.skuId)?.licenseName || row.skuId)}</span><strong>${statusBadge(row.utilizationStatus)}</strong></div>`).join("")}</section>`);
  }

  function openDepartment(name) {
    const users = getVisibleUsers().filter((user) => departmentName(user) === name);
    const rows = getFilteredUtilization().filter((row) => departmentName(usersById.get(row.userId)) === name);
    const activeUsers = unique(rows.filter((row) => row.utilizationStatus === "Active").map((row) => row.userId)).length;
    openDrawer("部門ドリルダウン", name, `
      <section class="drawer-section">
        <div class="drawer-metric"><span>ライセンス保有ユーザー</span><strong>${formatNumber(users.length)}</strong></div>
        <div class="drawer-metric"><span>Activeユーザー</span><strong>${formatNumber(activeUsers)}</strong></div>
        <div class="drawer-metric"><span>月額コスト</span><strong>${formatYen(sumCost(rows))}</strong></div>
      </section>
      <section class="drawer-section"><h3>ユーザー</h3><div class="drawer-user-list">${users.map((user) => `<button class="drawer-user-button" type="button" data-user-id="${escapeHtml(user.userId)}"><span><span class="cell-primary">${escapeHtml(user.displayName)}</span><span class="cell-secondary">${escapeHtml(asText(user.jobTitle))}</span></span>${statusBadge(getUserStatus(user.userId))}</button>`).join("") || '<div class="empty-state">対象ユーザーがいません。</div>'}</div></section>`);
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
  }

  function initializeFilters() {
    licenseFilter.innerHTML = `<option value="all">すべて</option>${data.skus.map((sku) => `<option value="${escapeHtml(sku.skuId)}">${escapeHtml(sku.licenseName)}</option>`).join("")}`;
    const licensedIds = new Set(data.utilization.map((row) => row.userId));
    const locations = unique(data.users.filter((user) => licensedIds.has(user.userId)).map((user) => asText(user.officeLocation))).sort((a, b) => a.localeCompare(b, "ja"));
    locationFilter.innerHTML = `<option value="all">すべて</option>${locations.map((location) => `<option value="${escapeHtml(location)}">${escapeHtml(location)}</option>`).join("")}`;
  }

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.page = button.dataset.page;
      closeDrawer();
      render();
    });
  });

  licenseFilter.addEventListener("change", () => {
    state.skuId = licenseFilter.value;
    render();
  });

  locationFilter.addEventListener("change", () => {
    state.location = locationFilter.value;
    render();
  });

  userSearch.addEventListener("input", () => {
    state.search = userSearch.value;
    render();
  });

  document.getElementById("resetFilters").addEventListener("click", () => {
    state.skuId = "all";
    state.location = "all";
    state.search = "";
    render();
    showToast("フィルターをリセットしました");
  });

  document.getElementById("themeToggle").addEventListener("click", () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    render();
  });

  reportCanvas.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action?.dataset.action === "toggle-feature") {
      const key = action.dataset.key;
      state.expandedFeatures.has(key) ? state.expandedFeatures.delete(key) : state.expandedFeatures.add(key);
      render();
      return;
    }
    if (action?.dataset.action === "toggle-plan") {
      const key = action.dataset.key;
      state.expandedPlans.has(key) ? state.expandedPlans.delete(key) : state.expandedPlans.add(key);
      render();
      return;
    }
    const userElement = event.target.closest("[data-user-id]");
    if (userElement) {
      openUser(userElement.dataset.userId);
      return;
    }
    const departmentElement = event.target.closest("[data-department]");
    if (departmentElement) openDepartment(departmentElement.dataset.department);
  });

  drawerContent.addEventListener("click", (event) => {
    const userElement = event.target.closest("[data-user-id]");
    if (userElement) openUser(userElement.dataset.userId);
  });

  document.getElementById("closeDrawer").addEventListener("click", closeDrawer);
  drawerOverlay.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
  window.addEventListener("resize", () => charts.forEach((chart) => chart.resize()));

  initializeFilters();
  const latestSnapshot = data.utilization.map((row) => row.snapshotDate).filter(Boolean).sort().at(-1);
  document.getElementById("snapshotLabel").textContent = `スナップショット ${formatDate(latestSnapshot)}`;
  if (window.lucide) window.lucide.createIcons();
  render();
})();