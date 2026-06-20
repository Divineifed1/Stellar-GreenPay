"use strict";

const { computeBadges } = require("../store");
const { EVENT_TYPES, formatXlm } = require("./eventStore");

const ACCOUNTING_PROJECTION = "accounting_read_models";

function numeric(value, fallback = 0) {
  const parsed = Number.parseFloat(value || fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function donationPayload(event) {
  return {
    donationId: event.payload.donationId,
    projectId: event.payload.projectId,
    donorAddress: event.payload.donorAddress,
    amountXLM: event.payload.amountXLM,
    amount: event.payload.amount,
    currency: event.payload.currency,
    message: event.payload.message || null,
    transactionHash: event.payload.transactionHash,
    createdAt: event.payload.createdAt || event.occurredAt,
  };
}

function xlmAmount(payload) {
  if (payload.currency !== "XLM" || payload.amountXLM === null || payload.amountXLM === undefined) {
    return 0;
  }

  return numeric(payload.amountXLM);
}

async function eventAlreadyApplied(client, eventSequence) {
  const result = await client.query(
    `SELECT 1
     FROM ledger_projection_events
     WHERE projection_name = $1 AND event_sequence = $2`,
    [ACCOUNTING_PROJECTION, eventSequence],
  );

  return result.rows.length > 0;
}

async function markEventApplied(client, eventSequence) {
  await client.query(
    `INSERT INTO ledger_projection_events (projection_name, event_sequence, applied_at)
     VALUES ($1, $2, NOW())`,
    [ACCOUNTING_PROJECTION, eventSequence],
  );
}

async function insertDonationRow(client, payload) {
  await client.query(
    `INSERT INTO donations (
       id, project_id, donor_address, amount_xlm, amount, currency, message, transaction_hash, created_at
     )
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8, $9::timestamptz)
     ON CONFLICT (transaction_hash) DO NOTHING`,
    [
      payload.donationId,
      payload.projectId,
      payload.donorAddress,
      payload.amountXLM,
      payload.amount,
      payload.currency,
      payload.message,
      payload.transactionHash,
      payload.createdAt,
    ],
  );
}

async function updateProjectTotals(client, projectId, amountXLM) {
  await client.query(
    `UPDATE projects
     SET raised_xlm = raised_xlm + $1::numeric,
         donor_count = (
           SELECT COUNT(DISTINCT donor_address)
           FROM donations
           WHERE project_id = $2
         ),
         updated_at = NOW()
     WHERE id = $2`,
    [formatXlm(amountXLM), projectId],
  );
}

async function updateDonorProfile(client, donorAddress, amountXLM) {
  const existingProfileResult = await client.query(
    `SELECT public_key, display_name, bio, total_donated_xlm
     FROM profiles
     WHERE public_key = $1`,
    [donorAddress],
  );
  const existingProfile = existingProfileResult.rows[0];
  const previousTotal = existingProfile ? numeric(existingProfile.total_donated_xlm) : 0;
  const projectsSupportedResult = await client.query(
    `SELECT COUNT(DISTINCT project_id) AS count
     FROM donations
     WHERE donor_address = $1`,
    [donorAddress],
  );
  const projectsSupported = Number.parseInt(projectsSupportedResult.rows[0].count, 10) || 0;
  const newTotal = previousTotal + amountXLM;

  await client.query(
    `INSERT INTO profiles (
       public_key, display_name, bio, total_donated_xlm, projects_supported, badges, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4::numeric, $5, $6::jsonb, NOW(), NOW())
     ON CONFLICT (public_key) DO UPDATE SET
       total_donated_xlm = EXCLUDED.total_donated_xlm,
       projects_supported = EXCLUDED.projects_supported,
       badges = EXCLUDED.badges,
       updated_at = EXCLUDED.updated_at`,
    [
      donorAddress,
      existingProfile?.display_name || null,
      existingProfile?.bio || null,
      formatXlm(newTotal),
      projectsSupported,
      JSON.stringify(computeBadges(newTotal)),
    ],
  );
}

async function upsertAccountBalance(client, donorAddress, amountXLM, eventSequence) {
  const projectsSupportedResult = await client.query(
    `SELECT COUNT(DISTINCT project_id) AS count
     FROM donations
     WHERE donor_address = $1`,
    [donorAddress],
  );
  const projectsSupported = Number.parseInt(projectsSupportedResult.rows[0].count, 10) || 0;
  const donationCount = amountXLM === 0 ? 0 : 1;

  await client.query(
    `INSERT INTO account_balances (
       account_type, account_id, currency, balance, total_donated_xlm, projects_supported, donation_count, last_event_sequence, updated_at
     )
     VALUES ('donor', $1, 'XLM', $2::numeric, $3::numeric, $4, $5, $6, NOW())
     ON CONFLICT (account_type, account_id, currency) DO UPDATE SET
       balance = account_balances.balance + EXCLUDED.balance,
       total_donated_xlm = account_balances.total_donated_xlm + EXCLUDED.total_donated_xlm,
       projects_supported = EXCLUDED.projects_supported,
       donation_count = account_balances.donation_count + EXCLUDED.donation_count,
       last_event_sequence = EXCLUDED.last_event_sequence,
       updated_at = EXCLUDED.updated_at`,
    [donorAddress, formatXlm(-amountXLM), formatXlm(amountXLM), projectsSupported, donationCount, eventSequence],
  );
}

async function applyDonationRecorded(client, event) {
  const payload = donationPayload(event);
  const amountXLM = xlmAmount(payload);

  await insertDonationRow(client, payload);
  await updateProjectTotals(client, payload.projectId, amountXLM);
  await updateDonorProfile(client, payload.donorAddress, amountXLM);
  await upsertAccountBalance(client, payload.donorAddress, amountXLM, event.sequence);
}

async function applyMatchingDonationRecorded(client, event) {
  const payload = donationPayload(event);
  const amountXLM = xlmAmount(payload);

  await insertDonationRow(client, payload);
  await client.query(
    `UPDATE donation_matches
     SET matched_xlm = matched_xlm + $1::numeric
     WHERE id = $2`,
    [formatXlm(amountXLM), payload.matchId],
  );
  await updateProjectTotals(client, payload.projectId, amountXLM);
  await upsertAccountBalance(client, payload.donorAddress, amountXLM, event.sequence);
}

async function applyAccountingEvent(client, event) {
  if (await eventAlreadyApplied(client, event.sequence)) {
    return;
  }

  if (event.type === EVENT_TYPES.DONATION_RECORDED) {
    await applyDonationRecorded(client, event);
  } else if (event.type === EVENT_TYPES.MATCHING_DONATION_RECORDED) {
    await applyMatchingDonationRecorded(client, event);
  } else {
    throw new Error(`Unsupported accounting event type: ${event.type}`);
  }

  await markEventApplied(client, event.sequence);
}

module.exports = {
  ACCOUNTING_PROJECTION,
  applyAccountingEvent,
  applyDonationRecorded,
  applyMatchingDonationRecorded,
  donationPayload,
};
