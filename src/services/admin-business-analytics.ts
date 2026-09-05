import { dbRead } from "../db/client.js";
import { subscriptions, transactions } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { CREDIT_PACKS } from "../config/credits.js";
import { PAYMENT_GATEWAY } from "../types/payment.js";
import { STRIPE_MONTHLY_PRICE_USD, XENDIT_MONTHLY_PRICE_IDR } from "../config/subscription.js";

export interface RevenuePoint {
  date: string;
  recurringUsd: number;
  recurringIdr: number;
  oneTimeUsd: number;
  oneTimeIdr: number;
  totalUsd: number;
  totalIdr: number;
  subscribersCount: number;
  purchasesCount: number;
}

export interface PackBreakdownItem {
  packId: string;
  title: string;
  credits: number;
  count: number;
  revenueUsd: number;
  revenueIdr: number;
}

export interface ChurnTrendItem {
  period: string;
  newSubs: number;
  churnedSubs: number;
  netSubs: number;
  churnRate: number;
}

export interface AdminBusinessMetrics {
  overview: {
    arrUsd: number;
    arrIdr: number;
    mrrUsd: number;
    mrrIdr: number;
    totalGrossUsd: number;
    totalGrossIdr: number;
    otherIncomesTotalUsd: number;
    otherIncomesTotalIdr: number;
    activeSubscribers: number;
    stripeSubscribers: number;
    xenditSubscribers: number;
    trialingSubscribers: number;
    pastDueSubscribers: number;
    totalCreditPacksSold: number;
    creditPacksSold30d: number;
    creditPacksRevenue30dUsd: number;
    creditPacksRevenue30dIdr: number;
  };
  engagement: {
    dau: number;
    wau: number;
    mau: number;
    totalUsers: number;
    dauMauRatio: number;
    wauMauRatio: number;
    signupsLast30d: number;
    inactiveUsers60d: number;
    activityTrend: {
      date: string;
      activeUsers: number;
      newSignups: number;
    }[];
  };
  churn: {
    monthlyChurnRate: number;
    totalChurned: number;
    canceledLast30d: number;
    cancelAtPeriodEndCount: number;
    trialConversionRate: number | null;
    userInactivityChurnRate: number;
    churnTrend: ChurnTrendItem[];
  };
  breakdowns: {
    packs: PackBreakdownItem[];
    gateways: {
      stripeSharePct: number;
      xenditSharePct: number;
      stripeTotalUsd: number;
      xenditTotalIdr: number;
    };
  };
  trends: {
    daily: RevenuePoint[];
    monthly: RevenuePoint[];
    yearly: RevenuePoint[];
  };
}

/**
 * Computes platform-wide financial, revenue, engagement, and churn metrics.
 * Uses optimized SQL aggregations across users, subscriptions, transactions,
 * and user activity tables.
 */
export async function getAdminBusinessMetrics(): Promise<AdminBusinessMetrics> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  // ── 1. Subscriptions Aggregation ───────────────────────────────────────────
  const subRows = await dbRead
    .select({
      id: subscriptions.id,
      gateway: subscriptions.gateway,
      status: subscriptions.status,
      isTrial: subscriptions.isTrial,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      canceledAt: subscriptions.canceledAt,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions);

  let stripeActive = 0;
  let xenditActive = 0;
  let trialingCount = 0;
  let pastDueCount = 0;
  let cancelAtPeriodEndCount = 0;
  let totalChurned = 0;
  let canceledLast30d = 0;

  for (const s of subRows) {
    if (s.status === "active") {
      if (s.gateway === PAYMENT_GATEWAY.xendit) {
        xenditActive++;
      } else {
        stripeActive++;
      }
      if (s.cancelAtPeriodEnd) {
        cancelAtPeriodEndCount++;
      }
    } else if (s.status === "trialing" || s.isTrial) {
      trialingCount++;
    } else if (s.status === "past_due") {
      pastDueCount++;
    }

    if (s.status === "canceled" || s.canceledAt !== null) {
      totalChurned++;
      if (s.canceledAt && new Date(s.canceledAt) >= thirtyDaysAgo) {
        canceledLast30d++;
      }
    }
  }

  const activeSubscribers = stripeActive + xenditActive;
  const mrrUsd = Number((stripeActive * STRIPE_MONTHLY_PRICE_USD).toFixed(2));
  const mrrIdr = xenditActive * XENDIT_MONTHLY_PRICE_IDR;
  const arrUsd = Number((mrrUsd * 12).toFixed(2));
  const arrIdr = mrrIdr * 12;

  const churnDenominator = activeSubscribers + canceledLast30d;
  const monthlyChurnRate =
    churnDenominator > 0 ? Number(((canceledLast30d / churnDenominator) * 100).toFixed(1)) : 0;

  // ── 2. Transactions (One-time credit pack purchases) Aggregation ───────────
  const purchaseTxRows = await dbRead
    .select({
      id: transactions.id,
      gateway: transactions.gateway,
      credits: transactions.credits,
      amountCents: transactions.amountCents,
      metadata: transactions.metadata,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(eq(transactions.type, "purchase"));

  let otherIncomesTotalUsd = 0;
  let otherIncomesTotalIdr = 0;
  let creditPacksSold30d = 0;
  let creditPacksRevenue30dUsd = 0;
  let creditPacksRevenue30dIdr = 0;

  const packCountMap: Record<string, { count: number; usd: number; idr: number; credits: number; title: string }> = {};

  // Initialize pack map from config
  for (const p of CREDIT_PACKS) {
    packCountMap[p.id] = {
      count: 0,
      usd: 0,
      idr: 0,
      credits: p.credits,
      title: p.title,
    };
  }

  for (const tx of purchaseTxRows) {
    const isXendit = tx.gateway === PAYMENT_GATEWAY.xendit;
    const amount = Number(tx.amountCents ?? 0);
    const isRecent30d = new Date(tx.createdAt) >= thirtyDaysAgo;

    if (isXendit) {
      otherIncomesTotalIdr += amount;
      if (isRecent30d) {
        creditPacksRevenue30dIdr += amount;
        creditPacksSold30d++;
      }
    } else {
      const usdVal = amount / 100;
      otherIncomesTotalUsd += usdVal;
      if (isRecent30d) {
        creditPacksRevenue30dUsd += usdVal;
        creditPacksSold30d++;
      }
    }

    // Match pack
    let matchedPackId = "";
    if (tx.metadata && typeof tx.metadata === "object" && "packId" in tx.metadata && typeof tx.metadata.packId === "string") {
      matchedPackId = tx.metadata.packId;
    } else {
      // match by credits
      const matched = CREDIT_PACKS.find((p) => p.credits === tx.credits);
      if (matched) matchedPackId = matched.id;
    }

    if (matchedPackId && packCountMap[matchedPackId]) {
      packCountMap[matchedPackId].count++;
      if (isXendit) {
        packCountMap[matchedPackId].idr += amount;
      } else {
        packCountMap[matchedPackId].usd += amount / 100;
      }
    } else if (matchedPackId) {
      packCountMap[matchedPackId] = {
        count: 1,
        usd: isXendit ? 0 : amount / 100,
        idr: isXendit ? amount : 0,
        credits: tx.credits,
        title: matchedPackId,
      };
    }
  }

  otherIncomesTotalUsd = Number(otherIncomesTotalUsd.toFixed(2));
  creditPacksRevenue30dUsd = Number(creditPacksRevenue30dUsd.toFixed(2));

  const packsBreakdown: PackBreakdownItem[] = Object.entries(packCountMap).map(([packId, item]) => ({
    packId,
    title: item.title,
    credits: item.credits,
    count: item.count,
    revenueUsd: Number(item.usd.toFixed(2)),
    revenueIdr: item.idr,
  }));

  // ── 3. Users & Engagement Aggregation ──────────────────────────────────────
  const userCountsResult = await dbRead.execute<{
    total_users: number;
    dau: number;
    wau: number;
    mau: number;
    signups_last_30d: number;
    inactive_60d: number;
  }>(sql`
    SELECT 
      COUNT(*)::int as total_users,
      COUNT(*) FILTER (WHERE last_active >= ${oneDayAgo})::int as dau,
      COUNT(*) FILTER (WHERE last_active >= ${sevenDaysAgo})::int as wau,
      COUNT(*) FILTER (WHERE last_active >= ${thirtyDaysAgo})::int as mau,
      COUNT(*) FILTER (WHERE created_at >= ${thirtyDaysAgo})::int as signups_last_30d,
      COUNT(*) FILTER (WHERE last_active < ${sixtyDaysAgo})::int as inactive_60d
    FROM users
  `);

  const userStats = userCountsResult.rows[0] ?? {
    total_users: 0,
    dau: 0,
    wau: 0,
    mau: 0,
    signups_last_30d: 0,
    inactive_60d: 0,
  };

  const totalUsers = Number(userStats.total_users ?? 0);
  const dau = Number(userStats.dau ?? 0);
  const wau = Number(userStats.wau ?? 0);
  const mau = Number(userStats.mau ?? 0);
  const signupsLast30d = Number(userStats.signups_last_30d ?? 0);
  const inactiveUsers60d = Number(userStats.inactive_60d ?? 0);

  const dauMauRatio = mau > 0 ? Number(((dau / mau) * 100).toFixed(1)) : 0;
  const wauMauRatio = mau > 0 ? Number(((wau / mau) * 100).toFixed(1)) : 0;
  const userInactivityChurnRate = totalUsers > 0 ? Number(((inactiveUsers60d / totalUsers) * 100).toFixed(1)) : 0;

  // ── 4. Trial Conversion Rate from subscriptionTransactions ─────────────────
  const trialCountsResult = await dbRead.execute<{
    trials_started: number;
    conversions: number;
    trials_expired: number;
  }>(sql`
    SELECT 
      COUNT(*) FILTER (WHERE type = 'trial_started')::int as trials_started,
      COUNT(*) FILTER (WHERE type = 'activation' OR type = 'renewal')::int as conversions,
      COUNT(*) FILTER (WHERE type = 'trial_expired')::int as trials_expired
    FROM subscription_transactions
  `);

  const trialStat = trialCountsResult.rows[0] ?? { trials_started: 0, conversions: 0, trials_expired: 0 };
  const trialsStarted = Number(trialStat.trials_started ?? 0);
  const trialsEnded = Number(trialStat.conversions ?? 0) + Number(trialStat.trials_expired ?? 0);
  const trialConversionRate =
    trialsEnded > 0
      ? Number(((Number(trialStat.conversions ?? 0) / trialsEnded) * 100).toFixed(1))
      : trialsStarted > 0
        ? 0
        : null;

  // ── 5. Time-Series Trends: Daily (30d), Monthly (12m), Yearly ───────────────

  // Daily Trend (Last 30 Days)
  const dailyResult = await dbRead.execute<{
    day: string;
    one_time_usd_cents: number;
    one_time_idr: number;
    purchases_count: number;
    new_signups: number;
    active_users: number;
  }>(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', now() - interval '29 days'),
        date_trunc('day', now()),
        interval '1 day'
      )::date AS d
    ),
    tx_agg AS (
      SELECT 
        created_at::date AS d,
        COALESCE(SUM(CASE WHEN gateway != 'xendit' THEN amount_cents ELSE 0 END), 0)::bigint AS usd_cents,
        COALESCE(SUM(CASE WHEN gateway = 'xendit' THEN amount_cents ELSE 0 END), 0)::bigint AS idr,
        COUNT(id)::int AS count
      FROM transactions
      WHERE type = 'purchase' AND created_at >= date_trunc('day', now() - interval '29 days')
      GROUP BY created_at::date
    ),
    user_signups AS (
      SELECT 
        created_at::date AS d,
        COUNT(*)::int AS count
      FROM users
      WHERE created_at >= date_trunc('day', now() - interval '29 days')
      GROUP BY created_at::date
    ),
    active_users_agg AS (
      SELECT 
        d_activity AS d,
        COUNT(DISTINCT user_id)::int AS count
      FROM (
        SELECT created_at::date AS d_activity, user_id FROM user_page_progress WHERE created_at >= date_trunc('day', now() - interval '29 days')
        UNION
        SELECT created_at::date AS d_activity, user_id FROM user_activity_logs WHERE created_at >= date_trunc('day', now() - interval '29 days')
      ) act
      GROUP BY d_activity
    )
    SELECT 
      to_char(days.d, 'YYYY-MM-DD') AS day,
      COALESCE(tx_agg.usd_cents, 0)::int AS one_time_usd_cents,
      COALESCE(tx_agg.idr, 0)::int AS one_time_idr,
      COALESCE(tx_agg.count, 0)::int AS purchases_count,
      COALESCE(user_signups.count, 0)::int AS new_signups,
      COALESCE(active_users_agg.count, 0)::int AS active_users
    FROM days
    LEFT JOIN tx_agg ON tx_agg.d = days.d
    LEFT JOIN user_signups ON user_signups.d = days.d
    LEFT JOIN active_users_agg ON active_users_agg.d = days.d
    ORDER BY days.d ASC
  `);

  const dailyTrends: RevenuePoint[] = dailyResult.rows.map((r) => {
    const oneTimeUsd = Number(((r.one_time_usd_cents ?? 0) / 100).toFixed(2));
    const oneTimeIdr = Number(r.one_time_idr ?? 0);
    const recurringUsd = Number((mrrUsd / 30).toFixed(2));
    const recurringIdr = Math.round(mrrIdr / 30);
    return {
      date: r.day,
      recurringUsd,
      recurringIdr,
      oneTimeUsd,
      oneTimeIdr,
      totalUsd: Number((recurringUsd + oneTimeUsd).toFixed(2)),
      totalIdr: recurringIdr + oneTimeIdr,
      subscribersCount: activeSubscribers,
      purchasesCount: Number(r.purchases_count ?? 0),
    };
  });

  const activityTrend = dailyResult.rows.map((r) => ({
    date: r.day,
    activeUsers: Number(r.active_users ?? 0),
    newSignups: Number(r.new_signups ?? 0),
  }));

  // Monthly Trend (Last 12 Months)
  const monthlyResult = await dbRead.execute<{
    month: string;
    one_time_usd_cents: number;
    one_time_idr: number;
    purchases_count: number;
    active_subs_count: number;
    stripe_subs: number;
    xendit_subs: number;
    new_subs: number;
    churned_subs: number;
  }>(sql`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', now() - interval '11 months'),
        date_trunc('month', now()),
        interval '1 month'
      ) AS m
    ),
    tx_monthly AS (
      SELECT 
        date_trunc('month', created_at) AS m,
        COALESCE(SUM(CASE WHEN gateway != 'xendit' THEN amount_cents ELSE 0 END), 0)::bigint AS usd_cents,
        COALESCE(SUM(CASE WHEN gateway = 'xendit' THEN amount_cents ELSE 0 END), 0)::bigint AS idr,
        COUNT(id)::int AS count
      FROM transactions
      WHERE type = 'purchase' AND created_at >= date_trunc('month', now() - interval '11 months')
      GROUP BY date_trunc('month', created_at)
    ),
    sub_monthly AS (
      SELECT 
        months.m,
        COUNT(s.id) FILTER (WHERE s.created_at <= months.m + interval '1 month - 1 millisecond' AND (s.canceled_at IS NULL OR s.canceled_at > months.m) AND s.status IN ('active', 'trialing'))::int AS active_subs_count,
        COUNT(s.id) FILTER (WHERE s.created_at <= months.m + interval '1 month - 1 millisecond' AND (s.canceled_at IS NULL OR s.canceled_at > months.m) AND s.status = 'active' AND s.gateway != 'xendit')::int AS stripe_subs,
        COUNT(s.id) FILTER (WHERE s.created_at <= months.m + interval '1 month - 1 millisecond' AND (s.canceled_at IS NULL OR s.canceled_at > months.m) AND s.status = 'active' AND s.gateway = 'xendit')::int AS xendit_subs,
        COUNT(s.id) FILTER (WHERE s.created_at >= months.m AND s.created_at < months.m + interval '1 month')::int AS new_subs,
        COUNT(s.id) FILTER (WHERE s.canceled_at >= months.m AND s.canceled_at < months.m + interval '1 month')::int AS churned_subs
      FROM months
      LEFT JOIN subscriptions s ON true
      GROUP BY months.m
    )
    SELECT 
      to_char(months.m, 'YYYY-MM') AS month,
      COALESCE(tx_monthly.usd_cents, 0)::int AS one_time_usd_cents,
      COALESCE(tx_monthly.idr, 0)::int AS one_time_idr,
      COALESCE(tx_monthly.count, 0)::int AS purchases_count,
      COALESCE(sub_monthly.active_subs_count, 0)::int AS active_subs_count,
      COALESCE(sub_monthly.stripe_subs, 0)::int AS stripe_subs,
      COALESCE(sub_monthly.xendit_subs, 0)::int AS xendit_subs,
      COALESCE(sub_monthly.new_subs, 0)::int AS new_subs,
      COALESCE(sub_monthly.churned_subs, 0)::int AS churned_subs
    FROM months
    LEFT JOIN tx_monthly ON tx_monthly.m = months.m
    LEFT JOIN sub_monthly ON sub_monthly.m = months.m
    ORDER BY months.m ASC
  `);

  const monthlyTrends: RevenuePoint[] = monthlyResult.rows.map((r) => {
    const stripeSubs = Number(r.stripe_subs ?? 0);
    const xenditSubs = Number(r.xendit_subs ?? 0);
    const recurringUsd = Number((stripeSubs * STRIPE_MONTHLY_PRICE_USD).toFixed(2));
    const recurringIdr = xenditSubs * XENDIT_MONTHLY_PRICE_IDR;
    const oneTimeUsd = Number(((r.one_time_usd_cents ?? 0) / 100).toFixed(2));
    const oneTimeIdr = Number(r.one_time_idr ?? 0);

    return {
      date: r.month,
      recurringUsd,
      recurringIdr,
      oneTimeUsd,
      oneTimeIdr,
      totalUsd: Number((recurringUsd + oneTimeUsd).toFixed(2)),
      totalIdr: recurringIdr + oneTimeIdr,
      subscribersCount: Number(r.active_subs_count ?? 0),
      purchasesCount: Number(r.purchases_count ?? 0),
    };
  });

  const churnTrend: ChurnTrendItem[] = monthlyResult.rows.map((r) => {
    const newSubs = Number(r.new_subs ?? 0);
    const churnedSubs = Number(r.churned_subs ?? 0);
    const activeAtPeriod = Number(r.active_subs_count ?? 0);
    const denom = activeAtPeriod + churnedSubs;
    const rate = denom > 0 ? Number(((churnedSubs / denom) * 100).toFixed(1)) : 0;

    return {
      period: r.month,
      newSubs,
      churnedSubs,
      netSubs: newSubs - churnedSubs,
      churnRate: rate,
    };
  });

  // Yearly Trend (By Calendar Year)
  const yearlyResult = await dbRead.execute<{
    year: string;
    one_time_usd_cents: number;
    one_time_idr: number;
    purchases_count: number;
    sub_count: number;
    stripe_subs: number;
    xendit_subs: number;
  }>(sql`
    WITH years AS (
      SELECT generate_series(
        date_trunc('year', now() - interval '3 years'),
        date_trunc('year', now()),
        interval '1 year'
      ) AS y
    ),
    tx_yearly AS (
      SELECT 
        date_trunc('year', created_at) AS y,
        COALESCE(SUM(CASE WHEN gateway != 'xendit' THEN amount_cents ELSE 0 END), 0)::bigint AS usd_cents,
        COALESCE(SUM(CASE WHEN gateway = 'xendit' THEN amount_cents ELSE 0 END), 0)::bigint AS idr,
        COUNT(id)::int AS count
      FROM transactions
      WHERE type = 'purchase'
      GROUP BY date_trunc('year', created_at)
    ),
    sub_yearly AS (
      SELECT 
        years.y,
        COUNT(s.id) FILTER (WHERE s.status IN ('active', 'trialing'))::int AS sub_count,
        COUNT(s.id) FILTER (WHERE s.status = 'active' AND s.gateway != 'xendit')::int AS stripe_subs,
        COUNT(s.id) FILTER (WHERE s.status = 'active' AND s.gateway = 'xendit')::int AS xendit_subs
      FROM years
      LEFT JOIN subscriptions s ON s.created_at <= years.y + interval '1 year - 1 millisecond'
      GROUP BY years.y
    )
    SELECT 
      to_char(years.y, 'YYYY') AS year,
      COALESCE(tx_yearly.usd_cents, 0)::int AS one_time_usd_cents,
      COALESCE(tx_yearly.idr, 0)::int AS one_time_idr,
      COALESCE(tx_yearly.count, 0)::int AS purchases_count,
      COALESCE(sub_yearly.sub_count, 0)::int AS sub_count,
      COALESCE(sub_yearly.stripe_subs, 0)::int AS stripe_subs,
      COALESCE(sub_yearly.xendit_subs, 0)::int AS xendit_subs
    FROM years
    LEFT JOIN tx_yearly ON tx_yearly.y = years.y
    LEFT JOIN sub_yearly ON sub_yearly.y = years.y
    ORDER BY years.y ASC
  `);

  const yearlyTrends: RevenuePoint[] = yearlyResult.rows.map((r) => {
    const stripeSubs = Number(r.stripe_subs ?? 0);
    const xenditSubs = Number(r.xendit_subs ?? 0);
    const recurringUsd = Number((stripeSubs * STRIPE_MONTHLY_PRICE_USD * 12).toFixed(2));
    const recurringIdr = xenditSubs * XENDIT_MONTHLY_PRICE_IDR * 12;
    const oneTimeUsd = Number(((r.one_time_usd_cents ?? 0) / 100).toFixed(2));
    const oneTimeIdr = Number(r.one_time_idr ?? 0);

    return {
      date: r.year,
      recurringUsd,
      recurringIdr,
      oneTimeUsd,
      oneTimeIdr,
      totalUsd: Number((recurringUsd + oneTimeUsd).toFixed(2)),
      totalIdr: recurringIdr + oneTimeIdr,
      subscribersCount: Number(r.sub_count ?? 0),
      purchasesCount: Number(r.purchases_count ?? 0),
    };
  });

  // ── 6. Gateway Share Percentages ────────────────────────────────────────────
  const totalTxCount = purchaseTxRows.length + activeSubscribers;
  const stripeTxCount = purchaseTxRows.filter((tx) => tx.gateway !== PAYMENT_GATEWAY.xendit).length + stripeActive;
  const xenditTxCount = purchaseTxRows.filter((tx) => tx.gateway === PAYMENT_GATEWAY.xendit).length + xenditActive;

  const stripeSharePct = totalTxCount > 0 ? Number(((stripeTxCount / totalTxCount) * 100).toFixed(1)) : 50;
  const xenditSharePct = totalTxCount > 0 ? Number(((xenditTxCount / totalTxCount) * 100).toFixed(1)) : 50;

  const totalGrossUsd = Number((arrUsd + otherIncomesTotalUsd).toFixed(2));
  const totalGrossIdr = arrIdr + otherIncomesTotalIdr;

  return {
    overview: {
      arrUsd,
      arrIdr,
      mrrUsd,
      mrrIdr,
      totalGrossUsd,
      totalGrossIdr,
      otherIncomesTotalUsd,
      otherIncomesTotalIdr,
      activeSubscribers,
      stripeSubscribers: stripeActive,
      xenditSubscribers: xenditActive,
      trialingSubscribers: trialingCount,
      pastDueSubscribers: pastDueCount,
      totalCreditPacksSold: purchaseTxRows.length,
      creditPacksSold30d,
      creditPacksRevenue30dUsd,
      creditPacksRevenue30dIdr,
    },
    engagement: {
      dau,
      wau,
      mau,
      totalUsers,
      dauMauRatio,
      wauMauRatio,
      signupsLast30d,
      inactiveUsers60d,
      activityTrend,
    },
    churn: {
      monthlyChurnRate,
      totalChurned,
      canceledLast30d,
      cancelAtPeriodEndCount,
      trialConversionRate,
      userInactivityChurnRate,
      churnTrend,
    },
    breakdowns: {
      packs: packsBreakdown,
      gateways: {
        stripeSharePct,
        xenditSharePct,
        stripeTotalUsd: Number((mrrUsd + otherIncomesTotalUsd).toFixed(2)),
        xenditTotalIdr: mrrIdr + otherIncomesTotalIdr,
      },
    },
    trends: {
      daily: dailyTrends,
      monthly: monthlyTrends,
      yearly: yearlyTrends,
    },
  };
}
