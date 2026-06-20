"use strict";

const crypto = require("crypto");
const { EVENT_TYPES, formatXlm } = require("./eventStore");

function deterministicUuid(value) {
  const hash = crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

function toIso(value) {
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

async function backfillLegacyDonationEvents(client) {
  const donations = await client.query("SELECT * FROM donations ORDER BY created_at ASC, id ASC");
  let inserted = 0;

  for (const row of donations.rows) {
    const eventId = deterministicUuid(`donation:${row.id}`);
    const occurredAt = toIso(row.created_at);

    await client.query(
      `INSERT INTO ledger_events (
         id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, payload, metadata
       )
       VALUES ($1, $2, 'donation', $3, 1, $4::timestamptz, $5::jsonb, $6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        eventId,
        EVENT_TYPES.DONATION_RECORDED,
        row.id,
        occurredAt,
        JSON.stringify({
          donationId: row.id,
          projectId: row.project_id,
          donorAddress: row.donor_address,
          amountXLM: row.amount_xlm ? formatXlm(row.amount_xlm) : null,
          amount: row.amount?.toString() || "0",
          currency: row.currency || "XLM",
          message: row.message || null,
          transactionHash: row.transaction_hash,
          createdAt: occurredAt,
          source: "legacy-backfill",
        }),
        JSON.stringify({ source: "legacy-backfill" }),
      ],
    );
    inserted += 1;
  }

  await client.query(
    `INSERT INTO ledger_projection_events (projection_name, event_sequence, applied_at)
     SELECT 'accounting_read_models', sequence, NOW()
     FROM ledger_events
     WHERE metadata->>'source' = 'legacy-backfill'
     ON CONFLICT (projection_name, event_sequence) DO NOTHING`,
  );

  return inserted;
}

async function backfillAccountBalances(client) {
  await client.query(
    `INSERT INTO account_balances (
       account_type, account_id, currency, balance, total_donated_xlm, projects_supported, donation_count, last_event_sequence, updated_at
     )
     SELECT
       'donor' AS account_type,
       donor_address AS account_id,
       'XLM' AS currency,
       -COALESCE(SUM(COALESCE(amount_xlm, 0)), 0)::numeric AS balance,
       COALESCE(SUM(COALESCE(amount_xlm, 0)), 0)::numeric AS total_donated_xlm,
       COUNT(DISTINCT project_id) AS projects_supported,
       COUNT(*) AS donation_count,
       0 AS last_event_sequence,
       NOW() AS updated_at
     FROM donations
     WHERE currency = 'XLM'
     GROUP BY donor_address
     ON CONFLICT (account_type, account_id, currency) DO UPDATE SET
       balance = EXCLUDED.balance,
       total_donated_xlm = EXCLUDED.total_donated_xlm,
       projects_supported = EXCLUDED.projects_supported,
       donation_count = EXCLUDED.donation_count,
       last_event_sequence = EXCLUDED.last_event_sequence,
       updated_at = EXCLUDED.updated_at`,
  );
}

module.exports = {
  backfillAccountBalances,
  backfillLegacyDonationEvents,
  deterministicUuid,
};
