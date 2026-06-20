"use strict";

const EVENT_TYPES = {
  DONATION_RECORDED: "DonationRecorded",
  MATCHING_DONATION_RECORDED: "MatchingDonationRecorded",
};

function mapLedgerEventRow(row) {
  return {
    id: row.id,
    type: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: Number(row.aggregate_version),
    sequence: Number(row.sequence),
    occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
    payload: row.payload || {},
    metadata: row.metadata || {},
  };
}

async function getNextAggregateVersion(client, aggregateType, aggregateId) {
  const result = await client.query(
    `SELECT COALESCE(MAX(aggregate_version), 0) AS version
     FROM ledger_events
     WHERE aggregate_type = $1 AND aggregate_id = $2`,
    [aggregateType, aggregateId],
  );

  return Number.parseInt(result.rows[0].version, 10) || 0;
}

async function appendEvent(client, event) {
  const aggregateVersion = (await getNextAggregateVersion(client, event.aggregateType, event.aggregateId)) + 1;
  const occurredAt = event.occurredAt || new Date().toISOString();
  const eventToStore = {
    ...event,
    aggregateVersion,
    occurredAt,
  };

  const result = await client.query(
    `INSERT INTO ledger_events (
       id, event_type, aggregate_type, aggregate_id, aggregate_version, occurred_at, payload, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, $8::jsonb)
     RETURNING sequence`,
    [
      eventToStore.id,
      eventToStore.type,
      eventToStore.aggregateType,
      eventToStore.aggregateId,
      eventToStore.aggregateVersion,
      eventToStore.occurredAt,
      JSON.stringify(eventToStore.payload),
      JSON.stringify(eventToStore.metadata || {}),
    ],
  );

  return {
    ...eventToStore,
    sequence: Number(result.rows[0].sequence),
  };
}

async function findEventByTransactionHash(client, transactionHash) {
  const result = await client.query(
    `SELECT *
     FROM ledger_events
     WHERE payload->>'transactionHash' = $1
     ORDER BY sequence
     LIMIT 1`,
    [transactionHash],
  );

  return result.rows[0] ? mapLedgerEventRow(result.rows[0]) : null;
}

async function loadEventsForAggregate(client, aggregateType, aggregateId, asOf) {
  const values = [aggregateType, aggregateId];
  const asOfClause = asOf ? "AND occurred_at <= $3::timestamptz" : "";
  if (asOf) values.push(asOf);

  const result = await client.query(
    `SELECT *
     FROM ledger_events
     WHERE aggregate_type = $1
       AND aggregate_id = $2
       ${asOfClause}
     ORDER BY aggregate_version ASC, sequence ASC`,
    values,
  );

  return result.rows.map(mapLedgerEventRow);
}

function formatXlm(value) {
  const amount = Number.parseFloat(value || "0");
  return Number.isFinite(amount) ? amount.toFixed(7) : "0.0000000";
}

async function getAccountStateAt(client, aggregateType, accountId, asOf, accountTypeLabel = aggregateType) {
  const values = [aggregateType, accountId, EVENT_TYPES.DONATION_RECORDED, EVENT_TYPES.MATCHING_DONATION_RECORDED];
  const asOfClause = asOf ? "AND occurred_at <= $5::timestamptz" : "";
  if (asOf) values.push(asOf);

  const result = await client.query(
    `SELECT *
     FROM ledger_events
     WHERE aggregate_type = $1
       AND payload->>'donorAddress' = $2
       AND event_type IN ($3, $4)
       ${asOfClause}
     ORDER BY sequence ASC`,
    values,
  );

  const projects = new Set();
  const donations = [];
  let balanceXLM = 0;
  let totalDonatedXLM = 0;

  for (const event of result.rows.map(mapLedgerEventRow)) {
    const amount = Number.parseFloat(event.payload.amountXLM || "0");
    if (!Number.isFinite(amount)) continue;

    if (event.payload.currency === "XLM" && event.payload.amountXLM !== null && event.payload.amountXLM !== undefined) {
      balanceXLM -= amount;
      totalDonatedXLM += amount;
      projects.add(event.payload.projectId);
      donations.push({
        id: event.payload.donationId,
        eventType: event.type,
        transactionHash: event.payload.transactionHash,
        amountXLM: formatXlm(amount),
        createdAt: event.payload.createdAt ? new Date(event.payload.createdAt).toISOString() : event.occurredAt,
        sequence: event.sequence,
      });
    }
  }

  return {
    accountType: accountTypeLabel,
    accountId,
    asOf: asOf ? new Date(asOf).toISOString() : null,
    balanceXLM: formatXlm(balanceXLM),
    totalDonatedXLM: formatXlm(totalDonatedXLM),
    projectsSupported: projects.size,
    donationCount: donations.length,
    donations,
  };
}

module.exports = {
  EVENT_TYPES,
  appendEvent,
  findEventByTransactionHash,
  formatXlm,
  getAccountStateAt,
  loadEventsForAggregate,
  mapLedgerEventRow,
};
